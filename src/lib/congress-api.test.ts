import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { AxiosError } from "axios";
import {
  fetchAllTextVersions,
  fetchBillActions,
  fetchBillCosponsors,
  fetchBillMetadata,
  fetchOfficialBillTitle,
  isQuotaError,
  isTransientCongressError,
  withRetry,
} from "./congress-api";

// A 429 with a long Retry-After makes withRetry bail immediately (the server
// asked for longer than we'll hold the function open), keeping these tests fast
// while still exercising the quota path.
const tooManyRequests = () =>
  new HttpResponse(null, {
    status: 429,
    headers: { "Retry-After": "3600" },
  });

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("fetchAllTextVersions", () => {
  it("returns versions sorted oldest-first", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/1/text", () =>
        HttpResponse.json({
          textVersions: [
            { date: "2026-03-01", type: "Engrossed", formats: [] },
            { date: "2026-01-15", type: "Introduced", formats: [] },
            { date: "2026-02-10", type: "Reported", formats: [] },
          ],
        }),
      ),
    );

    const versions = await fetchAllTextVersions(119, "hr", 1);

    expect(versions.map((v) => v.date)).toEqual([
      "2026-01-15",
      "2026-02-10",
      "2026-03-01",
    ]);
  });

  it("returns empty array when API returns no textVersions", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/1/text", () =>
        HttpResponse.json({}),
      ),
    );

    const versions = await fetchAllTextVersions(119, "hr", 1);
    expect(versions).toEqual([]);
  });

  it("returns empty array on server error (does not throw)", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/1/text",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const versions = await fetchAllTextVersions(119, "hr", 1);
    expect(versions).toEqual([]);
  });
});

describe("fetchBillActions", () => {
  it("maps Senate/House chamber from sourceSystem.name", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/1/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-04-10",
              text: "Passed Senate",
              type: "Floor",
              sourceSystem: { name: "Senate" },
            },
            {
              actionDate: "2026-04-05",
              text: "Reported by House Committee",
              type: "Committee",
              sourceSystem: { name: "House floor actions" },
            },
            {
              actionDate: "2026-04-01",
              text: "Referred to committee",
              type: "IntroReferral",
              sourceSystem: { name: "Library of Congress" },
            },
          ],
        }),
      ),
    );

    const actions = await fetchBillActions(119, "hr", 1);

    expect(actions).not.toBeNull();
    expect(actions).toHaveLength(3);
    expect(actions![0].chamber).toBe("Senate");
    expect(actions![1].chamber).toBe("House");
    expect(actions![2].chamber).toBeNull();
  });

  it("returns null when API response shape is malformed", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/1/actions", () =>
        HttpResponse.json({ actions: "not-an-array" }),
      ),
    );

    const actions = await fetchBillActions(119, "hr", 1);
    expect(actions).toBeNull();
  });
});

describe("fetchBillActions pagination", () => {
  it("follows pagination.next until all actions are fetched", async () => {
    // Congress.gov caps each response at 250. A high-activity bill (NDAA,
    // appropriations) can have 400+ actions across its lifecycle. Without
    // pagination we silently store only the first 250.
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/999/actions",
        ({ request }) => {
          const url = new URL(request.url);
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          if (offset === 0) {
            return HttpResponse.json({
              actions: Array.from({ length: 250 }, (_, i) => ({
                actionDate: "2026-04-01",
                text: `action-${i}`,
                type: "Floor",
                sourceSystem: { name: "House" },
              })),
              pagination: {
                count: 270,
                next: "https://api.congress.gov/v3/bill/119/hr/999/actions?offset=250&limit=250",
              },
            });
          }
          return HttpResponse.json({
            actions: Array.from({ length: 20 }, (_, i) => ({
              actionDate: "2026-04-01",
              text: `action-${250 + i}`,
              type: "Floor",
              sourceSystem: { name: "House" },
            })),
            pagination: { count: 270 },
          });
        },
      ),
    );

    const actions = await fetchBillActions(119, "hr", 999);
    expect(actions).not.toBeNull();
    expect(actions).toHaveLength(270);
    expect(actions![0].text).toBe("action-0");
    expect(actions![269].text).toBe("action-269");
  });

  it("stops early when a page returns fewer than limit rows", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/500/actions", () =>
        HttpResponse.json({
          actions: [
            {
              actionDate: "2026-04-01",
              text: "only-one",
              type: "Floor",
              sourceSystem: { name: "House" },
            },
          ],
        }),
      ),
    );

    const actions = await fetchBillActions(119, "hr", 500);
    expect(actions).toHaveLength(1);
  });
});

