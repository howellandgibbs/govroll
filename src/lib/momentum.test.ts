import { describe, it, expect } from "vitest";
import {
  computeMomentum,
  getCurrentCongress,
  isMajorAction,
  isImminentFloorAction,
} from "./momentum";

const baseInputs = {
  billId: "hr1-119",
  currentStatus: "introduced",
  congressNumber: 119,
  latestActionDate: null,
  latestMajorActionDate: null,
  currentStatusDate: new Date("2026-04-01T00:00:00Z"),
  cosponsorCount: 0,
  cosponsorPartySplit: null,
  substantiveVersions: 0,
  engagementCount: 0,
  recentCivicEngagementCount: 0,
  hasImminentFloorAction: false,
};

const now = new Date("2026-04-15T00:00:00Z");

describe("computeMomentum", () => {
  it("freshly-introduced bill in current Congress → ACTIVE tier, alive score", () => {
    const result = computeMomentum(
      { ...baseInputs, latestActionDate: new Date("2026-04-10T00:00:00Z") },
      119,
      now,
    );
    expect(result.tier).toBe("ACTIVE");
    expect(result.deathReason).toBeNull();
    expect(result.score).toBeGreaterThan(0);
  });

  it("bill from prior Congress → DEAD with CONGRESS_ENDED", () => {
    const result = computeMomentum(
      { ...baseInputs, congressNumber: 118 },
      119,
      now,
    );
    expect(result.tier).toBe("DEAD");
    expect(result.deathReason).toBe("CONGRESS_ENDED");
    expect(result.score).toBe(0);
  });

  it("bill silent for 400 days in current Congress → DEAD with LONG_SILENCE", () => {
    const result = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2025-03-01T00:00:00Z"),
      },
      119,
      now,
    );
    expect(result.tier).toBe("DEAD");
    expect(result.deathReason).toBe("LONG_SILENCE");
  });

  it("enacted bill → ENACTED tier regardless of age; score decays from 100", () => {
    const fresh = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "enacted_signed",
        latestActionDate: new Date("2026-04-14T00:00:00Z"),
      },
      119,
      now,
    );
    const old = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "enacted_signed",
        latestActionDate: new Date("2026-01-01T00:00:00Z"),
      },
      119,
      now,
    );
    expect(fresh.tier).toBe("ENACTED");
    expect(old.tier).toBe("ENACTED");
    expect(fresh.score).toBeGreaterThan(old.score);
    expect(fresh.score).toBeLessThanOrEqual(100);
    expect(old.score).toBeGreaterThanOrEqual(25);
  });

  it("bill that passed one chamber → ADVANCING", () => {
    const result = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "pass_over_house",
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
      },
      119,
      now,
    );
    expect(result.tier).toBe("ADVANCING");
  });

  it("bill that passed one chamber but has had no major action in 180+ days → STALLED", () => {
    const stale = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "pass_over_house",
        latestActionDate: new Date("2026-04-01T00:00:00Z"), // recent noise
        latestMajorActionDate: new Date("2025-09-15T00:00:00Z"), // 212d ago
      },
      119,
      now,
    );
    expect(stale.tier).toBe("STALLED");

    // Same bill with a floor action scheduled stays ADVANCING.
    const scheduled = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "pass_over_house",
        latestActionDate: new Date("2026-04-01T00:00:00Z"),
        latestMajorActionDate: new Date("2025-09-15T00:00:00Z"),
        hasImminentFloorAction: true,
      },
      119,
      now,
    );
    expect(scheduled.tier).toBe("ADVANCING");
  });

  it("agreed-to simple resolution → terminal (ENACTED) tier, not ADVANCING; scores below a fresh enactment", () => {
    const resolution = computeMomentum(
      {
        ...baseInputs,
        billId: "sres837-119",
        currentStatus: "passed_simpleres",
        latestActionDate: new Date("2026-04-14T00:00:00Z"),
      },
      119,
      now,
    );
    expect(resolution.tier).toBe("ENACTED");
    expect(resolution.deathReason).toBeNull();

    const law = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "enacted_signed",
        latestActionDate: new Date("2026-04-14T00:00:00Z"),
      },
      119,
      now,
    );
    expect(resolution.score).toBeLessThan(law.score);

    // A fresh chamber-passed bill should outrank a fresh commemorative
    // resolution in Trending.
    const passedBill = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "pass_over_house",
        latestActionDate: new Date("2026-04-14T00:00:00Z"),
      },
      119,
      now,
    );
    expect(resolution.score).toBeLessThan(passedBill.score);

    const concurrent = computeMomentum(
      { ...baseInputs, currentStatus: "passed_concurrentres" },
      119,
      now,
    );
    expect(concurrent.tier).toBe("ENACTED");
  });

  it("pocket-vetoed bill → DEAD with VETOED", () => {
    const result = computeMomentum(
      {
        ...baseInputs,
        currentStatus: "vetoed_pocket",
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
      },
      119,
      now,
    );
    expect(result.tier).toBe("DEAD");
    expect(result.deathReason).toBe("VETOED");
  });

  it("bipartisan cosponsors boost score over pure partisan", () => {
    const bipartisan = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        cosponsorCount: 10,
        cosponsorPartySplit: "5 D, 5 R",
      },
      119,
      now,
    );
    const partisan = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        cosponsorCount: 10,
        cosponsorPartySplit: "10 D",
      },
      119,
      now,
    );
    expect(bipartisan.score).toBeGreaterThan(partisan.score);
  });

  // Routine-action recency: a bill whose only "recent activity" is a
  // sub-referral or technical action shouldn't outrank a bill with a real
  // recent committee markup.
  it("major-action recency outranks routine-action recency", () => {
    // Bill A: major action (markup) was 5 days ago.
    const a = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2026-04-10T00:00:00Z"),
      },
      119,
      now,
    );
    // Bill B: latest action 5 days ago, but it was procedural — last
    // major action was 120 days ago.
    const b = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2025-12-16T00:00:00Z"),
      },
      119,
      now,
    );
    expect(a.score).toBeGreaterThan(b.score);
  });

  // Tier derivation: a bill with only routine activity in the last 60 days
  // should not be labeled ACTIVE.
  it("tier uses major-action recency, not any-action recency", () => {
    const result = computeMomentum(
      {
        ...baseInputs,
        // Touched recently by procedural noise…
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        // …but no real movement in 200 days.
        latestMajorActionDate: new Date("2025-09-27T00:00:00Z"),
      },
      119,
      now,
    );
    expect(result.tier).toBe("DORMANT");
  });

  // Engagement velocity: a recent surge of public votes/comments lifts the
  // score, capturing news-cycle relevance without scraping news.
  it("recent civic engagement velocity boosts score", () => {
    const quiet = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2026-04-10T00:00:00Z"),
        engagementCount: 50,
        recentCivicEngagementCount: 0,
      },
      119,
      now,
    );
    const trending = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2026-04-10T00:00:00Z"),
        engagementCount: 50,
        recentCivicEngagementCount: 200,
      },
      119,
      now,
    );
    expect(trending.score).toBeGreaterThan(quiet.score);
  });

  // Imminent floor action: an explicit boost so vote-imminent bills
  // surface above otherwise-similar bills sitting in committee.
  it("imminent floor action boosts score and floors the tier at ACTIVE", () => {
    const without = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2026-04-10T00:00:00Z"),
        hasImminentFloorAction: false,
      },
      119,
      now,
    );
    const withImminent = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-04-10T00:00:00Z"),
        latestMajorActionDate: new Date("2026-04-10T00:00:00Z"),
        hasImminentFloorAction: true,
      },
      119,
      now,
    );
    expect(withImminent.score).toBeGreaterThan(without.score);
    expect(withImminent.tier).toBe("ACTIVE");
  });

  it("imminent action lifts a borderline-stale bill back to ACTIVE", () => {
    // 90 days since last major action would normally land in STALLED.
    const stale = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-01-15T00:00:00Z"),
        latestMajorActionDate: new Date("2026-01-15T00:00:00Z"),
        hasImminentFloorAction: false,
      },
      119,
      now,
    );
    expect(stale.tier).toBe("STALLED");

    const scheduled = computeMomentum(
      {
        ...baseInputs,
        latestActionDate: new Date("2026-01-15T00:00:00Z"),
        latestMajorActionDate: new Date("2026-01-15T00:00:00Z"),
        hasImminentFloorAction: true,
      },
      119,
      now,
    );
    expect(scheduled.tier).toBe("ACTIVE");
  });
});

