import { describe, expect, it } from "vitest";
import {
  evaluateIngestHealth,
  evaluateSenateVotes,
  senateRollCallNumber,
} from "./ingest-health";

const NOW = new Date("2026-06-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("evaluateIngestHealth", () => {
  it("reports no breaches when everything is fresh", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [
        { key: "fetch-bills", updatedAt: hoursAgo(2), maxStaleHours: 12 },
        { key: "fetch-votes", updatedAt: hoursAgo(0.5), maxStaleHours: 8 },
      ],
      backfills: [
        {
          name: "refresh-bill-metadata",
          backlog: 200,
          lastProgressAt: hoursAgo(1),
          maxStaleHours: 6,
        },
      ],
    });
    expect(breaches).toEqual([]);
  });

  it("flags a cursor that hasn't advanced past its limit", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [
        { key: "fetch-bills", updatedAt: hoursAgo(15), maxStaleHours: 12 },
      ],
      backfills: [],
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].pipeline).toBe("fetch-bills");
    expect(breaches[0].detail).toContain("15.0h");
    expect(breaches[0].detail).toContain("limit 12h");
  });

  it("does NOT flag a cursor exactly at the boundary", () => {
    // Weekend-proof: lag just under the limit (e.g. a single missed cycle plus
    // GitHub delay) must stay quiet so a quiet Congress never pages us.
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [
        { key: "fetch-bills", updatedAt: hoursAgo(11.9), maxStaleHours: 12 },
      ],
      backfills: [],
    });
    expect(breaches).toEqual([]);
  });

  it("flags a missing cursor row as never-run", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [{ key: "fetch-votes", updatedAt: null, maxStaleHours: 8 }],
      backfills: [],
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].detail).toContain("never completed a run");
  });

  it("flags a backfill that has work but stopped advancing (silent stall)", () => {
    // The #139 class: green runs, zero progress, backlog persists.
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [],
      backfills: [
        {
          name: "refresh-bill-metadata",
          backlog: 2500,
          lastProgressAt: hoursAgo(9),
          maxStaleHours: 6,
        },
      ],
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].pipeline).toBe("refresh-bill-metadata");
    expect(breaches[0].detail).toContain("2500 bills queued");
    expect(breaches[0].detail).toContain("not advancing");
  });

  it("does NOT flag a stale backfill when the queue is empty (caught up)", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [],
      backfills: [
        {
          name: "refresh-bill-metadata",
          backlog: 0,
          lastProgressAt: hoursAgo(48),
          maxStaleHours: 6,
        },
      ],
    });
    expect(breaches).toEqual([]);
  });

  it("flags a backfill with a backlog that has never recorded progress", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [],
      backfills: [
        {
          name: "refresh-bill-metadata",
          backlog: 50,
          lastProgressAt: null,
          maxStaleHours: 6,
        },
      ],
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].detail).toContain("never recorded progress");
  });

  it("collects breaches across multiple pipelines at once", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [
        { key: "fetch-bills", updatedAt: hoursAgo(20), maxStaleHours: 12 },
        { key: "fetch-votes", updatedAt: hoursAgo(1), maxStaleHours: 8 },
      ],
      backfills: [
        {
          name: "refresh-bill-metadata",
          backlog: 100,
          lastProgressAt: hoursAgo(7),
          maxStaleHours: 6,
        },
      ],
    });
    expect(breaches.map((b) => b.pipeline)).toEqual([
      "fetch-bills",
      "refresh-bill-metadata",
    ]);
  });
});

describe("senateRollCallNumber", () => {
  it("reads the vote number from a Senate roll-call action", () => {
    expect(
      senateRollCallNumber(
        "Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 53 - 46. Record Vote Number: 253. (CR S5199)",
      ),
    ).toBe(253);
    expect(
      senateRollCallNumber(
        "Passed Senate with an amendment by Yea-Nay Vote. 68 - 30. Record Vote Number: 12.",
      ),
    ).toBe(12);
  });

  it("ignores a motion to reconsider that only cites an earlier vote", () => {
    // Cited up to weeks after the vote itself, so it can't date one.
    expect(
      senateRollCallNumber(
        "Motion by Senator Thune to reconsider the vote (Record Vote No. 38) by which cloture was not invoked on the motion to proceed to the measure entered in Senate.",
      ),
    ).toBeNull();
  });

  it("ignores House roll calls and votes without a roll call", () => {
    expect(
      senateRollCallNumber(
        "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 456).",
      ),
    ).toBeNull();
    expect(
      senateRollCallNumber(
        "Passed Senate without amendment by Unanimous Consent.",
      ),
    ).toBeNull();
    expect(
      senateRollCallNumber("Message on Senate action sent to the House."),
    ).toBeNull();
  });
});