describe("fetchBillCosponsors pagination", () => {
  it("follows pagination.next past 250", async () => {
    // H.R. 82 (118th) reports 330 cosponsors but we stored 209 pre-fix —
    // the tail was silently lost at the 250 ceiling. Pagination must fetch all.
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/118/hr/82/cosponsors",
        ({ request }) => {
          const url = new URL(request.url);
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          if (offset === 0) {
            return HttpResponse.json({
              cosponsors: Array.from({ length: 250 }, (_, i) => ({
                bioguideId: `P${String(i).padStart(6, "0")}`,
                firstName: "First",
                lastName: `Last${i}`,
                party: i % 2 === 0 ? "D" : "R",
                state: "CA",
                district: 1,
                sponsorshipDate: "2024-01-15",
                isOriginalCosponsor: false,
              })),
              pagination: {
                count: 330,
                next: "https://api.congress.gov/v3/bill/118/hr/82/cosponsors?offset=250&limit=250",
              },
            });
          }
          return HttpResponse.json({
            cosponsors: Array.from({ length: 80 }, (_, i) => ({
              bioguideId: `P${String(250 + i).padStart(6, "0")}`,
              firstName: "First",
              lastName: `Last${250 + i}`,
              party: "R",
              state: "TX",
              district: 2,
              sponsorshipDate: "2024-02-20",
              isOriginalCosponsor: false,
            })),
            pagination: { count: 330 },
          });
        },
      ),
    );

    const cosponsors = await fetchBillCosponsors(118, "hr", 82);
    expect(cosponsors).toHaveLength(330);
    expect(cosponsors[0].bioguideId).toBe("P000000");
    expect(cosponsors[329].bioguideId).toBe("P000329");
  });

  it("handles a small bill that fits in one page", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/s/1884/cosponsors", () =>
        HttpResponse.json({
          cosponsors: [
            {
              bioguideId: "C001000",
              firstName: "John",
              lastName: "Cornyn",
              party: "R",
              state: "TX",
              sponsorshipDate: "2025-05-22",
              isOriginalCosponsor: true,
            },
          ],
          pagination: { count: 1 },
        }),
      ),
    );

    const cosponsors = await fetchBillCosponsors(119, "s", 1884);
    expect(cosponsors).toHaveLength(1);
    expect(cosponsors[0].isOriginalCosponsor).toBe(true);
  });

  it("returns partial data if a later page fails (does not throw)", async () => {
    let call = 0;
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/77/cosponsors",
        ({ request }) => {
          call++;
          const url = new URL(request.url);
          const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
          if (offset === 0 && call === 1) {
            return HttpResponse.json({
              cosponsors: Array.from({ length: 250 }, (_, i) => ({
                bioguideId: `X${String(i).padStart(6, "0")}`,
                isOriginalCosponsor: false,
              })),
              pagination: {
                count: 400,
                next: "https://api.congress.gov/v3/bill/119/hr/77/cosponsors?offset=250&limit=250",
              },
            });
          }
          return new HttpResponse(null, { status: 500 });
        },
      ),
    );

    const cosponsors = await fetchBillCosponsors(119, "hr", 77);
    // Should still return the first 250 we successfully fetched.
    expect(cosponsors.length).toBeGreaterThanOrEqual(250);
  });
});

describe("fetchOfficialBillTitle", () => {
  it("returns the bill title when present", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/s/42", () =>
        HttpResponse.json({
          bill: { title: "A bill to improve civic engagement." },
        }),
      ),
    );

    const title = await fetchOfficialBillTitle(119, "s", 42);
    expect(title).toBe("A bill to improve civic engagement.");
  });

  it("returns null when title is missing", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/s/42", () =>
        HttpResponse.json({ bill: {} }),
      ),
    );

    const title = await fetchOfficialBillTitle(119, "s", 42);
    expect(title).toBeNull();
  });
});

