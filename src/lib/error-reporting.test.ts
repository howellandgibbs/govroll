import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The alert budget must be split per-source so that untrusted, unauthenticated
 * client reports (POST /api/errors/report) cannot exhaust the budget that
 * genuine server-side alerts (cron failures, API errors) depend on.
 *
 * reportError reads its config + module state lazily, but the rate-limit
 * buckets are module-level — so each test re-imports the module fresh
 * (resetModules) to start from a clean budget. Distinct messages dodge the
 * 5-minute dedup window, isolating the rate-limit behavior under test.
 */
describe("reportError per-source alert budgets", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("ALERT_EMAIL", "alerts@example.com");
    // reportError POSTs to Resend on each allowed alert; count the calls.
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("caps client-reported errors at the (small) client budget", async () => {
    const { reportError } = await import("./error-reporting");
    for (let i = 0; i < 8; i++) {
      await reportError(new Error(`client error ${i}`), { source: "client" });
    }
    // Client budget is 3/hr — the other 5 are dropped.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives server alerts their own (larger) budget", async () => {
    const { reportError } = await import("./error-reporting");
    for (let i = 0; i < 14; i++) {
      await reportError(new Error(`server error ${i}`), { context: "cron" });
    }
    // Server budget is 10/hr.
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("a client flood cannot consume the server alert budget", async () => {
    const { reportError } = await import("./error-reporting");

    // Attacker floods the unauthenticated client endpoint.
    for (let i = 0; i < 30; i++) {
      await reportError(new Error(`client flood ${i}`), { source: "client" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3); // client capped

    // The server budget is fully intact afterward.
    for (let i = 0; i < 10; i++) {
      await reportError(new Error(`genuine server error ${i}`), {
        context: "fetch-votes cron",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3 + 10);
  });

  it("treats reports with no source as server alerts (default bucket)", async () => {
    const { reportError } = await import("./error-reporting");
    for (let i = 0; i < 14; i++) {
      await reportError(new Error(`unsourced ${i}`));
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("still deduplicates identical messages within the window", async () => {
    const { reportError } = await import("./error-reporting");
    for (let i = 0; i < 5; i++) {
      await reportError(new Error("the exact same error"), { context: "cron" });
    }
    // Dedup collapses them to a single alert despite the 10/hr budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The ingest-health watchdog's multi-line breach summary used to go out
 * verbatim as the subject; Resend rejected it and, with no res.ok check, the
 * stall alarm paged into nothing for days (fetch-votes, Oct 2026).
 */
describe("alertSubject", () => {
  it("collapses a multi-line message onto one header line", async () => {
    const { alertSubject } = await import("./error-reporting");
    const subject = alertSubject(
      "Ingest pipeline(s) stalled:\n- fetch-votes: cursor hasn't advanced\r\n- fetch-bills: x",
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe(
      "[Govroll] Ingest pipeline(s) stalled: - fetch-votes: cursor hasn't advanced - fetch-bills: x",
    );
  });

  it("caps the message at 100 characters", async () => {
    const { alertSubject } = await import("./error-reporting");
    expect(alertSubject("a".repeat(300))).toBe(`[Govroll] ${"a".repeat(100)}`);
  });
});

describe("reportError delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("ALERT_EMAIL", "alerts@example.com");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends a single-line subject and keeps the full message in the body", async () => {
    const { reportError } = await import("./error-reporting");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await reportError(new Error("stalled:\n- fetch-votes: 83.7h"));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toBe("[Govroll] stalled: - fetch-votes: 83.7h");
    expect(body.text).toContain("stalled:\n- fetch-votes: 83.7h");
  });

  it("logs a rejected send instead of swallowing it", async () => {
    const { reportError } = await import("./error-reporting");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      new Response('{"name":"validation_error"}', { status: 422 }),
    );
    await reportError(new Error("rejected send"));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 422"));
    errorSpy.mockRestore();
  });
});
