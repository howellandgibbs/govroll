import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/cron/ingest-health/route";
import { getTestPrisma } from "../db";
import { invokeCron } from "../invoke";

// Both cursor-based crons must look fresh, or their absence/staleness is itself
// a breach. Helper seeds them at `now()`.
async function seedFreshCursors() {
  const db = getTestPrisma();
  await db.ingestCursor.create({
    data: { key: "fetch-bills", cursor: new Date() },
  });
  await db.ingestCursor.createMany({
    data: [
      { key: "fetch-votes-house", cursor: new Date() },
      { key: "fetch-votes-senate", cursor: new Date() },
    ],
  });
}

describe("GET /api/cron/ingest-health", () => {
  it("rejects missing auth", async () => {
    const res = await invokeCron(GET, { auth: null });
    expect(res.status).toBe(401);
  });

  it("reports healthy when cursors are fresh and nothing is stalled", async () => {
    await seedFreshCursors();

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.healthy).toBe(true);
    expect(body.breaches).toEqual([]);
  });

  it("flags a missing cursor as never-run", async () => {
    // fetch-votes-senate has no row at all.
    await getTestPrisma().ingestCursor.createMany({
      data: [
        { key: "fetch-bills", cursor: new Date() },
        { key: "fetch-votes-house", cursor: new Date() },
      ],
    });

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.breaches).toHaveLength(1);
    expect(body.breaches[0].pipeline).toBe("fetch-votes-senate");
    expect(body.breaches[0].detail).toContain("never completed a run");
  });

  it("flags a cursor that hasn't advanced past its limit", async () => {
    await seedFreshCursors();
    // `updatedAt` is @updatedAt (auto-stamped to now() on write), so force it
    // into the past with raw SQL to simulate a stuck cron.
    await getTestPrisma().$executeRaw`
      UPDATE "IngestCursor" SET "updatedAt" = now() - interval '20 hours'
      WHERE key = 'fetch-bills'
    `;

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.breaches).toHaveLength(1);
    expect(body.breaches[0].pipeline).toBe("fetch-bills");
    expect(body.breaches[0].detail).toContain("hasn't advanced");
  });

  it("flags refresh-metadata as silently stalled (backlog + stale stamp)", async () => {
    await seedFreshCursors();
    // A bill in the metadata gap (shortText null) whose last refresh is well
    // past the 6h limit — the #139 signature: work queued, nothing advancing.
    await getTestPrisma().bill.create({
      data: {
        billId: "house_bill-1-119",
        title: "Stalled Metadata Act",
        date: new Date("2026-01-01"),
        billType: "house_bill",
        currentStatus: "introduced",
        currentStatusDate: new Date("2026-01-01"),
        introducedDate: new Date("2026-01-01"),
        link: "https://www.congress.gov/bill/119th-congress/house-bill/1",
        shortText: null,
        lastMetadataRefreshAt: new Date(Date.now() - 10 * 3_600_000),
      },
    });

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.breaches).toHaveLength(1);
    expect(body.breaches[0].pipeline).toBe("refresh-bill-metadata");
    expect(body.breaches[0].detail).toContain("not advancing");
  });
});