describe("isQuotaError", () => {
  it("is true for a real 429 axios rejection", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/1/text",
        tooManyRequests,
      ),
    );
    let caught: unknown;
    try {
      await fetchAllTextVersions(119, "hr", 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isQuotaError(caught)).toBe(true);
  });

  it("is false for non-429 errors and non-error values", () => {
    expect(isQuotaError(new Error("boom"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError("nope")).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("isTransientCongressError", () => {
  // Only `status` is read; build a minimal axios rejection for each code.
  const withStatus = (status: number): AxiosError => {
    const err = new AxiosError("upstream", "ERR_BAD_RESPONSE");
    err.response = {
      status,
      statusText: "",
      data: null,
      headers: {},
      config: {} as never,
    };
    return err;
  };

  it("is true for 429 (quota)", () => {
    expect(isTransientCongressError(withStatus(429))).toBe(true);
  });

  it("is true for any 5xx, including Cloudflare 520-526", () => {
    for (const status of [500, 502, 503, 504, 520, 522, 524]) {
      expect(isTransientCongressError(withStatus(status))).toBe(true);
    }
  });

  it("is true for a network drop (axios error with no HTTP response)", () => {
    const netErr = new AxiosError("socket hang up", "ECONNRESET");
    expect(netErr.response).toBeUndefined();
    expect(isTransientCongressError(netErr)).toBe(true);
  });

  it("is false for a non-429 4xx — a real, non-self-healing failure", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(isTransientCongressError(withStatus(status))).toBe(false);
    }
  });

  it("is false for non-axios errors and non-error values (real bugs surface)", () => {
    expect(isTransientCongressError(new Error("bug"))).toBe(false);
    expect(isTransientCongressError(null)).toBe(false);
    expect(isTransientCongressError("nope")).toBe(false);
    expect(isTransientCongressError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  const refused = () => {
    const err = new AxiosError("refused", "ERR_BAD_REQUEST");
    err.response = {
      status: 403,
      statusText: "",
      data: null,
      headers: {},
      config: {} as never,
    };
    return err;
  };

  it("throws at once when shouldRetry rejects the error", async () => {
    // A WAF 403 is an answer: asking again just repeats it.
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(refused());
    };
    await expect(withRetry(fn, 2, 1, isTransientCongressError)).rejects.toThrow(
      "refused",
    );
    expect(calls).toBe(1);
  });

  it("retries everything by default", async () => {
    let calls = 0;
    const fn = () =>
      ++calls < 3 ? Promise.reject(refused()) : Promise.resolve("ok");
    await expect(withRetry(fn, 2, 1)).resolves.toBe("ok");
    expect(calls).toBe(3);
  });
});

describe("429 quota is surfaced, not laundered into empty results", () => {
  // The bug this guards: a 429 used to be caught and converted to []/null,
  // indistinguishable from "no data exists" — callers then recorded a false
  // "attempt" and cooled the bill down for days. These wrappers must now
  // THROW on 429 so the cron route can fail loudly instead.
  it("fetchAllTextVersions throws on 429 instead of returning []", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/2/text",
        tooManyRequests,
      ),
    );
    await expect(fetchAllTextVersions(119, "hr", 2)).rejects.toThrow();
  });

  it("fetchBillActions throws on 429 instead of returning null", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/3/actions",
        tooManyRequests,
      ),
    );
    await expect(fetchBillActions(119, "hr", 3)).rejects.toThrow();
  });

  it("fetchBillCosponsors throws on 429 instead of returning []", async () => {
    server.use(
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/4/cosponsors",
        tooManyRequests,
      ),
    );
    await expect(fetchBillCosponsors(119, "hr", 4)).rejects.toThrow();
  });

  it("fetchOfficialBillTitle throws on 429 instead of returning null", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/5", tooManyRequests),
    );
    await expect(fetchOfficialBillTitle(119, "hr", 5)).rejects.toThrow();
  });

  it("fetchBillMetadata throws on 429 instead of returning null", async () => {
    // The primary /bill call rejects with 429; metadata must propagate it.
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/6", tooManyRequests),
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/6/cosponsors",
        tooManyRequests,
      ),
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/6/summaries",
        tooManyRequests,
      ),
      http.get(
        "https://api.congress.gov/v3/bill/119/hr/6/titles",
        tooManyRequests,
      ),
    );
    await expect(fetchBillMetadata(119, "hr", 6)).rejects.toThrow();
  });

  it("still returns [] for a genuine empty result (real 'no data' is not laundered into an error)", async () => {
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hr/7/text", () =>
        HttpResponse.json({}),
      ),
    );
    await expect(fetchAllTextVersions(119, "hr", 7)).resolves.toEqual([]);
  });
});
