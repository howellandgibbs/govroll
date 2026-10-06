import { describe, it, expect } from "vitest";
import {
  billStatusLine,
  deathLabel,
  momentumPhrase,
  statusLabel,
} from "@/lib/bill-status-labels";
import type { DeathReason, MomentumTier } from "@/types";

describe("statusLabel", () => {
  it.each([
    ["introduced", "Introduced"],
    ["reported", "In Committee"],
    ["pass_over_house", "In Progress"],
    ["pass_back_senate", "In Progress"],
    ["passed_bill", "Passed"],
    ["passed_simpleres", "Passed"],
    ["enacted_signed", "Enacted"],
    ["prov_kill_suspensionfailed", "Stalled"],
    ["prov_kill_veto", "Failed"],
    ["fail_originating_house", "Failed"],
    ["something_new", "Introduced"],
  ])("%s → %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});

describe("momentumPhrase", () => {
  it("says nothing for live tiers, where the stage already says it", () => {
    for (const tier of ["ACTIVE", "ADVANCING", "ENACTED", null] as const) {
      expect(momentumPhrase(tier, null)).toBeNull();
    }
  });

  it("names quiet and dead bills", () => {
    expect(momentumPhrase("DORMANT", null)).toBe("Dormant");
    expect(momentumPhrase("STALLED", null)).toBe("Stalled");
    expect(momentumPhrase("DEAD", "CONGRESS_ENDED")).toBe(
      "Died (Congress ended)",
    );
    expect(momentumPhrase("DEAD", null)).toBe("Died");
    expect(deathLabel(null)).toBe("Died");
  });

  // Deploy-skew guard: a tier or reason added server-side later must not
  // break a browser still running this bundle.
  it("tolerates values it doesn't know", () => {
    expect(momentumPhrase("ZOMBIE" as MomentumTier, null)).toBeNull();
    expect(momentumPhrase("DEAD", "ABDUCTED" as DeathReason)).toBe("Died");
  });
});

describe("billStatusLine", () => {
  it("joins stage and momentum", () => {
    expect(
      billStatusLine({
        currentStatus: "introduced",
        momentumTier: "DORMANT",
        deathReason: null,
      }),
    ).toBe("Introduced · Dormant");
    expect(
      billStatusLine({
        currentStatus: "pass_over_house",
        momentumTier: "DEAD",
        deathReason: "CONGRESS_ENDED",
      }),
    ).toBe("In Progress · Died (Congress ended)");
    expect(
      billStatusLine({
        currentStatus: "enacted_signed",
        momentumTier: "ENACTED",
        deathReason: null,
      }),
    ).toBe("Enacted");
  });
});
