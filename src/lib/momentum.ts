// Momentum scoring for bills.
//
// The goal is to give users signal about whether a bill is actually moving —
// because ~90% of introduced bills die quietly in committee, and Congress.gov's
// native status ("Referred to Committee", "In Progress") doesn't change when a
// bill is abandoned. A bill that was referred 18 months ago looks identical to
// one referred yesterday without a momentum signal.
//
// Design principles:
//   1. Explainable over accurate — publish the formula; no black boxes.
//   2. Honest language — DEAD / DORMANT / STALLED / ACTIVE / ADVANCING / ENACTED.
//   3. Hard overrides first (prior Congress = dead, 365d silence = dead, etc.),
//      then a graded score for ranking within the "alive" tiers.
//   4. Recency reflects substantive movement, not procedural noise — committee
//      sub-referrals and technical actions don't pump the score the way a
//      markup, vote, or chamber passage does.
//   5. User engagement is split into baseline (capped low to avoid filter
//      bubbles) plus a 7d velocity signal — when a bill suddenly catches
//      attention, the algorithm follows.
//   6. Imminent floor action gets a small explicit boost so advocates can
//      find bills before the vote happens, not after.

export type MomentumTier =
  | "DEAD"
  | "DORMANT"
  | "STALLED"
  | "ACTIVE"
  | "ADVANCING"
  | "ENACTED";

export type DeathReason =
  | "CONGRESS_ENDED"
  | "FAILED_VOTE"
  | "VETOED"
  | "LONG_SILENCE"
  | null;

export interface MomentumInputs {
  billId: string;
  currentStatus: string;
  congressNumber: number | null;
  /** Most recent action of any kind. Used for LONG_SILENCE detection. */
  latestActionDate: Date | null;
  /**
   * Most recent action that materially advanced the bill (markup, vote,
   * chamber passage, conference report, etc. — see isMajorAction). Used
   * for the recency component of the score and for tier derivation. When
   * null, falls back to latestActionDate.
   */
  latestMajorActionDate?: Date | null;
  currentStatusDate: Date;
  cosponsorCount: number | null;
  cosponsorPartySplit: string | null;
  substantiveVersions: number;
  /** All-time engagement: representative votes + publicVotes + comments. */
  engagementCount: number;
  /**
   * 7-day civic engagement: publicVotes + comments only. Excludes
   * representative votes since roll calls happen on Congress's schedule
   * and shouldn't double as a "user interest just spiked" signal.
   */
  recentCivicEngagementCount?: number;
  /**
   * Whether any action within the last ~14 days matches an
   * imminent-floor-action pattern (placed on calendar, cloture motion,
   * rule reported, etc. — see isImminentFloorAction).
   */
  hasImminentFloorAction?: boolean;
}

export interface MomentumResult {
  score: number; // 0-100
  tier: MomentumTier;
  daysSinceLastAction: number;
  deathReason: DeathReason;
}

const DAY_MS = 86_400_000;

/**
 * Current Congress number for a given date.
 *
 * Congress N runs Jan 3 of year (2*(N-1) + 1789) through Jan 3 of the next
 * odd year. 119th Congress: Jan 3 2025 → Jan 3 2027.
 */
export function getCurrentCongress(now: Date = new Date()): number {
  let year = now.getUTCFullYear();
  // If we're in the first 2 days of January of an odd year, the previous
  // Congress is still technically in session.
  if (year % 2 === 1 && now.getUTCMonth() === 0 && now.getUTCDate() < 3) {
    year -= 1;
  }
  const startYear = year % 2 === 1 ? year : year - 1;
  return Math.floor((startYear - 1789) / 2) + 1;
}

/**
 * Date the given Congress ends (Jan 3 of the next odd year after it starts).
 */
export function getCongressEndDate(congress: number): Date {
  const startYear = (congress - 1) * 2 + 1789;
  return new Date(Date.UTC(startYear + 2, 0, 3));
}

/**
 * Parse "X D, Y R" cosponsor split into { d, r } counts. Returns null if unparsable.
 */
