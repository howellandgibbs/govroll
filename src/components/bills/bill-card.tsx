"use client";

import Link, { useLinkStatus } from "next/link";
import type { BillSummary, MomentumTier, DeathReason, VoteType } from "@/types";
import { formatJourneyDate, getJourneySteps } from "@/lib/bill-helpers";
import { getTopicForPolicyArea } from "@/lib/topic-mapping";
import { billHref } from "@/lib/bills/url";
import { formatBillNumber } from "@/lib/bill-grouping";
import { pickBillHeadline } from "@/lib/bill-headline";

// Reddit's visited-link cue, translated to Roll Call: a muted title + a
// vote chip that tells you *how* you voted at a glance. Maya/flame are
// fills carrying ink text (the word is mandatory — hue alone is 1.56:1);
// abstain gets the dashed hollow frame, the mark for a recorded absence.
export function voteChipStyle(voteType: VoteType): {
  label: string;
  className: string;
} {
  if (voteType === "For")
    return {
      label: "Voted For",
      className: "bg-vote-for-soft text-ink border-rule",
    };
  if (voteType === "Against")
    return {
      label: "Voted Against",
      className: "bg-vote-against-soft text-ink border-rule",
    };
  return {
    label: "Abstained",
    className: "border-hollow text-ink-muted border-dashed",
  };
}

// Navigation indicator: only renders when this specific Link has been clicked
// and the app is resolving the next route. Next.js 15.3+.
function CardNavIndicator() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <div
      aria-busy="true"
      className="ring-ink/40 pointer-events-none absolute inset-0 ring-2"
    >
      <div className="border-ink/20 border-t-ink/70 absolute top-3 right-4 h-3.5 w-3.5 animate-spin rounded-full border-2" />
    </div>
  );
}

