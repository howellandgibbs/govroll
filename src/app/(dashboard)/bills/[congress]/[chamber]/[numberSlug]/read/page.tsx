import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";

import { prisma } from "@/lib/prisma";
import { pickBillHeadline } from "@/lib/bill-headline";
import { buildReaderSections } from "@/lib/bills/reader-sections";
import { maybeFetchBillTextInBackground } from "@/lib/on-demand-bill-text";
import { getCurrentCongress } from "@/lib/momentum";
import {
  billReadHref,
  billIdentifierFor,
  parseBillPath,
} from "@/lib/bills/url";

import { BillReader } from "@/components/bills/reader/bill-reader";
import {
  congressOrdinal,
  displayNumberFor,
} from "@/components/bills/reader/reader-header-meta";
import { TextNotAvailable } from "@/components/bills/reader/text-not-available";
import type {
  ReaderVersionListEntry,
  ReaderVersionMeta,
} from "@/components/bills/reader/reader-types";

/**
 * Bill text reader at `/bills/[congress]/[chamber]/[numberSlug]/read`.
 * Sibling to the engagement page at the parent URL — the detail page
 * links to here via a prominent "Read full text →" card. Conversation
 * state is shared with the detail page via the existing per-bill chat
 * API (no extra wiring needed; both pages mount the same `<AiChatbox>`).
 */

// `loading.tsx` was intentionally omitted from this route. When a sibling
// `loading.tsx` is present, Next.js wraps this page in a Suspense boundary
// that swallows the redirect thrown by `permanentRedirect` during the
// non-canonical URL check below — the request ends up returning 200 with
// the page body instead of a 308 (and `notFound()` would lose its 404).
// Cold SSR without a loading skeleton is fast enough here that the UX cost
// is marginal; keeping the redirects working on the reader route matters
// more for SEO.
//
// Rendered per request — deliberately NOT ISR. This route used to be
// on-demand ISR (1h revalidate), which on Vercel writes every freshly
// rendered page to durable storage — the full bill text twice (HTML + RSC
// payload) — and each deploy starts a fresh ISR cache. Crawlers sweeping
// ~43k reader pages therefore re-spent the Hobby plan's whole monthly ISR
// write budget after every deploy (100% alerts in Aug and Sep 2026). With
// ~90% of reader hits being MISS/STALE renders anyway (crawler traffic
// rarely repeats a page), rendering per request costs little extra CPU and
// takes ISR writes off the table. Supabase Pro's egress allowance absorbs
// the fullText reads that the ISR cache used to spare.
export const dynamic = "force-dynamic";

type RouteParams = Promise<{
  congress: string;
  chamber: string;
  numberSlug: string;
}>;

