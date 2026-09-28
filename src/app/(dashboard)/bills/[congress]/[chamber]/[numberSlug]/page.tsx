import { prisma } from "@/lib/prisma";
import { notFound, permanentRedirect } from "next/navigation";
import dayjs from "dayjs";
import {
  getBillTypeInfo,
  getJourneySteps,
  getStatusExplanation,
  getEffectiveStatus,
  buildDynamicJourney,
} from "@/lib/bill-helpers";
import { pickBillHeadline } from "@/lib/bill-headline";
import { BillHero } from "@/components/bills/bill-hero";
import { BillStageSection } from "@/components/bills/bill-stage-section";
import { BillChangeSummary } from "@/components/bills/bill-change-summary";
import { SponsorCard } from "@/components/bills/sponsor-card";
import { BillDetailInteractive } from "./interactive";
import { parseSponsorString, partyCodeToNames } from "@/lib/sponsor";
import { maybeFetchBillTextInBackground } from "@/lib/on-demand-bill-text";
import {
  billHref,
  billReadHref,
  billIdentifierFor,
  parseBillPath,
} from "@/lib/bills/url";
import type { MomentumTier, DeathReason } from "@/types";

type RouteParams = Promise<{
  congress: string;
  chamber: string;
  numberSlug: string;
}>;

async function resolveBill(params: RouteParams) {
  const { congress, chamber, numberSlug } = await params;
  const parsed = parseBillPath([congress, chamber, numberSlug]);
  if (!parsed) return { bill: null, parsed: null } as const;

  const billIdKey = billIdentifierFor(
    parsed.chamberCode,
    parsed.number,
    parsed.congress,
  );
  if (!billIdKey) return { bill: null, parsed } as const;

  const bill = await prisma.bill.findUnique({
    where: { billId: billIdKey },
    select: {
      id: true,
      billId: true,
      title: true,
      shortText: true,
      // Title-fallback fields so generateMetadata renders the same
      // smart headline the page hero shows. Without these the browser
      // tab gets the raw 600-word title for rule resolutions.
      popularTitle: true,
      shortTitle: true,
      displayTitle: true,
      aiShortDescription: true,
    },
  });

  return { bill, parsed } as const;
}