function statusLabel(status: string): string {
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

/**
 * Row-scale route: the bill's journey as a line of 8px dots (existing
 * stage mapping via getJourneySteps — same logic, smaller grammar).
 * Cleared = solid sapphire · current = solid gold (at most one) ·
 * ahead = hollow ring · dead route = ahead style faded to 45%.
 */
export function MiniRoute({
  billType,
  currentStatus,
}: {
  billType: string;
  currentStatus: string;
}) {
  const steps = getJourneySteps(billType, currentStatus);
  const dead = steps.some((s) => s.status === "failed");
  return (
    <span className="flex items-center gap-[3px]" aria-hidden>
      {steps.map((step, i) => {
        let cls: string;
        if (step.status === "completed") cls = "bg-sapphire";
        else if (step.status === "current") cls = "bg-gold";
        else
          cls = `shadow-[inset_0_0_0_1.5px_var(--color-hollow)] ${
            dead ? "opacity-45" : ""
          }`;
        return (
          <span
            key={`${step.label}-${i}`}
            className={`h-2 w-2 rounded-full ${cls}`}
          />
        );
      })}
    </span>
  );
}

function formatSilence(days: number): string {
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function deathLabel(reason: DeathReason | null): string {
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

interface TierTreatment {
  // Applied to the card wrapper. Only the tier-specific tone.
  cardClass: string;
  // Optional chip shown on the meta row. A dead/dormant bill is a route
  // that ended or went quiet — dashed hollow frame, never red.
  momentumChip?: { label: string; className: string };
  // Optional short microcopy about activity, shown on the meta row.
  silenceNote?: string;
}

function tierTreatment(
  tier: MomentumTier | null,
  daysSinceLastAction: number | null,
  deathReason: DeathReason | null,
): TierTreatment {
  const silence =
    daysSinceLastAction != null && daysSinceLastAction > 30
      ? `No action in ${formatSilence(daysSinceLastAction)}`
      : undefined;

  const hollowChip = "border-hollow text-ink-muted border border-dashed";
  const outlineChip = "border-rule text-ink-muted border";

  switch (tier) {
    case "DEAD":
      return {
        cardClass: "opacity-60",
        momentumChip: { label: deathLabel(deathReason), className: hollowChip },
        silenceNote: silence,
      };
    case "DORMANT":
      return {
        cardClass: "opacity-75",
        momentumChip: { label: "Dormant", className: hollowChip },
        silenceNote: silence,
      };
    case "STALLED":
      return {
        cardClass: "",
        momentumChip: { label: "Stalled", className: outlineChip },
        silenceNote: silence,
      };
    // Live tiers get no chip. The right rail's stage label and route dots
    // already say where the bill is; a chip that repeats "it's moving" on
    // every card in the default (live-only) feed is noise, and for a bill
    // that passed a chamber it merely restates the "Passed"/"In Progress"
    // stage. Chips are reserved for the tiers that add information the
    // stage can't: stalled, dormant, dead.
    case "ADVANCING":
    case "ENACTED":
    case "ACTIVE":
    case null:
    default:
      return { cardClass: "" };
  }
}

export function BillCard({
  bill,
  userVote = null,
}: {
  bill: BillSummary;
  userVote?: VoteType | null;
}) {
  const stage = statusLabel(bill.currentStatus);
  const topic = getTopicForPolicyArea(bill.policyArea);
  const displayDate = bill.latestActionDate || bill.introducedDate;
  const treatment = tierTreatment(
    bill.momentumTier,
    bill.daysSinceLastAction,
    bill.deathReason,
  );
  const voteChip = userVote ? voteChipStyle(userVote) : null;
  const headline = pickBillHeadline(bill);
  const billNumber = formatBillNumber(bill.billType, bill.billId);

  const href = billHref(bill);

  // Meta line — "H.R. 5334 · Education · Rep. Panetta · last action Aug 7".
  const metaParts = [
    billNumber,
    topic?.label ?? null,
    bill.sponsor,
    displayDate
      ? `last action ${formatJourneyDate(displayDate, "short")}`
      : null,
  ].filter((p): p is string => Boolean(p));

  return (
    <Link
      href={href}
      className="group focus-visible:ring-gold block transition-transform focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.997]"
    >
      <div
        className={`border-rule bg-paper hover:border-ink/40 relative border px-5 py-4 transition-colors duration-200 ${treatment.cardClass}`}
      >
        <CardNavIndicator />
        {/* Topic line — the line palette's only home: a 5px bar in the
            left margin. Topics beyond the eleven hues get no bar. */}
        {topic?.line && (
          <div
            className={`absolute top-0 bottom-0 left-0 w-[5px] ${topic.line}`}
          />
        )}

        <div className="pl-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3
                className={`line-clamp-2 font-sans text-base leading-snug font-semibold tracking-normal transition-colors ${
                  voteChip ? "text-ink/50 group-hover:text-ink/70" : "text-ink"
                }`}
              >
                {headline.headline}
              </h3>

              {headline.secondary && (
                <p className="text-ink-muted mt-1 line-clamp-1 text-sm leading-relaxed">
                  {headline.secondary}
                </p>
              )}

              {headline.officialTitle && (
                <p
                  className="text-ink-muted/80 mt-1 line-clamp-1 text-xs italic"
                  title={headline.officialTitle}
                >
                  Official title: {headline.officialTitle}
                </p>
              )}

              <div className="text-ink-muted mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] tabular-nums">
                <span className="min-w-0">{metaParts.join(" · ")}</span>
                {treatment.momentumChip && (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-[10.5px] font-bold tracking-[0.08em] uppercase ${treatment.momentumChip.className}`}
                  >
                    {treatment.momentumChip.label}
                  </span>
                )}
                {treatment.silenceNote && (
                  <span className="italic">{treatment.silenceNote}</span>
                )}
              </div>
            </div>

            {/* Right rail — vote chip, then stage label over the row-scale
                route. One saturated element per row: the route's gold dot. */}
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {voteChip && (
                <span
                  className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10.5px] font-bold tracking-[0.08em] uppercase ${voteChip.className}`}
                  title={`You voted ${userVote?.toLowerCase()} on this bill`}
                >
                  <svg
                    className="h-2.5 w-2.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {voteChip.label}
                </span>
              )}
              <div className="flex flex-col items-end gap-1">
                <span className="text-ink-muted text-[10px] font-semibold tracking-[0.14em] uppercase">
                  {stage}
                </span>
                <MiniRoute
                  billType={bill.billType}
                  currentStatus={bill.currentStatus}
                />
              </div>
            </div>
          </div>

          {/* Engagement signals — shown only when there's actual activity */}
          {(bill.commentCount != null && bill.commentCount > 0) ||
          (bill.publicVoteCount != null && bill.publicVoteCount > 0) ? (
            <div className="text-ink-muted mt-2 flex items-center gap-3 text-xs tabular-nums">
              {bill.publicVoteCount != null && bill.publicVoteCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 10v12" />
                    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L15 2a3.13 3.13 0 0 1 3 3.88Z" />
                  </svg>
                  {bill.publicVoteCount.toLocaleString("en-US")}{" "}
                  {bill.publicVoteCount === 1 ? "vote" : "votes"}
                </span>
              )}
              {bill.commentCount != null && bill.commentCount > 0 && (
                // Span with role=button so React doesn't error on nested <a>.
                // Native click bubbles up to the outer Link; we intercept to
                // navigate to #discussion instead.
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.location.href = `${href}#discussion`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      window.location.href = `${href}#discussion`;
                    }
                  }}
                  className="hover:text-ink inline-flex cursor-pointer items-center gap-1 underline-offset-2 transition-colors hover:underline"
                >
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  {bill.commentCount.toLocaleString("en-US")}{" "}
                  {bill.commentCount === 1 ? "comment" : "comments"}
                </span>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
