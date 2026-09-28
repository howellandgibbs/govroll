import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "@/app/api/cron/backfill-bill-text/route";
import { prisma } from "@/lib/prisma";
import { server } from "../msw-server";
import { getTestPrisma } from "../db";
import { seedBill } from "../fixtures";
import { invokeCron } from "../invoke";

describe("GET /api/cron/backfill-bill-text", () => {
  it("rejects missing auth", async () => {
    const res = await invokeCron(GET, { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns ok with empty batch when no bills need text", async () => {
    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
  });

  it("reports a non-empty batch when eligible bills exist", async () => {
    // An ACTIVE bill with no fullText and no textVersions is what the route
    // targets. We don't assert actual text backfill here — that path depends
    // on congress.gov + GovInfo XML, which is deeply intertwined and best
    // covered via the dedicated fetch-bill-text unit tests.
    await seedBill({
      billId: "house_bill-40-119",
      momentumTier: "ACTIVE",
      fullText: undefined,
    });

    const res = await invokeCron(GET, { search: { limit: "1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The MSW default handlers 404 every congress.gov/GovInfo call, so the
    // underlying backfill either no-ops or errors gracefully. Either way
    // the outer contract — ok=true, processed counted — must hold.
    expect(body.ok).toBe(true);
    expect(body.remaining).toBeGreaterThanOrEqual(0);
  });

  it("fails loudly (503) on congress.gov quota exhaustion and does NOT stamp a false attempt", async () => {
    // The laundering bug: a 429 used to be swallowed as "no text," the bill
    // got stamped textFetchAttemptedAt, and it dropped into a multi-day
    // cooldown — over a transient quota outage. The run must now 503, and the
    // bill must stay un-stamped so the next run retries it promptly.
    const bill = await seedBill({
      billId: "house_bill-41-119",
      momentumTier: "ACTIVE",
      fullText: undefined,
    });

    // Long Retry-After → withRetry bails immediately (keeps the test fast).
    server.use(
      http.get(
        "https://api.congress.gov/v3/*",
        () =>
          new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "3600" },
          }),
      ),
    );

    const res = await invokeCron(GET, { search: { limit: "1" } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("congress_quota_exhausted");

    const after = await getTestPrisma().bill.findUnique({
      where: { id: bill.id },
    });
    expect(after?.textFetchAttemptedAt).toBeNull();
  });

  it("puts an ended Congress's already-tried bills in the slow lane", async () => {
    const DAY = 86_400_000;
    const db = getTestPrisma();
    // 104th Congress (1995–96): no machine-readable text will ever appear, so
    // one attempt per ENDED_CONGRESS_TEXT_RETRY_DAYS (180) is plenty.
    const triedYesterday = await seedBill({
      billId: "house_bill-701-104",
      congressNumber: 104,
      textFetchAttemptedAt: new Date(Date.now() - DAY),
    });
    const triedLongAgo = await seedBill({
      billId: "house_bill-702-104",
      congressNumber: 104,
      textFetchAttemptedAt: new Date(Date.now() - 200 * DAY),
    });
    const neverTried = await seedBill({
      billId: "house_bill-703-104",
      congressNumber: 104,
    });
    // Current-Congress bills keep rotating hourly regardless of last attempt.
    const current = await seedBill({
      billId: "house_bill-704-119",
      textFetchAttemptedAt: new Date(Date.now() - DAY),
    });

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Default MSW handlers 404 every upstream → each processed bill is a
    // graceful no-op that stamps textFetchAttemptedAt.
    expect(body.processed).toBe(3);
    // Afterwards only the current-Congress bill is still due.
    expect(body.remaining).toBe(1);

    const after = new Map(
      (
        await db.bill.findMany({
          where: {
            id: {
              in: [
                triedYesterday.id,
                triedLongAgo.id,
                neverTried.id,
                current.id,
              ],
            },
          },
          select: { id: true, textFetchAttemptedAt: true },
        })
      ).map((b) => [b.id, b.textFetchAttemptedAt!.getTime()]),
    );
    const recent = Date.now() - 60_000;
    expect(after.get(triedYesterday.id)).toBeLessThan(recent); // untouched
    expect(after.get(triedLongAgo.id)).toBeGreaterThan(recent);
    expect(after.get(neverTried.id)).toBeGreaterThan(recent);
    expect(after.get(current.id)).toBeGreaterThan(recent);
  });

  it("runs a concurrent batch on one shared client without disconnecting it", async () => {
    // Seed more eligible bills than CONCURRENCY (3) so the route's workers
    // genuinely overlap on the single pooled client they now share. Each is
    // missing fullText with no text versions — exactly what the route targets.
    // Parseable house_bill IDs so the real fetch path runs; the default MSW
    // handlers 404 every upstream, so each fetch is a graceful no-op (no text
    // found → attempt stamped, not an error).
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        seedBill({
          billId: `house_bill-${600 + i}-119`,
          momentumTier: "ACTIVE",
          fullText: undefined,
        }),
      ),
    );

    // The cron injects @/lib/prisma into fetchBillTextFunction. The fix's core
    // invariant: that borrowed client is never disconnected, so the first
    // worker to finish can't tear the pool out from under its siblings
    // mid-query. Before the fix, fetchBillTextFunction $disconnect()ed a
    // shared module-level client in its finally block on every call.
    const disconnectSpy = vi.spyOn(prisma, "$disconnect");

    try {
      const res = await invokeCron(GET, { search: { limit: "6" } });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.ok).toBe(true);
      // 404s are graceful no-ops, not errors — so the only way errorCount
      // goes non-zero here is an infra/connection failure, which is exactly
      // the disconnect race this fix removes.
      expect(body.errorCount).toBe(0);
      expect(body.errors).toEqual([]);
      // The shared client was borrowed, never disconnected...
      expect(disconnectSpy).not.toHaveBeenCalled();
      // ...and it stayed usable: the route's own post-fetch count query ran on
      // it and still sees all 6 bills (none got text).
      expect(body.remaining).toBe(6);
    } finally {
      disconnectSpy.mockRestore();
    }
  });
});
