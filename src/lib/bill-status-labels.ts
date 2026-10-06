import type { DeathReason, MomentumTier } from "@/types";

/**
 * Plain-language status vocabulary shared by bill cards and the header
 * search dropdown, so a bill reads the same wherever it's listed.
 *
 * Every switch keeps a default: these values come from the server, and a
 * browser running an older bundle must survive a value added later.
 */

/** Stage label from a raw currentStatus ("pass_over_house" → "In Progress"). */
export function statusLabel(status: string): string {
  if (status.startsWith("enacted_")) return "Enacted";
  if (
    status === "passed_bill" ||
    status.startsWith("conference_") ||
    status === "passed_simpleres" ||
    status === "passed_concurrentres"
  )
    return "Passed";
  if (status.startsWith("pass_over_") || status.startsWith("pass_back_"))
    return "In Progress";
  if (status.startsWith("prov_kill_") && status !== "prov_kill_veto")
    return "Stalled";
  if (
    status.startsWith("fail_") ||
    status.startsWith("vetoed_") ||
    status === "prov_kill_veto"
  )
    return "Failed";
  if (status === "reported") return "In Committee";
  return "Introduced";
}

/** Short reason a bill died, sized for a chip. */
export function deathLabel(reason: DeathReason | null): string {
  switch (reason) {
    case "CONGRESS_ENDED":
      return "Congress ended";
    case "FAILED_VOTE":
      return "Failed vote";
    case "VETOED":
      return "Vetoed";
    case "LONG_SILENCE":
      return "No action >1yr";
    default:
      return "Died";
  }
}

/**
 * Momentum as a short phrase, or null for live tiers, where the stage
 * already says the bill is moving. Same rule as the card's chips: only
 * stalled, dormant and dead add information the stage can't.
 */
export function momentumPhrase(
  tier: MomentumTier | null,
  deathReason: DeathReason | null,
): string | null {
  switch (tier) {
    case "DEAD": {
      const label = deathLabel(deathReason);
      return label === "Died" ? label : `Died (${label})`;
    }
    case "DORMANT":
      return "Dormant";
    case "STALLED":
      return "Stalled";
    default:
      return null;
  }
}

/**
 * One-line status for compact rows: "Introduced · Dormant",
 * "Passed · Died (Congress ended)", "Enacted".
 */
export function billStatusLine(bill: {
  currentStatus: string;
  momentumTier: MomentumTier | null;
  deathReason: DeathReason | null;
}): string {
  const stage = statusLabel(bill.currentStatus ?? "");
  const momentum = momentumPhrase(bill.momentumTier, bill.deathReason);
  return momentum ? `${stage} · ${momentum}` : stage;
}