// ─────────────────────────────────────────────────────────────────────────
//  Metadata (SEO — the reader is the SEO play)
// ─────────────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: RouteParams;
}): Promise<Metadata> {
  const { congress, chamber, numberSlug } = await params;
  const parsed = parseBillPath([congress, chamber, numberSlug]);
  if (!parsed) return { title: "Bill not found — Govroll" };

  const billIdKey = billIdentifierFor(
    parsed.chamberCode,
    parsed.number,
    parsed.congress,
  );
  if (!billIdKey) return { title: "Bill not found — Govroll" };

  const bill = await prisma.bill.findUnique({
    where: { billId: billIdKey },
    select: {
      billId: true,
      title: true,
      shortText: true,
      // Title-fallback fields so the browser tab on the reader matches
      // the headline the user sees, not the raw 600-word title.
      popularTitle: true,
      shortTitle: true,
      displayTitle: true,
      aiShortDescription: true,
    },
  });

  if (!bill) {
    return { title: "Bill not found — Govroll" };
  }

  const headline = pickBillHeadline(bill).headline;
  const title = `${headline} — Full text — Govroll`;
  const description =
    bill.shortText?.slice(0, 200) ??
    `Read the full text of ${headline} with plain-English section captions and AI explanations.`;
  const canonical = billReadHref({ billId: bill.billId, title: bill.title });

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      siteName: "Govroll",
      type: "article",
      url: canonical,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  Page
// ─────────────────────────────────────────────────────────────────────────

export default async function BillReaderPage({
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

  // Three parallel queries — bill metadata, the latest text-bearing
  // version we'll render, and the slim version list for the picker. We
  // keep the picker list separate so we don't pay for every version's
  // `fullText` just to render the dropdown labels.
  //
  // Bill.fullText is intentionally omitted from the bill query: the
  // text-bearing payload comes from BillTextVersion, and the legacy
  // path that still uses Bill.fullText fetches it lazily below.
  //
  // We always render the *latest* version. Older versions load
  // client-side in <BillReader> via `?v=` (a holdover from when this route
  // was ISR-cached and couldn't read searchParams). The `id` desc tiebreak
  // keeps "latest" deterministic when two versions share a versionDate.
  const renderVersionQuery = prisma.billTextVersion.findFirst({
    where: { bill: { billId: billIdKey }, fullText: { not: null } },
    orderBy: [{ versionDate: "desc" }, { id: "desc" }],
    select: {
      id: true,
      versionCode: true,
      versionType: true,
      versionDate: true,
      fullText: true,
      sectionCaptions: true,
      isSubstantive: true,
    },
  });

  const [bill, renderVersion, pickerVersions] = await Promise.all([
    prisma.bill.findUnique({
      where: { billId: billIdKey },
      select: {
        id: true,
        billId: true,
        title: true,
        billType: true,
        link: true,
        textFetchAttemptedAt: true,
        currentStatus: true,
        sponsor: true,
        // Title-fallback fields for pickBillHeadline. The reader's H1,
        // sticky breadcrumb, and "text not yet available" page all use
        // the resolved headline rather than the raw title.
        shortText: true,
        popularTitle: true,
        shortTitle: true,
        displayTitle: true,
        aiShortDescription: true,
      },
    }),
    renderVersionQuery,
    prisma.billTextVersion.findMany({
      where: {
        bill: { billId: billIdKey },
        fullText: { not: null },
      },
      orderBy: { versionDate: "asc" },
      select: {
        versionCode: true,
        versionType: true,
        versionDate: true,
        isSubstantive: true,
      },
    }),
  ]);

  const latestVersion = renderVersion;

  if (!bill) notFound();

  // Resolve the display headline once — used by the reader header, the
  // sticky breadcrumb, and the "text not yet available" fallback. All
  // of these previously rendered the raw title, which for rule
  // resolutions could run several hundred words.
  const headline = pickBillHeadline(bill).headline;

  // Canonicalize the URL.
  const canonicalReadHref = billReadHref({
    billId: bill.billId,
    title: bill.title,
  });
  const currentPath = `/bills/${congress}/${chamber}/${numberSlug}/read`;
  if (!parsed.canonical || currentPath !== canonicalReadHref) {
    permanentRedirect(canonicalReadHref);
  }

  // Resolve renderable text. Common path: latestVersion has it. Rare
  // legacy path: no BillTextVersion row but Bill.fullText is populated
  // (bills ingested before the version model existed). Pay the extra
  // round trip only on that rare path so common visits stay cheap.
  let renderableText: string | null = latestVersion?.fullText ?? null;
  if (!renderableText) {
    const legacyText = await prisma.bill.findUnique({
      where: { id: bill.id },
      select: { fullText: true },
    });
    renderableText = legacyText?.fullText ?? null;
  }

  if (!renderableText) {
    // A bill from an ended Congress with no text by now won't get any
    // (pre-2003 bills have no machine-readable text at all). 404 so crawlers
    // drop the URL instead of re-requesting an empty page; notFound() also
    // injects `noindex`. The detail page never links here without text.
    if (parsed.congress < getCurrentCongress()) notFound();

    // Only this rare no-text path needs the version count, so compute it
    // here with a cheap targeted COUNT. Previously this rode along as a
    // `_count` aggregate on the main bill query above, which scanned the
    // BillTextVersion table on every single reader render (~16% of DB time).
    const textVersionsWithText = await prisma.billTextVersion.count({
      where: { billId: bill.id, fullText: { not: null } },
    });
    maybeFetchBillTextInBackground({
      id: bill.id,
      billId: bill.billId,
      hasFullText: textVersionsWithText > 0,
      textFetchAttemptedAt: bill.textFetchAttemptedAt,
    });
    return <TextNotAvailable bill={{ ...bill, headline }} />;
  }

  const sections = buildReaderSections(
    renderableText,
    latestVersion?.sectionCaptions ?? null,
  );
  if (sections.length === 0) {
    return <TextNotAvailable bill={{ ...bill, headline }} />;
  }

  // Build the version meta passed to the shell. If the only text we
  // have is the legacy Bill.fullText, synthesize a minimal version
  // record so the header doesn't crash.
  const versionMeta: ReaderVersionMeta = latestVersion
    ? {
        id: latestVersion.id,
        versionCode: latestVersion.versionCode,
        versionType: latestVersion.versionType,
        versionDate: latestVersion.versionDate,
        isSubstantive: latestVersion.isSubstantive,
      }
    : {
        id: -1,
        versionCode: "legacy",
        versionType: "Bill text",
        versionDate: new Date(),
        isSubstantive: true,
      };

  // The picker shows only text-bearing, substantive versions — showing
  // a dropdown entry for a procedural-duplicate or text-less version
  // is worse than hiding the option.
  const availableVersions: ReaderVersionListEntry[] = pickerVersions
    .filter((v) => v.isSubstantive !== false)
    .map((v) => ({
      versionCode: v.versionCode,
      versionType: v.versionType,
      versionDate: v.versionDate,
    }));

  const detailHref = canonicalReadHref.replace(/\/read$/, "");

  return (
    <BillReader
      bill={{
        id: bill.id,
        billId: bill.billId,
        title: bill.title,
        headline,
        billType: bill.billType,
        govtrackUrl: bill.link ?? null,
        currentStatus: bill.currentStatus,
        sponsor: bill.sponsor,
        displayNumber: displayNumberFor(bill.billType, parsed.number),
        congressLabel: congressOrdinal(parsed.congress),
        detailHref,
      }}
      initialVersion={versionMeta}
      availableVersions={availableVersions}
      initialSections={sections}
      latestVersionCode={versionMeta.versionCode}
    />
  );
}