function parsePartySplit(
  split: string | null,
): { d: number; r: number } | null {
  if (!split) return null;
  const d = /(\d+)\s*D/i.exec(split)?.[1];
  const r = /(\d+)\s*R/i.exec(split)?.[1];
  if (!d && !r) return null;
  return { d: parseInt(d || "0", 10), r: parseInt(r || "0", 10) };
}

function isBipartisan(split: string | null): boolean {
  const parsed = parsePartySplit(split);
  if (!parsed) return false;
  const minority = Math.min(parsed.d, parsed.r);
  return minority >= 3; // ≥3 cosponsors from the minority party
}

/**
 * Major actions are ones that materially move a bill: introduction,
 * committee markup/reporting, chamber passage, conference, presidential
 * action. Routine actions — sub-referrals, technical corrections, sponsor
 * additions, "held at the desk" — return false and don't refresh the
 * recency signal. Pattern matching over `text` because Congress.gov's
 * `actionType` field is sparse and inconsistent across bill types.
 */
export function isMajorAction(
  text: string,
  actionType: string | null,
): boolean {
  const t = text || "";
  const ty = (actionType || "").toLowerCase();

  // Trust an explicit actionType when Congress.gov provides one.
  if (
    ty === "floor" ||
    ty === "becamelaw" ||
    ty === "discharge" ||
    ty === "calendars" ||
    ty.startsWith("vote-")
  ) {
    return true;
  }

  // Otherwise classify by text. Patterns kept conservative — false negatives
  // (missing a major action) just slow recency; false positives inflate it.
  return (
    /^Introduced (in|by)\b/i.test(t) ||
    /\b(Passed|Agreed to)\s+(in\s+)?(the\s+)?(House|Senate)\b/i.test(t) ||
    /\bFailed\s+(in\s+)?(the\s+)?(House|Senate)\b/i.test(t) ||
    /\bMotion to (recommit|reconsider)\b/i.test(t) ||
    /\bOrdered to be reported\b/i.test(t) ||
    /\bReported (by|to|with|favorably|originally)\b/i.test(t) ||
    /\bCommittee.{0,30}(Markup|markup held)\b/i.test(t) ||
    /\bMarkup (held|completed|session)\b/i.test(t) ||
    /\bHearings? (held|scheduled)\b/i.test(t) ||
    /\bConference (report|committee)\b/i.test(t) ||
    /\bConsidered (and|by) (the )?(House|Senate)\b/i.test(t) ||
    /\bCloture (invoked|motion (presented|filed|agreed))\b/i.test(t) ||
    /\bDischarged from\b/i.test(t) ||
    /\bPlaced on (the )?(Senate|House|Union|Calendar of Business|Legislative)/i.test(
      t,
    ) ||
    /\bPresented to (the )?President\b/i.test(t) ||
    /\bSigned by President\b/i.test(t) ||
    /\bBecame (Public )?Law\b/i.test(t) ||
    /\bVetoed by President\b/i.test(t) ||
    /\bVeto overridden\b/i.test(t) ||
    /\bRoll (Call )?Vote\b/i.test(t)
  );
}

/**
 * Subset of major actions specifically pointing to an upcoming or in-progress
 * floor vote — what an advocate would want to act on this week. Sometimes
 * overlaps with major actions that already happened (passage), but this is
 * scoped narrower: actions that telegraph a *future* vote.
 */
export function isImminentFloorAction(
  text: string,
  _actionType: string | null,
): boolean {
  const t = text || "";
  return (
    /\bPlaced on (the )?(Senate |House |Union )?(Legislative )?Calendar/i.test(
      t,
    ) ||
    /\bCloture motion (presented|filed|invoked)\b/i.test(t) ||
    /\bMotion to proceed\b/i.test(t) ||
    /\bRule\b.{0,30}\b(reported|provides|for consideration)\b/i.test(t) ||
    /\bDischarged from .{0,40}[Cc]ommittee\b/i.test(t) ||
    /\bScheduled for (consideration|floor)\b/i.test(t) ||
    /\bConsideration scheduled\b/i.test(t) ||
    /\bOrdered (to be )?placed on (the )?calendar\b/i.test(t)
  );
}

/**
 * Status floor — where the bill sits structurally, independent of activity.
 * Higher = further along in the legislative process.
 */
