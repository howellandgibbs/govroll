import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/rate-limit";

// bill-summary owns the DB/AI side effects — mock it so we can assert exactly
// when (and whether) the route reaches for paid generation. The rate-limit
// module is intentionally NOT mocked: the per-IP limiter is real here so the
// "over-limit POST does not trigger generation" test exercises the actual
// guard rather than a stub.
const readSummaryStateMock = vi.fn();
const ensureSummaryJobMock = vi.fn();
const generateSummaryForVersionMock = vi.fn();
const assertOndemandSummaryDailyCapMock = vi.fn();
const afterMock = vi.fn();

vi.mock("@/lib/bill-summary", () => ({
  readSummaryState: readSummaryStateMock,
  ensureSummaryJob: ensureSummaryJobMock,
  generateSummaryForVersion: generateSummaryForVersionMock,
  assertOndemandSummaryDailyCap: assertOndemandSummaryDailyCapMock,
}));

// Keep the real NextResponse; only intercept `after` so the fire-and-forget
// generation handle is observable instead of actually scheduled.
vi.mock("next/server", async (importActual) => {
  const actual = await importActual<typeof import("next/server")>();
  return { ...actual, after: afterMock };
});

const { POST, GET } = await import("./route");

const VERSION_META = {
  versionCode: "IH",
  versionType: "Introduced",
  versionDate: "2026-01-01T00:00:00.000Z",
};
const NOT_GENERATED = { status: "not_generated", ...VERSION_META } as const;
const PENDING = {
  status: "pending",
  ...VERSION_META,
  startedAt: "2026-01-01T00:00:00.000Z",
} as const;
const READY = {
  status: "ready",
  summary: "It does things.",
  ...VERSION_META,
} as const;

// Each test uses a distinct IP so the module-level per-IP counter (which
// vi.clearAllMocks does not reset) stays isolated between cases.
function makeRequest(ip: string, method = "POST"): Request {
  return new Request("http://localhost/api/bills/1/summary", {
    method,
    headers: { "x-forwarded-for": ip },
  });
}
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: daily cap not exceeded. Individual tests override.
  assertOndemandSummaryDailyCapMock.mockResolvedValue(undefined);
});

describe("GET /api/bills/[id]/summary (read-only)", () => {
  it("returns the current state without ever triggering generation", async () => {
    readSummaryStateMock.mockResolvedValue(NOT_GENERATED);

    const res = await GET(makeRequest("get-1", "GET"), makeParams("1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NOT_GENERATED);
    expect(ensureSummaryJobMock).not.toHaveBeenCalled();
    expect(generateSummaryForVersionMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric bill id and reads nothing", async () => {
    const res = await GET(
      makeRequest("get-2", "GET"),
      makeParams("not-a-number"),
    );

    expect(res.status).toBe(400);
    expect(readSummaryStateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/bills/[id]/summary", () => {
  it("triggers generation exactly once when no summary exists yet", async () => {
    readSummaryStateMock.mockResolvedValue(NOT_GENERATED);
    ensureSummaryJobMock.mockResolvedValue({
      started: true,
      versionId: 7,
      state: PENDING,
    });

    const res = await POST(makeRequest("trigger-1"), makeParams("1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PENDING);
    expect(ensureSummaryJobMock).toHaveBeenCalledWith(1);
    expect(generateSummaryForVersionMock).toHaveBeenCalledWith(7);
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("on Cloud Run, generates inside the request and returns the finished state", async () => {
    vi.stubEnv("K_SERVICE", "govroll");
    try {
      readSummaryStateMock
        .mockResolvedValueOnce(NOT_GENERATED)
        .mockResolvedValueOnce(READY);
      ensureSummaryJobMock.mockResolvedValue({
        started: true,
        versionId: 7,
        state: PENDING,
      });
      generateSummaryForVersionMock.mockResolvedValue(undefined);

      const res = await POST(makeRequest("cloud-run-1"), makeParams("1"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(READY);
      expect(generateSummaryForVersionMock).toHaveBeenCalledWith(7);
      expect(afterMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not re-trigger generation for a poll of an already-ready summary", async () => {
    readSummaryStateMock.mockResolvedValue(READY);

    const res = await POST(makeRequest("poll-ready"), makeParams("1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(READY);
    expect(ensureSummaryJobMock).not.toHaveBeenCalled();
    expect(generateSummaryForVersionMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
    // A poll must not consume the daily-cap budget either.
    expect(assertOndemandSummaryDailyCapMock).not.toHaveBeenCalled();
  });

  it("does not trigger generation once the per-IP limit is exceeded", async () => {
    readSummaryStateMock.mockResolvedValue(NOT_GENERATED);
    ensureSummaryJobMock.mockResolvedValue({
      started: true,
      versionId: 7,
      state: PENDING,
    });

    const ip = "flooder";
    // The route allows 30 generation triggers per IP per hour.
    for (let i = 0; i < 30; i++) {
      const ok = await POST(makeRequest(ip), makeParams("1"));
      expect(ok.status).toBe(200);
    }

    const blocked = await POST(makeRequest(ip), makeParams("1"));

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "rate_limited" });
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    // The 31st request must not have reached generation — only the first 30 did.
    expect(ensureSummaryJobMock).toHaveBeenCalledTimes(30);
    expect(generateSummaryForVersionMock).toHaveBeenCalledTimes(30);
    expect(afterMock).toHaveBeenCalledTimes(30);
  });

  it("does not trigger generation once the global daily cap is hit", async () => {
    readSummaryStateMock.mockResolvedValue(NOT_GENERATED);
    assertOndemandSummaryDailyCapMock.mockRejectedValue(
      new RateLimitError("on-demand bill summaries per day", 3600),
    );

    const res = await POST(makeRequest("cap-1"), makeParams("1"));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(ensureSummaryJobMock).not.toHaveBeenCalled();
    expect(generateSummaryForVersionMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric bill id and reads nothing", async () => {
    const res = await POST(makeRequest("bad-id"), makeParams("abc"));

    expect(res.status).toBe(400);
    expect(readSummaryStateMock).not.toHaveBeenCalled();
    expect(ensureSummaryJobMock).not.toHaveBeenCalled();
  });
});
