import { describe, expect, it } from "vitest";
import { evaluateIngestHealth } from "./ingest-health";

const NOW = new Date("2026-06-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("evaluateIngestHealth", () => {
  it("reports no breaches when everything is fresh", () => {
    const breaches = evaluateIngestHealth({
      now: NOW,
      cursors: [
        { key: "fetch-bills", updatedAt: hoursAgo(2), maxStaleHours: 12 },
        {
          key: "fetch-votes-house",
          updatedAt: hoursAgo(0.5),
          maxStaleHours: 8,
        },
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
      cursors: [
        { key: "fetch-votes-house", updatedAt: null, maxStaleHours: 8 },
      ],
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
        { key: "fetch-votes-house", updatedAt: hoursAgo(1), maxStaleHours: 8 },
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