describe("isMajorAction", () => {
  it("classifies chamber passage and committee reporting as major", () => {
    expect(
      isMajorAction("Passed House by recorded vote: 217 - 213.", null),
    ).toBe(true);
    expect(
      isMajorAction("Agreed to in Senate by Unanimous Consent.", null),
    ).toBe(true);
    expect(
      isMajorAction("Reported by Committee on Ways and Means.", null),
    ).toBe(true);
    expect(
      isMajorAction("Ordered to be reported (Amended) by Yeas and Nays.", null),
    ).toBe(true);
    expect(isMajorAction("Markup held in Subcommittee.", null)).toBe(true);
  });

  it("classifies enactment and presidential action as major", () => {
    expect(isMajorAction("Presented to President.", null)).toBe(true);
    expect(isMajorAction("Became Public Law No: 119-12.", null)).toBe(true);
    expect(isMajorAction("Vetoed by President.", null)).toBe(true);
  });

  it("treats routine procedural actions as not major", () => {
    expect(
      isMajorAction("Referred to the Committee on Energy and Commerce.", null),
    ).toBe(false);
    expect(isMajorAction("Referred to the Subcommittee on Health.", null)).toBe(
      false,
    );
    expect(isMajorAction("Held at the desk.", null)).toBe(false);
    expect(
      isMajorAction("Sponsor introductory remarks on measure.", null),
    ).toBe(false);
  });

  it("trusts an explicit Congress.gov actionType when provided", () => {
    expect(isMajorAction("Some text", "Floor")).toBe(true);
    expect(isMajorAction("Some text", "BecameLaw")).toBe(true);
    expect(isMajorAction("Some text", "Vote-PassageOrAgreedToVote")).toBe(true);
  });
});

