import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./concurrency";

describe("runWithConcurrency", () => {
  it("preserves input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [30, 5, 20, 1, 10, 15, 2];

    const out = await runWithConcurrency(items, 3, async (ms) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 2;
    });

    expect(out).toEqual(items.map((ms) => ms * 2));
    expect(peak).toBe(3);
  });

  it("handles an empty list", async () => {
    expect(await runWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});