function statusFloor(status: string): number {
  if (status.startsWith("enacted_")) return 100;
  if (status.startsWith("conference_")) return 40;
  if (
    status === "passed_bill" ||
    status === "passed_concurrentres" ||
    status === "passed_simpleres"
  ) {
    return 38;
  }
  if (status.startsWith("pass_back_")) return 32;
  if (status.startsWith("pass_over_")) return 28;
  if (status === "reported") return 18;
  if (status === "introduced") return 8;
  if (status.startsWith("prov_kill_")) return 3; // stalled, not dead
  if (status.startsWith("fail_originating_")) return 2; // can revive via companion
  return 5;
}

/**
 * Compute momentum for a single bill.
 *
 * The hard overrides happen first so terminally-dead bills are never scored
 * as alive regardless of noise in other fields.
 */
export function computeMomentum(
  inputs: MomentumInputs,
  currentCongress: number,
  now: Date = new Date(),
): MomentumResult {
  const lastActionTs = (
    inputs.latestActionDate ?? inputs.currentStatusDate
  ).getTime();
  const daysSinceLastAction = Math.max(
    0,
    Math.floor((now.getTime() - lastActionTs) / DAY_MS),
  );

  // --- Hard overrides ---

  // Enacted: the only terminal success. Score decays from 100 over ~45 day
  // half-life to a floor of 25 so fresh enactments top the feed but don't
  // squat there forever — a year-old enactment sits around 25, just above
  // dormant bills. Tier stays "ENACTED" regardless; it's a factual label.
  if (inputs.currentStatus.startsWith("enacted_")) {
    const floor = 25;
    const halfLife = 45;
    const score = Math.round(
      floor + (100 - floor) * Math.pow(0.5, daysSinceLastAction / halfLife),
    );
    return { score, tier: "ENACTED", daysSinceLastAction, deathReason: null };
  }

  // Agreed-to simple / concurrent resolutions: terminal success for their
  // bill type. A simple resolution never goes to the other chamber or the
  // President — "passed" is the end of its route, so it can't be ADVANCING
  // (there's nothing left to advance to). Tier ENACTED here means "this
  // measure's process is complete", and the tier is never rendered as the
  // word "Enacted" (the stage label comes from currentStatus). Score starts
  // lower than a true enactment so a fresh commemorative resolution sits
  // just below a fresh chamber-passed bill in Trending instead of on top
  // of it, then decays out of the way.
  if (
    inputs.currentStatus === "passed_simpleres" ||
    inputs.currentStatus === "passed_concurrentres"
  ) {
    const floor = 10;
    const peak = 50;
    const halfLife = 45;
    const score = Math.round(
      floor + (peak - floor) * Math.pow(0.5, daysSinceLastAction / halfLife),
    );
    return { score, tier: "ENACTED", daysSinceLastAction, deathReason: null };
  }

  // Prior Congress: constitutionally dead, bills do not carry over.
  if (
    inputs.congressNumber !== null &&
    inputs.congressNumber < currentCongress
  ) {
    return {
      score: 0,
      tier: "DEAD",
      daysSinceLastAction,
      deathReason: "CONGRESS_ENDED",
    };
  }

  // Terminal failures: cleared second chamber failing, pocket veto, failed override.
  if (
    inputs.currentStatus.startsWith("fail_second_") ||
    inputs.currentStatus.startsWith("vetoed_override_fail_")
  ) {
    return {
      score: 0,
      tier: "DEAD",
      daysSinceLastAction,
      deathReason: "FAILED_VOTE",
    };
  }
  if (inputs.currentStatus === "vetoed_pocket") {
    return {
      score: 0,
      tier: "DEAD",
      daysSinceLastAction,
      deathReason: "VETOED",
    };
  }

  // Long silence: no action in 365+ days is effectively dead for a live-Congress bill.
  // Uses any-action recency, not major-action recency — "no signs of life at all"
  // is what makes a bill dead, not "no significant progress."
  if (daysSinceLastAction > 365) {
    return {
      score: 0,
      tier: "DEAD",
      daysSinceLastAction,
      deathReason: "LONG_SILENCE",
    };
  }

  // --- Graded score ---

  const floor = statusFloor(inputs.currentStatus);

  // Recency: based on the most recent *major* action so we don't pump the
  // score on procedural noise (sub-referrals, technical corrections, sponsor
  // adds). Falls back to any-action recency when no major action is known.
  const lastMajorTs = (
    inputs.latestMajorActionDate ??
    inputs.latestActionDate ??
    inputs.currentStatusDate
  ).getTime();
  const daysSinceLastMajor = Math.max(
    0,
    Math.floor((now.getTime() - lastMajorTs) / DAY_MS),
  );
  const recency = 30 * Math.pow(0.5, daysSinceLastMajor / 60);

  // Text iteration: committees publishing revised versions = real engagement.
  // Worth up to 10 points; cap at 3 substantive versions.
  const textIteration = Math.min(10, inputs.substantiveVersions * 4);

  // Cosponsor support: log-scaled, bonus for bipartisan. Up to 10 points.
  const cosponsors = inputs.cosponsorCount ?? 0;
  const cosponsorBase = Math.log1p(cosponsors) * 2;
  const cosponsorScore = Math.min(
    10,
    cosponsorBase * (isBipartisan(inputs.cosponsorPartySplit) ? 1.5 : 1.0),
  );

  // Civic engagement, split:
  //   - Baseline (cap 3): all-time. Capped low to avoid filter-bubble loops
  //     where bills trend because they trended.
  //   - Velocity (cap 5): last-7-day publicVotes + comments. This is our
  //     proxy for news-cycle salience — when an event makes a bill suddenly
  //     relevant, our users react in real time and the score follows.
  const civicBase = Math.min(3, Math.log1p(inputs.engagementCount));
  const recentCivic = inputs.recentCivicEngagementCount ?? 0;
  const civicVelocity = Math.min(5, Math.log1p(recentCivic) * 1.5);
  const civicScore = civicBase + civicVelocity;

  // Imminent floor action: small flat boost. Helps advocates find bills
  // before the vote, not after. Bounded so it can re-rank within a tier
  // but never make a stalled bill look like a passing one.
  const imminenceBoost = inputs.hasImminentFloorAction ? 6 : 0;

  // End-of-Congress penalty: bills that haven't passed either chamber in the
  // last 3 months of a Congress are unlikely to move.
  const endOfCongress = getCongressEndDate(currentCongress);
  const daysToEnd = Math.max(
    0,
    Math.floor((endOfCongress.getTime() - now.getTime()) / DAY_MS),
  );
  let endPenalty = 0;
  if (daysToEnd < 90 && floor < 25) endPenalty = 15;
  else if (daysToEnd < 180 && floor < 18) endPenalty = 8;

  // Status floor contributes up to 40 for non-enacted bills (conference=40).
  const floorContribution = Math.min(40, floor);

  const rawScore =
    floorContribution +
    recency +
    textIteration +
    cosponsorScore +
    civicScore +
    imminenceBoost -
    endPenalty;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // --- Tier derivation ---
  //
  // Uses major-action recency so a bill receiving only sub-referrals doesn't
  // get labeled ACTIVE on procedural noise. Status overrides still promote
  // bills that have cleared meaningful procedural milestones, and an
  // imminent floor action floors the tier at ACTIVE so advocates aren't
  // told a bill scheduled for tomorrow is stalled.

  let tier: MomentumTier;
  if (
    floor >= 28 &&
    (daysSinceLastMajor <= 180 || inputs.hasImminentFloorAction)
  ) {
    // Passed at least one chamber and still moving — structurally advancing.
    // A bill that cleared the House but has sat in the Senate for six
    // months isn't advancing anymore; it falls through to STALLED below
    // (and to DEAD via the 365-day silence override above that).
    tier = "ADVANCING";
  } else if (floor >= 28) {
    tier = "STALLED";
  } else if (daysSinceLastMajor <= 60 || inputs.hasImminentFloorAction) {
    // Congress cadence is monthly; 60 days covers a normal markup cycle.
    tier = "ACTIVE";
  } else if (daysSinceLastMajor <= 180) {
    tier = "STALLED";
  } else {
    tier = "DORMANT";
  }

  return { score, tier, daysSinceLastAction, deathReason: null };
}
