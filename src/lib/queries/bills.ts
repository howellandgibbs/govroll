import "server-only";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { statusMapping } from "@/lib/status-mapping";
import { type BillCitation } from "@/lib/parse-bill-citation";
import { classifySearch } from "@/lib/bill-search";
import type {
  BillSearchGroup,
  BillSummary,
  ParsedCitationSummary,
} from "@/types";

const LIVE_TIERS = ["ACTIVE", "ADVANCING", "ENACTED"];
const GRAVEYARD_TIERS = ["DEAD"];

export type BillsSortBy = "relevant" | "latest" | "newest";
export type BillsMomentum = "live" | "graveyard" | "all";
export type BillsChamber = "both" | "house" | "senate";

export interface BillsQueryInput {
  page: number;
  limit: number;
  chamber: BillsChamber;
  status: string;
  momentum: BillsMomentum;
  sortBy: BillsSortBy;
  search: string;
  /** Comma-separated policy areas. */
  topic: string;
}

export interface BillsQueryResult {
  total: number;
  page: number;
  pageSize: number;
  bills: BillSummary[];
  /** Bills the momentum filter kept out. Always 0 for keyword search. */
  hiddenByMomentum: number;
  /**
   * Best-match keyword search only: matches per group, so the feed can
   * label its sections before every page has loaded. Null otherwise.
   */
  groupCounts: Record<BillSearchGroup, number> | null;
  citation: ParsedCitationSummary | null;
  exactMatch: BillSummary | null;
}

// Columns pulled from Bill for both the listing and search paths. Keep in
// sync with transformBill below.
const BILL_SELECT = {
  id: true,
  billId: true,
  title: true,
  date: true,
  billType: true,
  currentChamber: true,
  currentStatus: true,
  currentStatusDate: true,
  introducedDate: true,
  link: true,
  shortText: true,
  sponsor: true,
  policyArea: true,
  latestActionText: true,
  latestActionDate: true,
  momentumTier: true,
  momentumScore: true,
  daysSinceLastAction: true,
  deathReason: true,
  popularTitle: true,
  shortTitle: true,
  displayTitle: true,
  _count: {
    select: { publicVotes: true, comments: true },
  },
} as const;

type RawBill = Awaited<
  ReturnType<typeof prisma.bill.findFirst<{ select: typeof BILL_SELECT }>>
>;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function transformBill(b: NonNullable<RawBill>): BillSummary {
  const {
    _count,
    date,
    currentStatusDate,
    introducedDate,
    latestActionDate,
    ...rest
  } = b;
  return {
    ...(rest as unknown as BillSummary),
    date: iso(date)!,
    currentStatusDate: iso(currentStatusDate),
    introducedDate: iso(introducedDate),
    latestActionDate: iso(latestActionDate),
    shortText: b.shortText ? b.shortText.slice(0, 280) : null,
    publicVoteCount: _count.publicVotes,
    commentCount: _count.comments,
  };
}

/**
 * Look up a bill by parsed citation. If the user supplied a Congress we
 * match exactly; otherwise we pick the most recent Congress that has a
 * matching type+number pair.
 */
async function findBillByCitation(
  citation: BillCitation,
): Promise<BillSummary | null> {
  if (citation.congress !== null) {
    const exactId = `${citation.billType}-${citation.number}-${citation.congress}`;
    const bill = await prisma.bill.findUnique({
      where: { billId: exactId },
      select: BILL_SELECT,
    });
    return bill ? transformBill(bill) : null;
  }

  const prefix = `${citation.billType}-${citation.number}-`;
  const matches = await prisma.bill.findMany({
    where: { billId: { startsWith: prefix } },
    orderBy: [
      { congressNumber: { sort: "desc", nulls: "last" } },
      { introducedDate: "desc" },
    ],
    take: 1,
    select: BILL_SELECT,
  });
  return matches[0] ? transformBill(matches[0]) : null;
}

/**
 * Resolve a typed citation ("HR 1234") to its bill. Shared by the /bills
 * jump-to row and the header typeahead, which shows only this match.
 */
export async function lookupBillCitation(citation: BillCitation): Promise<{
  citation: ParsedCitationSummary;
  exactMatch: BillSummary | null;
}> {
  return {
    citation: {
      shortLabel: citation.shortLabel,
      number: citation.number,
      congress: citation.congress,
    },
    exactMatch: await findBillByCitation(citation),
  };
}

