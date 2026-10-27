import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/cron/ingest-health/route";
import { getTestPrisma } from "../db";
import { seedBill, seedRepresentative } from "../fixtures";
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
    // past the 12h limit — the #139 signature: work queued, nothing advancing.
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
        lastMetadataRefreshAt: new Date(Date.now() - 15 * 3_600_000),
      },
    });

    const res = await invokeCron(GET);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.breaches).toHaveLength(1);
    expect(body.breaches[0].pipeline).toBe("refresh-bill-metadata");
    expect(body.breaches[0].detail).toContain("not advancing");
  });

  describe("Senate roll calls Congress.gov recorded", () => {
    // Congress.gov dates an action to the day; fetch-bills stores UTC midnight.
    // Three days back is always past the grace; one day back never is.
    function utcDaysAgo(days: number) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - days);
      return d;
    }
    const cloture = (n: number) =>
      `Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 53 - 46. Record Vote Number: ${n}.`;

    // Freshly stamped by refresh-metadata, so only the Senate check can fire.
    function seedVotedBill(overrides: Parameters<typeof seedBill>[0]) {
      return seedBill({ lastMetadataRefreshAt: new Date(), ...overrides });
    }

    async function storeRollCall(
      billId: number,
      chamber: "senate" | "house",
      rollCallNumber: number,
      votedAt: Date,
    ) {
      const member = await seedRepresentative({
        chamber: chamber === "senate" ? "senator" : "representative",
      });
      await getTestPrisma().representativeVote.create({
        data: {
          representativeId: member.id,
          billId,
          vote: "Nay",
          rollCallNumber,
          chamber,
          votedAt,
          category: "cloture",
        },
      });
    }

    it("flags one that fetch-votes never stored", async () => {
      await seedFreshCursors();
      const bill = await seedVotedBill({
        billId: "house_bill-7008-119",
        latestActionText: cloture(253),
        latestActionDate: utcDaysAgo(3),
      });
      // The House's roll call 253 that day is a different vote.
      await storeRollCall(bill.id, "house", 253, utcDaysAgo(3));

      const res = await invokeCron(GET);
      const body = await res.json();
      expect(body.healthy).toBe(false);
      expect(body.breaches).toHaveLength(1);
      expect(body.breaches[0].pipeline).toBe("fetch-votes-senate");
      expect(body.breaches[0].detail).toContain("#253");
      expect(body.breaches[0].detail).toContain("house_bill-7008-119");
    });

    it("reads them from a bill's action history as well", async () => {
      await seedFreshCursors();
      // The vote is no longer the bill's latest action.
      const bill = await seedVotedBill({
        latestActionText: "Message on Senate action sent to the House.",
        latestActionDate: utcDaysAgo(2),
      });
      await getTestPrisma().billAction.create({
        data: {
          billId: bill.id,
          actionDate: utcDaysAgo(3),
          chamber: "Senate",
          text: "Passed Senate with an amendment by Yea-Nay Vote. 68 - 30. Record Vote Number: 260.",
        },
      });

      const res = await invokeCron(GET);
      const body = await res.json();
      expect(body.healthy).toBe(false);
      expect(body.breaches).toHaveLength(1);
      expect(body.breaches[0].pipeline).toBe("fetch-votes-senate");
      expect(body.breaches[0].detail).toContain("#260");
    });

    it("stays healthy once the roll call is stored", async () => {
      await seedFreshCursors();
      const bill = await seedVotedBill({
        latestActionText: cloture(253),
        latestActionDate: utcDaysAgo(3),
      });
      await storeRollCall(bill.id, "senate", 253, utcDaysAgo(3));

      const res = await invokeCron(GET);
      const body = await res.json();
      expect(body.healthy).toBe(true);
      expect(body.breaches).toEqual([]);
    });

    it("stays healthy through a recess", async () => {
      await seedFreshCursors();
      // The Senate's last vote before leaving town, stored.
      const last = await seedVotedBill({
        latestActionText: cloture(251),
        latestActionDate: utcDaysAgo(5),
      });
      await storeRollCall(last.id, "senate", 251, utcDaysAgo(5));
      // An older vote that never made it in: past the lookback, so it's
      // backfill territory now, not a stall to page about all recess.
      await seedVotedBill({
        latestActionText: cloture(240),
        latestActionDate: utcDaysAgo(20),
      });

      const res = await invokeCron(GET);
      const body = await res.json();
      expect(body.healthy).toBe(true);
      expect(body.breaches).toEqual([]);
    });

    it("waits for the source to publish a new vote", async () => {
      await seedFreshCursors();
      // Yesterday's vote: Voteview publishes overnight, so it isn't due yet.
      await seedVotedBill({
        latestActionText: cloture(253),
        latestActionDate: utcDaysAgo(1),
      });

      const res = await invokeCron(GET);
      const body = await res.json();
      expect(body.healthy).toBe(true);
      expect(body.breaches).toEqual([]);
    });
  });
});