export async function generateMetadata({ params }: { params: RouteParams }) {
  const { bill } = await resolveBill(params);

  // Use the same headline-resolution chain the page hero does — the
  // browser tab and OG title should match what the user sees, not the
  // raw procedural title.
  const headline = bill ? pickBillHeadline(bill).headline : null;
  const title = headline ? `${headline} — Govroll` : "Bill — Govroll";
  const description =
    bill?.shortText ??
    "Track this bill, see how your representatives voted, and share your opinion.";
  const canonical = bill
    ? billHref({ billId: bill.billId, title: bill.title })
    : undefined;

  return {
    title,
    description,
    alternates: canonical ? { canonical } : undefined,
    openGraph: {
      title,
      description,
      siteName: "Govroll",
      type: "article",
      ...(canonical ? { url: canonical } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

const AMENDMENT_PREFIX = /^to\s+amend\b/i;

/**
 * Pick 3 starter prompts tuned to the bill's lifecycle stage. These appear
 * as chips above the AI input on first visit so users don't have to stare
 * at an empty box wondering what to ask.
 */
function suggestedQuestions(
  effectiveStatus: string,
  isAmendmentBill: boolean,
): string[] {
  const isEnacted = effectiveStatus.startsWith("enacted_");
  const isFailed =
    effectiveStatus.startsWith("fail_") ||
    effectiveStatus.startsWith("vetoed_") ||
    effectiveStatus.startsWith("prov_kill_");

  if (isEnacted) {
    return isAmendmentBill
      ? [
          "What does this bill change?",
          "Who would this affect?",
          "When does this take effect?",
        ]
      : [
          "What does this bill actually do?",
          "Who would this affect?",
          "When does this take effect?",
        ];
  }

  if (isFailed) {
    return [
      "What did this bill propose?",
      "Why did it fail?",
      "Has anything similar been reintroduced?",
    ];
  }

  if (isAmendmentBill) {
    return [
      "What does this bill change?",
      "Who supports or opposes it?",
      "What happens next?",
    ];
  }

  return [
    "What does this bill actually do?",
    "Who supports or opposes it?",
    "What happens next?",
  ];
}

export default async function BillDetailPage({
  params,
}: {
  params: RouteParams;
}) {
  const { congress, chamber, numberSlug } = await params;
  const parsed = parseBillPath([congress, chamber, numberSlug]);
  if (!parsed) notFound();

  const billIdKey = billIdentifierFor(
    parsed.chamberCode,
    parsed.number,
    parsed.congress,
  );
  if (!billIdKey) notFound();

  const [bill, actions, textVersions, cosponsorRows] = await Promise.all([
    prisma.bill.findUnique({
      where: { billId: billIdKey },
      // No fullText — page renders metadata only. Skipping it avoids shipping
      // megabytes per page view through the Postgres pooler.
      select: {
        id: true,
        billId: true,
        title: true,
        billType: true,
        currentChamber: true,
        currentStatus: true,
        currentStatusDate: true,
        introducedDate: true,
        link: true,
        shortText: true,
        sponsor: true,
        cosponsorCount: true,
        cosponsorPartySplit: true,
        policyArea: true,
        latestActionText: true,
        latestActionDate: true,
        congressNumber: true,
        momentumTier: true,
        daysSinceLastAction: true,
        deathReason: true,
        popularTitle: true,
        shortTitle: true,
        displayTitle: true,
        aiShortDescription: true,
        aiKeyPoints: true,
        textFetchAttemptedAt: true,
        // Boolean indicator only — never load the actual text on this page.
        _count: {
          select: {
            textVersions: { where: { fullText: { not: null } } },
          },
        },
      },
    }),
    prisma.billAction.findMany({
      where: { bill: { billId: billIdKey } },
      orderBy: { actionDate: "asc" },
      select: { actionDate: true, chamber: true, text: true, actionType: true },
    }),
    prisma.billTextVersion.findMany({
      where: { bill: { billId: billIdKey } },
      orderBy: { versionDate: "asc" },
      select: {
        versionCode: true,
        versionType: true,
        versionDate: true,
        changeSummary: true,
        isSubstantive: true,
      },
    }),
    prisma.billCosponsor.findMany({
      where: { bill: { billId: billIdKey }, withdrawnAt: null },
      orderBy: [{ representative: { lastName: "asc" } }],
      select: {
        representative: {
          select: {
            bioguideId: true,
            slug: true,
            firstName: true,
            lastName: true,
            state: true,
            party: true,
          },
        },
      },
    }),
  ]);
  const cosponsors = cosponsorRows.map((c) => c.representative);

  if (!bill) notFound();

  // Canonicalize the URL: if the request came in via a non-canonical
  // shape (Congress.gov word form, uppercase chamber) or with a slug
  // that doesn't match the current title, 301 to the canonical.
  const canonicalHref = billHref({ billId: bill.billId, title: bill.title });
  const currentPath = `/bills/${congress}/${chamber}/${numberSlug}`;
  if (!parsed.canonical || currentPath !== canonicalHref) {
    permanentRedirect(canonicalHref);
  }

  // If this bill has no text and the cron hasn't tried recently, kick off
  // a background fetch so the user gets text on their next load instead
  // of waiting for the hourly backfill to reach their bill. No-op when
  // text is already present; atomic claim inside prevents N duplicate
  // fetches from N concurrent page loads.
  maybeFetchBillTextInBackground({
    id: bill.id,
    billId: bill.billId,
    hasFullText: bill._count.textVersions > 0,
    textFetchAttemptedAt: bill.textFetchAttemptedAt,
  });

  // Resolve the sponsor to a Representative row so the card can show a
  // real photo + link to the rep's profile. Best-effort — we fall back
  // to a photoless card if the join fails (prior-Congress sponsor, data
  // drift, etc.). Keyed on lastName + state, then narrowed by firstName
  // + party. No `sponsorBioguideId` column yet; this is the v1 parser.
  const parsedSponsor = parseSponsorString(bill.sponsor);
  const sponsorRep = parsedSponsor
    ? await prisma.representative.findFirst({
        where: {
          lastName: parsedSponsor.lastName,
          state: parsedSponsor.state,
          party: { in: partyCodeToNames(parsedSponsor.party) },
          firstName: {
            startsWith: parsedSponsor.firstName,
            mode: "insensitive",
          },
        },
        select: {
          bioguideId: true,
          slug: true,
          firstName: true,
          lastName: true,
        },
      })
    : null;

  const typeInfo = getBillTypeInfo(bill.billType);
  const effectiveStatus = getEffectiveStatus(
    bill.billType,
    bill.currentStatus,
    actions,
    textVersions,
  );
  const journeySteps =
    actions.length > 0
      ? buildDynamicJourney(
          bill.billType,
          bill.currentStatus,
          actions,
          textVersions,
          effectiveStatus,
        )
      : getJourneySteps(bill.billType, effectiveStatus);
  const statusExplanation = getStatusExplanation(
    bill.billType,
    effectiveStatus,
  );
  const isEnacted = effectiveStatus.startsWith("enacted_");
  const isPassed =
    effectiveStatus.startsWith("passed_") ||
    effectiveStatus.startsWith("conference_") ||
    effectiveStatus.startsWith("pass_over_") ||
    effectiveStatus.startsWith("pass_back_");
  const isFailed =
    effectiveStatus.startsWith("fail_") ||
    effectiveStatus.startsWith("vetoed_") ||
    effectiveStatus.startsWith("prov_kill_");

  // "Settled" = no further action expected. Used to drop the "yet" framing
  // on the sponsor card ("no cosponsors yet" reads as still-gathering for
  // bills that are actually done).
  const isSettled = isEnacted || isFailed || bill.momentumTier === "DEAD";

  // Heuristic: title-led detection of pure amendment bills ("To amend the
  // FISA Amendments Act of 2008 to extend…"). Used to swap in amendment-
  // specific starter prompts for the AI panel.
  const isAmendmentBill = AMENDMENT_PREFIX.test(bill.title);

  // Latest substantive version, if the bill has been meaningfully amended
  // past the introduced version. When present, the page renders an AI-
  // generated "what changed" card below the about section; the card lazily
  // kicks off summary generation on first view if we don't have one yet.
  const substantiveVersions = textVersions.filter((v) => v.isSubstantive);
  const latestSubstantiveVersion =
    substantiveVersions.length > 1
      ? substantiveVersions[substantiveVersions.length - 1]
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-8">
      {/* ── Hero: bill citation, smart headline, lead, badges, actions ── */}
      <BillHero
        billDbId={bill.id}
        title={bill.title}
        popularTitle={bill.popularTitle}
        shortTitle={bill.shortTitle}
        displayTitle={bill.displayTitle}
        aiShortDescription={bill.aiShortDescription}
        aiKeyPoints={bill.aiKeyPoints}
        shortText={bill.shortText}
        billType={bill.billType}
        billId={bill.billId}
        congressNumber={bill.congressNumber}
        link={bill.link}
        readerHref={
          textVersions.length > 0
            ? billReadHref({ billId: bill.billId, title: bill.title })
            : null
        }
        introducedDate={dayjs(bill.introducedDate).format("MMM D, YYYY")}
        lastActionDate={
          bill.currentStatusDate && bill.currentStatus !== "introduced"
            ? dayjs(bill.currentStatusDate).format("MMM D, YYYY")
            : null
        }
        typeLabel={typeInfo.label}
        statusHeadline={statusExplanation.headline}
        // Status pill grammar: sapphire-deep fill + paper text = terminal
        // cleared; dashed/faded hollow = died (never red); outline = in
        // progress. Passed-one-chamber is still in progress, so it stays
        // an outline pill — only enactment earns the filled treatment.
        statusStyle={
          isEnacted
            ? "bg-sapphire-deep text-paper border-0"
            : isFailed
              ? "border border-dashed border-hollow bg-transparent text-ink-muted"
              : isPassed
                ? "border border-rule bg-transparent text-ink"
                : "border border-rule bg-transparent text-ink-muted"
        }
        momentumTier={bill.momentumTier as MomentumTier | null}
        daysSinceLastAction={bill.daysSinceLastAction}
        deathReason={bill.deathReason as DeathReason | null}
      />

      {/* ── Legislative stage: stepper + status caption (always visible) ── */}
      <BillStageSection
        steps={journeySteps}
        statusDetail={statusExplanation.detail}
      />

      {/* ── AI-generated change summary (lazy-loaded on demand) ── */}
      {latestSubstantiveVersion && (
        <BillChangeSummary
          billId={bill.id}
          initialVersion={{
            versionCode: latestSubstantiveVersion.versionCode,
            versionType: latestSubstantiveVersion.versionType,
            versionDate: latestSubstantiveVersion.versionDate.toISOString(),
            changeSummary: latestSubstantiveVersion.changeSummary,
          }}
        />
      )}

      {/* ── Who's behind this bill ── */}
      {parsedSponsor && (
        <section aria-label="Bill sponsor" className="space-y-2">
          {/* Kicker in Public Sans — global h2 is Archivo, which never
              renders below 18px. */}
          <h2 className="text-ink-muted font-sans text-[11px] font-bold tracking-[0.18em] uppercase">
            Who introduced this
          </h2>
          <SponsorCard
            sponsor={bill.sponsor}
            rep={sponsorRep}
            cosponsors={cosponsors}
            cosponsorCount={bill.cosponsorCount}
            cosponsorPartySplit={bill.cosponsorPartySplit}
            isSettled={isSettled}
          />
        </section>
      )}

      {/* ── Engagement sections (AI, reps, votes, discussion) ── */}
      <BillDetailInteractive
        billId={bill.id}
        aiSuggestedQuestions={suggestedQuestions(
          effectiveStatus,
          isAmendmentBill,
        )}
      />
    </div>
  );
}