/** WHERE fragments for the user-set filters (chamber, status, topic). */
function buildFilterFragments(input: BillsQueryInput): Prisma.Sql[] {
  const { chamber, status, topic } = input;
  const fragments: Prisma.Sql[] = [];

  if (chamber !== "both") {
    fragments.push(Prisma.sql`b."billType" LIKE ${chamber + "%"}`);
  }

  if (status && statusMapping[status]) {
    const values = statusMapping[status];
    fragments.push(Prisma.sql`b."currentStatus" IN (${Prisma.join(values)})`);
  }

  if (topic) {
    const topics = topic.split(",").filter(Boolean);
    if (topics.length > 0) {
      fragments.push(Prisma.sql`b."policyArea" IN (${Prisma.join(topics)})`);
    }
  }

  return fragments;
}

function andJoin(fragments: Prisma.Sql[]): Prisma.Sql {
  if (fragments.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(fragments, " AND ");
}

/**
 * A bill name reduced to what people type: lowercase; periods and
 * apostrophes dropped ("S.A.F.E." → "safe"); other punctuation turned
 * into spaces; and the parts a title carries but people rarely type
 * removed: a leading "the", a trailing year ("of 2025", ", 2024") and a
 * trailing "Act". "The NEST Act", "NEST act" and "NEST Act of 2025" all
 * reduce to "nest".
 *
 * The query and every title column go through this same SQL, so the two
 * sides of a name comparison can't drift apart.
 */
function bareNameSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower((${value})::text),
    '[.''’]', '', 'g'),
    '[^a-z0-9]+', ' ', 'g'),
    '^ ?the ', ''),
    '( of)? (19|20)[0-9]{2} ?$', ''),
    ' act ?$', ''))`;
}

const SEARCH_GROUPS: readonly BillSearchGroup[] = ["name", "live", "inactive"];

/**
 * Keyword search. Weighted full-text search on the tsvector (popular +
 * display = A, short = B, official = C, summary = D), ORed with pg_trgm
 * similarity on the titles for typo tolerance.
 *
 * Search covers every bill, whatever its momentum: the live-only default
 * is a curation for browsing, and applying it here hid the bill someone
 * named (the NEST Act case) while padding the page with live bills that
 * merely shared the word "act". Best-match order puts the curation back
 * as ranking instead:
 *
 *   0. name     — titled exactly what was typed (see bareNameSql), in any
 *                 tier. Only when the query reads like a name
 *                 (hasNameIntent); a topic word like "housing" never pins.
 *   1. live     — the tiers the default feed shows.
 *   2. inactive — stalled, dormant, dead: what the default feed hides.
 *
 * Inside each group: newest Congress first, then relevance. Relevance is
 * ts_rank_cd normalized by document length (flag 1) so a bill about
 * housing outranks an omnibus whose long summary mentions housing forty
 * times.
 *
 * "latest" and "newest" sorts are honored as plain chronological sorts
 * across all matches, without groups.
 */
async function searchBillsPage(
  input: BillsQueryInput,
  search: { text: string; nameIntent: boolean },
): Promise<Omit<BillsQueryResult, "citation" | "exactMatch">> {
  const { page, limit, sortBy } = input;
  const { text, nameIntent } = search;
  const skip = (page - 1) * limit;
  const bestMatch = sortBy === "relevant";

  // websearch_to_tsquery never raises on bad input — safe for the public
  // search box. Tagged-template parameterization keeps it injection-safe.
  //
  // Both query forms are inlined as immutable expressions of the bound
  // parameter, which Postgres folds to constants at plan time. That keeps
  // every branch of the match below an index condition (the tsvector GIN
  // plus a trigram GIN per title column), so the OR plans as a BitmapOr
  // over matching rows instead of a sequential scan of every bill.
  const tsQuery = Prisma.sql`websearch_to_tsquery('english', ${text})`;
  const bareQuery = bareNameSql(Prisma.sql`${text}`);

  // Fuzzy title matching runs on the bare name, not the raw query. Every
  // short "X Act" title shares the "act" trigrams with "NEST act" — enough
  // to clear pg_trgm's 0.3 threshold — so matching the raw query let
  // GHOST Act, FIRST Act and ~200 others in alongside the NEST Act.
  const searchMatchSql = Prisma.sql`(
    b."searchVector" @@ ${tsQuery}
    OR b."popularTitle" % ${bareQuery}
    OR b."shortTitle" % ${bareQuery}
    OR b."displayTitle" % ${bareQuery}
    OR b."title" % ${bareQuery}
  )`;
  const whereSql = andJoin([...buildFilterFragments(input), searchMatchSql]);

  // Multipliers normalize similarity against ts_rank_cd so a strong
  // fuzzy title hit still ranks alongside a good full-text hit.
  // similarity() on NULL returns NULL; COALESCE keeps the GREATEST sane.
  const rankSql = Prisma.sql`GREATEST(
    COALESCE(ts_rank_cd(b."searchVector", ${tsQuery}, 1) * 2.0, 0),
    COALESCE(similarity(b."popularTitle", ${bareQuery}), 0) * 0.9,
    COALESCE(similarity(b."shortTitle", ${bareQuery}), 0) * 0.6,
    COALESCE(similarity(b."displayTitle", ${bareQuery}), 0) * 0.7,
    COALESCE(similarity(b."title", ${bareQuery}), 0) * 0.3
  )`;

  const nameMatchSql = nameIntent
    ? Prisma.sql`(${bareQuery} <> '' AND (
        ${bareNameSql(Prisma.sql`b."popularTitle"`)} = ${bareQuery}
        OR ${bareNameSql(Prisma.sql`b."shortTitle"`)} = ${bareQuery}
        OR ${bareNameSql(Prisma.sql`b."displayTitle"`)} = ${bareQuery}
      ))`
    : Prisma.sql`FALSE`;
  const liveSql = Prisma.sql`b."momentumTier" IN (${Prisma.join(LIVE_TIERS)})`;
  const groupSql = Prisma.sql`CASE
    WHEN ${nameMatchSql} THEN 0
    WHEN ${liveSql} THEN 1
    ELSE 2
  END`;

  // b.id last on every order: OFFSET pagination needs a total order, or
  // tied rows can repeat or vanish between infinite-scroll pages.
  let orderSql: Prisma.Sql;
  if (bestMatch) {
    // The live key only reorders the name group (live is all-live,
    // inactive is all-not): a same-named live bill leads dead ones.
    orderSql = Prisma.sql`grp ASC,
      b."congressNumber" DESC NULLS LAST,
      (${liveSql}) DESC NULLS LAST,
      ${rankSql} DESC,
      b."momentumScore" DESC NULLS LAST,
      b."introducedDate" DESC NULLS LAST,
      b.id DESC`;
  } else if (sortBy === "latest") {
    orderSql = Prisma.sql`b."latestActionDate" DESC NULLS LAST,
      ${rankSql} DESC,
      b.id DESC`;
  } else {
    orderSql = Prisma.sql`b."introducedDate" DESC NULLS LAST,
      ${rankSql} DESC,
      b.id DESC`;
  }

  const [rows, countRows] = await Promise.all([
    prisma.$queryRaw<{ id: number; grp: number }[]>`
      SELECT b.id, ${bestMatch ? groupSql : Prisma.sql`1`} AS grp
      FROM "Bill" b
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      OFFSET ${skip} LIMIT ${limit}
    `,
    bestMatch
      ? prisma.$queryRaw<{ grp: number; count: bigint }[]>`
          SELECT grp, COUNT(*)::bigint AS count
          FROM (
            SELECT ${groupSql} AS grp
            FROM "Bill" b
            WHERE ${whereSql}
          ) matches
          GROUP BY grp
        `
      : prisma.$queryRaw<{ grp: number; count: bigint }[]>`
          SELECT 1 AS grp, COUNT(*)::bigint AS count
          FROM "Bill" b
          WHERE ${whereSql}
        `,
  ]);

  const groupCounts: Record<BillSearchGroup, number> = {
    name: 0,
    live: 0,
    inactive: 0,
  };
  for (const row of countRows) {
    const group = SEARCH_GROUPS[row.grp];
    if (group) groupCounts[group] = Number(row.count);
  }
  const total = groupCounts.name + groupCounts.live + groupCounts.inactive;

  const ids = rows.map((r) => r.id);
  const billRows = ids.length
    ? await prisma.bill.findMany({
        where: { id: { in: ids } },
        select: BILL_SELECT,
      })
    : [];

  const billMap = new Map(billRows.map((b) => [b.id, b] as const));
  const bills: BillSummary[] = [];
  for (const row of rows) {
    const raw = billMap.get(row.id);
    if (!raw) continue;
    const bill = transformBill(raw);
    if (bestMatch) bill.searchGroup = SEARCH_GROUPS[row.grp];
    bills.push(bill);
  }

  return {
    total,
    page,
    pageSize: limit,
    bills,
    hiddenByMomentum: 0,
    groupCounts: bestMatch ? groupCounts : null,
  };
}

/**
 * Plain listing path — no keyword search. Keeps the existing Prisma-native
 * query so ordering by vote/comment counts stays ergonomic.
 */
async function listBillsPage(
  input: BillsQueryInput,
): Promise<Omit<BillsQueryResult, "citation" | "exactMatch">> {
  const { page, limit, chamber, status, momentum, sortBy, topic } = input;
  const skip = (page - 1) * limit;

  const filters: Record<string, unknown> = {};

  if (chamber !== "both") {
    filters.billType = { startsWith: chamber.toLowerCase() };
  }

  if (status && statusMapping[status]) {
    filters.currentStatus = { in: statusMapping[status] };
  }

  if (momentum === "live") {
    filters.momentumTier = { in: LIVE_TIERS };
  } else if (momentum === "graveyard") {
    filters.momentumTier = { in: GRAVEYARD_TIERS };
  }

  if (topic) {
    filters.policyArea = { in: topic.split(",") };
  }

  // id last on every order: OFFSET pagination needs a total order, or
  // tied rows (same score, same day) can repeat or vanish between pages.
  let orderBy: Record<string, unknown>[];
  if (sortBy === "relevant") {
    orderBy = [
      { momentumScore: { sort: "desc", nulls: "last" } },
      { votes: { _count: "desc" } },
      { publicVotes: { _count: "desc" } },
      { comments: { _count: "desc" } },
      { latestActionDate: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ];
  } else if (sortBy === "latest") {
    orderBy = [
      { latestActionDate: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ];
  } else {
    orderBy = [{ introducedDate: "desc" }, { id: "desc" }];
  }

  const filtersAllMomentum = { ...filters };
  delete (filtersAllMomentum as Record<string, unknown>).momentumTier;

  const [total, totalAllMomentum, bills] = await Promise.all([
    prisma.bill.count({ where: filters }),
    momentum === "all"
      ? Promise.resolve(0)
      : prisma.bill.count({ where: filtersAllMomentum }),
    prisma.bill.findMany({
      where: filters,
      skip,
      take: limit,
      orderBy,
      select: BILL_SELECT,
    }),
  ]);

  return {
    total,
    page,
    pageSize: limit,
    bills: bills.map(transformBill),
    hiddenByMomentum:
      momentum === "all" ? 0 : Math.max(0, totalAllMomentum - total),
    groupCounts: null,
  };
}

/**
 * Canonical bill-listing query. Called by `GET /api/bills` (client-side
 * pagination), the Bills page RSC (page-1 prefetch) and `GET /api/search`
 * (the header typeahead's first five rows), so the header and the page
 * can't disagree about what a query finds.
 *
 * Dispatch (see classifySearch):
 *   - citation ("HR 1234", "S.J.Res. 10") → resolve exactMatch, then list
 *     the regular feed (search term dropped) beneath the jump-to row.
 *   - keyword → searchBillsPage, across every momentum tier.
 *   - nothing searchable → plain filter-driven listing.
 */
export async function fetchBillsPage(
  input: BillsQueryInput,
): Promise<BillsQueryResult> {
  const search = classifySearch(input.search);

  if (search.kind === "keyword") {
    const base = await searchBillsPage(input, search);
    return { ...base, citation: null, exactMatch: null };
  }

  // "HR 1234" as a tsvector/similarity search returns nothing useful, so
  // a citation gets the jump-to row plus the normal feed.
  const [base, resolved] = await Promise.all([
    listBillsPage(input),
    search.kind === "citation" ? lookupBillCitation(search.citation) : null,
  ]);

  return {
    ...base,
    citation: resolved?.citation ?? null,
    exactMatch: resolved?.exactMatch ?? null,
  };
}