describe("isImminentFloorAction", () => {
  it("flags calendar placement and cloture motions", () => {
    expect(
      isImminentFloorAction(
        "Placed on the Senate Legislative Calendar under General Orders.",
        null,
      ),
    ).toBe(true);
    expect(
      isImminentFloorAction(
        "Placed on the Union Calendar, Calendar No. 142.",
        null,
      ),
    ).toBe(true);
    expect(
      isImminentFloorAction("Cloture motion presented in Senate.", null),
    ).toBe(true);
    expect(
      isImminentFloorAction(
        "Motion to proceed to consideration of measure.",
        null,
      ),
    ).toBe(true);
  });

  it("flags rule-reported and discharge actions", () => {
    expect(
      isImminentFloorAction(
        "Rule H. Res. 905 reported, providing for consideration.",
        null,
      ),
    ).toBe(true);
    expect(
      isImminentFloorAction("Discharged from the Committee on Rules.", null),
    ).toBe(true);
  });

  it("does not flag past-tense passage or routine actions", () => {
    expect(isImminentFloorAction("Passed House by voice vote.", null)).toBe(
      false,
    );
    expect(
      isImminentFloorAction("Referred to Committee on Finance.", null),
    ).toBe(false);
    expect(isImminentFloorAction("Sponsor introductory remarks.", null)).toBe(
      false,
    );
  });
});

describe("getCurrentCongress", () => {
  it("returns 119 for April 2026", () => {
    expect(getCurrentCongress(new Date("2026-04-15T00:00:00Z"))).toBe(119);
  });

  it("returns 118 for Dec 2024", () => {
    expect(getCurrentCongress(new Date("2024-12-15T00:00:00Z"))).toBe(118);
  });

  it("rolls over to 120 at Jan 3 2027", () => {
    expect(getCurrentCongress(new Date("2027-01-03T12:00:00Z"))).toBe(120);
  });
});