describe("evaluateSenateVotes", () => {
  // Congress.gov dates an action to the day; fetch-bills stores UTC midnight.
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const cloture = (n: number) =>
    `Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 47 - 52. Record Vote Number: ${n}.`;

  it("flags a roll call Congress.gov recorded that still isn't stored", () => {
    const breaches = evaluateSenateVotes({
      now: NOW,
      actions: [
        {
          billId: "house_bill-7008-119",
          actionDate: day("2026-06-11"),
          text: cloture(180),
        },
      ],
      stored: [],
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].pipeline).toBe("fetch-votes-senate");
    expect(breaches[0].detail).toContain(
      "1 Senate roll call Congress.gov recorded still not stored 36h",
    );
    expect(breaches[0].detail).toContain(
      "#180 on 2026-06-11 (house_bill-7008-119)",
    );
  });

  it("waits 36h past the vote's day, so Friday's votes have until Sunday", () => {
    // Voteview publishes overnight: Friday's roll calls land Saturday morning.
    // Fri 06-12's day ends 06-13 00:00 UTC, so it's due 06-14 12:00 UTC.
    const input = {
      actions: [
        {
          billId: "senate_bill-1-119",
          actionDate: day("2026-06-12"),
          text: cloture(181),
        },
      ],
      stored: [],
    };
    const at = (iso: string) =>
      evaluateSenateVotes({ ...input, now: new Date(iso) });
    expect(at("2026-06-13T20:00:00Z")).toEqual([]);
    expect(at("2026-06-14T12:00:00Z")).toEqual([]);
    expect(at("2026-06-14T13:00:00Z")).toHaveLength(1);
  });

  it("matches a stored roll call by number within days of the vote", () => {
    const breaches = evaluateSenateVotes({
      now: NOW,
      actions: [
        {
          billId: "house_bill-7008-119",
          actionDate: day("2026-06-11"),
          text: cloture(180),
        },
      ],
      // senate.gov times a vote (ET wall clock); Voteview dates it at midnight.
      stored: [
        { rollCallNumber: 180, votedAt: new Date("2026-06-11T18:42:00Z") },
      ],
    });
    expect(breaches).toEqual([]);
  });

  it("doesn't count a same-numbered vote from another session as stored", () => {
    const breaches = evaluateSenateVotes({
      now: NOW,
      actions: [
        {
          billId: "house_bill-7008-119",
          actionDate: day("2026-06-11"),
          text: cloture(180),
        },
      ],
      stored: [
        { rollCallNumber: 180, votedAt: day("2025-06-10") },
        { rollCallNumber: 179, votedAt: day("2026-06-11") },
      ],
    });
    expect(breaches).toHaveLength(1);
  });

  it("stays quiet through a recess, even with an old gap", () => {
    // The Senate left town after its 06-10 vote, which is stored. An earlier
    // vote went unstored, but it's past the lookback — a backfill job by now,
    // not a live stall, and it mustn't page for the rest of the recess.
    const breaches = evaluateSenateVotes({
      now: NOW,
      actions: [
        {
          billId: "senate_bill-3-119",
          actionDate: day("2026-06-10"),
          text: cloture(175),
        },
        {
          billId: "senate_bill-4-119",
          actionDate: day("2026-06-08"),
          text: cloture(170),
        },
      ],
      stored: [{ rollCallNumber: 175, votedAt: day("2026-06-10") }],
    });
    expect(breaches).toEqual([]);
  });

  it("names each missing roll call once, oldest first, then counts the rest", () => {
    const breaches = evaluateSenateVotes({
      now: NOW,
      actions: [
        // A bill's latest action and its action history name the same vote.
        {
          billId: "senate_bill-5-119",
          actionDate: day("2026-06-12"),
          text: cloture(186),
        },
        {
          billId: "senate_bill-5-119",
          actionDate: day("2026-06-12"),
          text: cloture(186),
        },
        ...[180, 181, 182, 183, 184, 185].map((n) => ({
          billId: `senate_bill-${n}-119`,
          actionDate: day("2026-06-11"),
          text: cloture(n),
        })),
      ],
      stored: [],
    });
    expect(breaches).toHaveLength(1);
    const { detail } = breaches[0];
    expect(detail).toContain("7 Senate roll calls Congress.gov recorded");
    expect(detail).toContain(
      "#180 on 2026-06-11 (senate_bill-180-119), #181 on 2026-06-11",
    );
    expect(detail).toContain(
      "#184 on 2026-06-11 (senate_bill-184-119), +2 more",
    );
    expect(detail).not.toContain("#186");
  });
});
