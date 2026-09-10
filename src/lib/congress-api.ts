import axios from "axios";
import dayjs from "dayjs";
import { parseStringPromise } from "xml2js";
import { BillXmlParser, type ParsedChunk } from "./bill-xml-parser";
import { reportError } from "./error-reporting";

const CONGRESS_API_KEY = process.env.CONGRESS_DOT_GOV_API_KEY || "DEMO_KEY";

// A missing key silently degrades the ENTIRE congress.gov-backed pipeline to
// DEMO_KEY's 30 req/hr ceiling — every bill-text / actions / cosponsor cron
// starves, and the throttling surfaces as "no data" rather than as the
// misconfiguration it is. We deliberately do NOT hard-throw: this module is
// imported by the user-facing AI chat route, and crashing that is worse than
// degraded ingest. Instead make the misconfiguration loud — log once and fire
// a single (deduped, rate-limited) alert at module load.
if (!process.env.CONGRESS_DOT_GOV_API_KEY) {
  console.error(
    "CONGRESS_DOT_GOV_API_KEY is not set — falling back to DEMO_KEY (30 req/hr). " +
      "The legislative ingest pipeline will be severely rate-limited.",
  );
  void reportError(
    new Error(
      "CONGRESS_DOT_GOV_API_KEY missing — congress.gov calls fall back to DEMO_KEY (30 req/hr)",
    ),
    { context: "congress-api: missing API key" },
  ).catch(() => {});
}

/**
 * True when an error is a congress.gov rate-limit / quota rejection (HTTP 429).
 *
 * Callers use this to distinguish "we're throttled" from "no data exists." The
 * latter is a legitimate empty result; the former must NOT be laundered into an
 * empty array/null, because downstream code treats empty results as a
 * successful "attempt" and then drops the bill into a multi-day cooldown — so a
 * transient quota outage gets baked in as permanent "no data."
 */
export function isQuotaError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

/**
 * True when an error is a TRANSIENT upstream failure from congress.gov — one
 * expected to clear on its own, so the right response is to stop the run cleanly
 * and resume next cron tick rather than page. Three families:
 *   - 429 — quota exhaustion (also `isQuotaError`).
 *   - 5xx — origin or edge briefly unhealthy. congress.gov sits behind
 *     Cloudflare, which adds its own 520-526 ("unknown error" / "origin
 *     unreachable") on top of the usual 500/502/503/504.
 *   - no response — a network drop (DNS, connection reset, socket timeout)
 *     before any HTTP status came back.
 *
 * Excluded (these must still surface): a deadline abort (axios cancel — the
 * caller handles that as a timeout), a non-429 4xx (a malformed request won't
 * fix itself on retry), and any non-axios error (a real bug in our code).
 */
export function isTransientCongressError(error: unknown): boolean {
  if (axios.isCancel(error)) return false;
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true; // network-level failure, no HTTP status
  const status = error.response.status;
  return status === 429 || status >= 500;
}

/**
 * The classifier above is upstream-agnostic — it inspects the axios error
 * shape, not the host — so the GovTrack crons (fetch-votes,
 * fetch-representatives) use it under this name. Same three families: a
 * GovTrack 5xx, a 429, or a network drop (the "timeout of 15000ms exceeded" /
 * "socket hang up" / ECONNRESET class that paged fetch-votes 1-3×/day).
 */
export const isTransientUpstreamError = isTransientCongressError;

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 *  Returns null when the header is absent or unparseable. */
function parseRetryAfterMs(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  const headers = error.response?.headers as
    | Record<string, unknown>
    | undefined;
  const raw = headers?.["retry-after"];
  if (raw == null) return null;
  const asString = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const seconds = Number(asString);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = dayjs(asString).valueOf();
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// We won't hold a cron function open longer than this waiting on a backoff.
// Beyond it, propagate the error so the run ends cleanly and the next
// scheduled invocation resumes — the alternative is burning the (≤60s)
// function budget sleeping on a near-certain repeat 429.
const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Retry wrapper with exponential backoff for transient API failures. Honors a
 * server-sent Retry-After on 429s (capped at MAX_RETRY_DELAY_MS; bails when the
 * server asks for longer). Used by cron pipeline calls — not user-facing
 * requests.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 1000,
): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      // Cancellations from a caller's AbortSignal must not retry — the signal
      // is already aborted, every retry would just throw again after eating
      // delayMs of wall clock. Bail immediately.
      if (axios.isCancel(e)) throw e;
      if (i === retries) throw e;

      // On a 429, prefer the server's Retry-After. If it's longer than we're
      // willing to hold the function open, stop retrying now and let the
      // error propagate — a near-certain repeat 429 isn't worth the budget.
      const retryAfterMs = parseRetryAfterMs(e);
      if (retryAfterMs != null && retryAfterMs > MAX_RETRY_DELAY_MS) throw e;

      // Exponential backoff (1s, 2s, 4s, …) capped at MAX_RETRY_DELAY_MS,
      // overridden by Retry-After when the server supplied a usable one.
      const backoffMs = Math.min(delayMs * 2 ** i, MAX_RETRY_DELAY_MS);
      await new Promise((r) => setTimeout(r, retryAfterMs ?? backoffMs));
    }
  }
  throw new Error("unreachable");
}

const congressApiClient = axios.create({
  baseURL: "https://api.congress.gov/v3",
  timeout: 15_000,
  headers: { "User-Agent": "Govroll/1.0 (civic transparency platform)" },
  // format=json is required — the API defaults to XML when omitted, which silently
  // breaks every JSON-shaped response handler in this file.
  params: { api_key: CONGRESS_API_KEY, format: "json" },
});

export interface TextVersionMeta {
  date: string | null;
  type: string;
  formats: { type: string; url: string }[];
}

interface TextVersion {
  date: string;
  formats: { type: string; url: string }[];
}

/**
 * Fetch ALL text versions of a bill from congress.gov.
 * Returns versions sorted oldest-first.
 */
export async function fetchAllTextVersions(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<TextVersionMeta[]> {
  try {
    const response = await withRetry(() =>
      congressApiClient.get(
        `/bill/${congress}/${apiBillType}/${billNumber}/text`,
      ),
    );

    const versions = response.data?.textVersions as TextVersionMeta[];
    if (!Array.isArray(versions)) return [];

    // Sort oldest-first by date (null dates go last)
    return [...versions].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return dayjs(a.date).valueOf() - dayjs(b.date).valueOf();
    });
  } catch (error: unknown) {
    // Don't launder a quota rejection into "no versions" — that would record a
    // false attempt and cool the bill down for days. Let it propagate.
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch all text versions:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Fetch the latest text version of a bill from congress.gov.
 */
export async function fetchLatestTextVersion(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<TextVersion | null> {
  try {
    const response = await withRetry(() =>
      congressApiClient.get(
        `/bill/${congress}/${apiBillType}/${billNumber}/text`,
      ),
    );

    const textVersions = response.data?.textVersions as TextVersion[];
    if (!textVersions || textVersions.length === 0) return null;

    const sorted = textVersions
      .filter((tv) => !!tv.date)
      .sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf());

    return sorted.length > 0 ? sorted[0] : textVersions[0];
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch text versions:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Download the Formatted XML and Formatted Text for a bill.
 */
export async function downloadTextFormats(
  latestVersion: TextVersion,
  billId: string,
): Promise<{ rawXml: string | null; rawText: string | null }> {
  const xmlFormat = latestVersion.formats.find(
    (fmt) => fmt.type === "Formatted XML",
  );
  const textFormat = latestVersion.formats.find(
    (fmt) => fmt.type === "Formatted Text",
  );

  if (!xmlFormat?.url) {
    console.warn(`No Formatted XML URL found for ${billId}`);
    return { rawXml: null, rawText: null };
  }

  try {
    const { data: rawXml } = await axios.get(xmlFormat.url, {
      timeout: 15_000,
    });
    let rawText: string | null = null;
    if (textFormat?.url) {
      const { data } = await axios.get(textFormat.url, { timeout: 15_000 });
      rawText = typeof data === "string" ? data : null;
    }
    return {
      rawXml: typeof rawXml === "string" ? rawXml : null,
      rawText,
    };
  } catch (error: unknown) {
    console.error(
      `Error downloading text for ${billId}:`,
      error instanceof Error ? error.message : error,
    );
    return { rawXml: null, rawText: null };
  }
}

/**
 * Fetch legislative actions for a bill from congress.gov.
 * Returns actions sorted newest-first.
 */
export interface CongressAction {
  actionDate: string;
  text: string;
  type: string | null;
  chamber: string | null; // "Senate" | "House" | null
}

export async function fetchBillActions(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<CongressAction[] | null> {
  try {
    const raw = await fetchAllPages<Record<string, unknown>>(
      `/bill/${congress}/${apiBillType}/${billNumber}/actions`,
      "actions",
    );
    if (raw === null) return null;

    return raw.map((a) => {
      const actionDate = typeof a.actionDate === "string" ? a.actionDate : "";
      const text = typeof a.text === "string" ? a.text : "";
      const type = typeof a.type === "string" ? a.type : null;
      const sourceName =
        typeof (a.sourceSystem as { name?: unknown })?.name === "string"
          ? (a.sourceSystem as { name: string }).name
          : "";
      const chamber: string | null =
        sourceName === "Senate"
          ? "Senate"
          : sourceName.includes("House")
            ? "House"
            : null;
      return { actionDate, text, type, chamber };
    });
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch bill actions:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Fetch every page of a Congress.gov list endpoint by following the
 * `pagination.next` link (or incrementing offset when next is absent).
 * Caps total rows so a runaway response doesn't blow out memory.
 * Returns whatever was collected when a mid-sequence page fails — partial
 * data beats no data for cosponsor/action enrichment.
 */
const PAGE_LIMIT = 250;
const MAX_PAGES = 20; // 5,000 rows max per resource — way above anything Congress publishes.

async function fetchAllPages<T>(
  path: string,
  arrayKey: string,
  signal?: AbortSignal,
): Promise<T[] | null> {
  const collected: T[] = [];
  let offset = 0;
  let shapeOk = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res;
    try {
      res = await withRetry(() =>
        congressApiClient.get(path, {
          params: { limit: PAGE_LIMIT, offset },
          signal,
        }),
      );
    } catch (err) {
      // Bail with partial data if a mid-sequence page fails — calling code
      // already tolerates empty results, and we've at least captured the
      // pages we successfully fetched before the failure.
      if (page === 0) throw err;
      break;
    }

    const arr = res.data?.[arrayKey];
    if (!Array.isArray(arr)) {
      return shapeOk ? collected : null;
    }
    shapeOk = true;
    collected.push(...(arr as T[]));

    // Stop when the server returns fewer than a full page — there can't be more.
    if (arr.length < PAGE_LIMIT) break;

    const nextUrl: unknown = res.data?.pagination?.next;
    if (typeof nextUrl !== "string" || nextUrl.length === 0) break;
    offset += PAGE_LIMIT;
  }

  return collected;
}

/**
 * Fetch the official title for a bill from Congress.gov.
 * Used to cross-check titles against GovTrack, which has been observed
 * to return wrong titles for some bill IDs.
 */
export async function fetchOfficialBillTitle(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<string | null> {
  try {
    const response = await withRetry(() =>
      congressApiClient.get(`/bill/${congress}/${apiBillType}/${billNumber}`),
    );
    return response.data?.bill?.title || null;
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch official bill title:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Bill metadata for AI chat context — sponsor, cosponsors, status, latest action.
 *
 * The "core" fields (sponsor, cosponsorCount, …, shortText) are also populated
 * by `fetchBillMetadata` below for the refresh cron's write path.
 *
 * The optional "extended" fields (billType, chamber, introducedDate,
 * currentStatus, actions, cosponsors) are populated only at read time in the
 * chat route from our own DB, where they always exist. They give the AI more
 * factual anchors on tier-2/tier-3 bills where no text is available, so
 * questions like "when was it introduced?" or "who co-sponsored it?" get a
 * direct answer instead of a disclaimer.
 */
export interface BillMetadata {
  sponsor: string | null; // "Sen. Rick Scott (R-FL)"
  /** bioguideId of the sponsor when Congress.gov provides one. Used to
   * link the sponsor to a specific Representative row so the rep card
   * can surface "Sponsored this bill". */
  sponsorBioguideId: string | null;
  cosponsorCount: number | null;
  cosponsorPartySplit: string | null; // "5 D, 3 R"
  policyArea: string | null;
  latestActionDate: string | null;
  latestActionText: string | null;
  /** Plain-text CRS summary, most recent version. Null if none published. */
  shortText: string | null;
  /** Colloquial name — "CHIPS Act", "Inflation Reduction Act". Null if none. */
  popularTitle: string | null;
  /** Title Congress.gov's UI displays. Often same as official, sometimes shorter. */
  displayTitle: string | null;
  /** Short title — prefers enacted form over introduced. */
  shortTitle: string | null;
  /** Short bill-type code, e.g. "HR", "S", "HJRES". */
  billType?: string | null;
  /** Originating chamber, e.g. "House" or "Senate". */
  chamber?: string | null;
  /** ISO date (YYYY-MM-DD) the bill was introduced. */
  introducedDate?: string | null;
  /** Current status string, e.g. "Introduced", "Passed House". */
  currentStatus?: string | null;
  /** Compact chronological action timeline, oldest-first. */
  actions?: { date: string; text: string }[];
  /**
   * Representative cosponsor sample — "Rep. Jane Doe (D-CA)" strings. Capped
   * so an omnibus bill with hundreds of cosponsors doesn't blow the prompt;
   * the count + party-split stays authoritative for totals.
   */
  cosponsors?: string[];
}

/**
 * Title variants fetched from Congress.gov's /titles endpoint.
 *
 * Congress.gov returns a titles[] array where each entry is typed via
 * titleTypeCode. We care about:
 *   30 — Popular Title (colloquial, what users type)
 *   45 — Display Title (what Congress.gov shows in their UI)
 *   19 — Short Title as Enacted
 *   14 — Short Title as Introduced
 *
 * Any of these can be null: not every bill has a popular or display title.
 */
export interface BillTitles {
  popularTitle: string | null;
  displayTitle: string | null;
  shortTitle: string | null;
}

interface CongressTitle {
  titleType?: string;
  titleTypeCode?: number;
  title?: string;
  updateDate?: string;
}

/** Pick the most-recently-updated title from a filtered subset. */
function pickLatestTitle(titles: CongressTitle[]): string | null {
  if (titles.length === 0) return null;
  const sorted = [...titles].sort((a, b) =>
    (b.updateDate ?? "").localeCompare(a.updateDate ?? ""),
  );
  const t = sorted[0].title?.trim();
  return t || null;
}

export async function fetchBillTitles(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<BillTitles | null> {
  try {
    const res = await withRetry(() =>
      congressApiClient.get(
        `/bill/${congress}/${apiBillType}/${billNumber}/titles`,
      ),
    );
    const raw: CongressTitle[] = Array.isArray(res.data?.titles)
      ? res.data.titles
      : [];
    if (raw.length === 0)
      return { popularTitle: null, displayTitle: null, shortTitle: null };

    const popularTitle = pickLatestTitle(
      raw.filter((t) => t.titleTypeCode === 30),
    );
    const displayTitle = pickLatestTitle(
      raw.filter((t) => t.titleTypeCode === 45),
    );
    // Prefer enacted short title (code 19) when it exists; fall back to
    // introduced (code 14). Enacted titles are authoritative for law.
    const shortTitleEnacted = pickLatestTitle(
      raw.filter((t) => t.titleTypeCode === 19),
    );
    const shortTitle =
      shortTitleEnacted ??
      pickLatestTitle(raw.filter((t) => t.titleTypeCode === 14));

    return { popularTitle, displayTitle, shortTitle };
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch bill titles:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Individual cosponsor record from Congress.gov, keyed by bioguideId for
 * joining to our Representative table. Includes the signals we care about
 * beyond the count: when they signed on, whether they were original
 * cosponsors (signed at introduction), and whether they later withdrew.
 */
export interface BillCosponsorRecord {
  bioguideId: string;
  firstName: string | null;
  lastName: string | null;
  party: string | null;
  state: string | null;
  district: number | null;
  sponsorshipDate: string | null;
  sponsorshipWithdrawnDate: string | null;
  isOriginalCosponsor: boolean;
}

/**
 * Fetch every individual cosponsor for a bill from Congress.gov, paginating
 * past the 250-per-request ceiling. Returns whatever was successfully
 * collected on mid-sequence failure; returns an empty array on full failure —
 * this is a supplementary signal, not core metadata.
 */
export async function fetchBillCosponsors(
  congress: number,
  apiBillType: string,
  billNumber: number,
  signal?: AbortSignal,
): Promise<BillCosponsorRecord[]> {
  try {
    const raw = await fetchAllPages<Record<string, unknown>>(
      `/bill/${congress}/${apiBillType}/${billNumber}/cosponsors`,
      "cosponsors",
      signal,
    );
    if (raw === null) return [];
    return raw
      .map((c) => {
        const bioguideId =
          typeof c.bioguideId === "string" ? c.bioguideId : null;
        if (!bioguideId) return null;
        return {
          bioguideId,
          firstName: typeof c.firstName === "string" ? c.firstName : null,
          lastName: typeof c.lastName === "string" ? c.lastName : null,
          party: typeof c.party === "string" ? c.party : null,
          state: typeof c.state === "string" ? c.state : null,
          district: typeof c.district === "number" ? c.district : null,
          sponsorshipDate:
            typeof c.sponsorshipDate === "string" ? c.sponsorshipDate : null,
          sponsorshipWithdrawnDate:
            typeof c.sponsorshipWithdrawnDate === "string"
              ? c.sponsorshipWithdrawnDate
              : null,
          isOriginalCosponsor: c.isOriginalCosponsor === true,
        } satisfies BillCosponsorRecord;
      })
      .filter((c): c is BillCosponsorRecord => c !== null);
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch bill cosponsors:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Extract plain text from Congress.gov summary HTML.
 * Summaries come wrapped in `<p>` tags with inline markup; strip it all for
 * display on the bills listing card.
 *
 * Congress.gov summaries conventionally start with the bill's popular name
 * wrapped as `<p><strong>Popular Bill Name</strong></p>` before the actual
 * summary body. On the bill detail page the displayed title is often the
 * same text, causing a visible duplicate. Strip that leading header if
 * present so the summary begins with the body ("This bill...").
 */
function stripHtml(html: string): string {
  const withoutLeadingHeader = html.replace(
    /^\s*<p>\s*<(?:strong|b)>[^<]+<\/(?:strong|b)>\s*<\/p>\s*/i,
    "",
  );
  return withoutLeadingHeader
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch the most recent CRS summary for a bill from Congress.gov.
 * Summaries are non-partisan plain-language abstracts written by the
 * Congressional Research Service. Returns null if none published yet
 * (CRS coverage is incomplete — newly introduced bills often lack summaries).
 */
async function fetchBillSummary(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<string | null> {
  try {
    const res = await withRetry(() =>
      congressApiClient.get(
        `/bill/${congress}/${apiBillType}/${billNumber}/summaries`,
      ),
    );
    const summaries: Array<{
      text?: string;
      updateDate?: string;
      actionDate?: string;
    }> = res.data?.summaries ?? [];
    if (summaries.length === 0) return null;

    // Pick the most recent summary by updateDate (falls back to actionDate).
    const sorted = [...summaries].sort((a, b) => {
      const aDate = a.updateDate || a.actionDate || "";
      const bDate = b.updateDate || b.actionDate || "";
      return bDate.localeCompare(aDate);
    });
    const latest = sorted[0];
    if (!latest.text) return null;

    const plain = stripHtml(latest.text);
    return plain || null;
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    return null;
  }
}

/**
 * One bill record from Congress.gov's `/bill?fromDateTime=...&toDateTime=...`
 * list endpoint — the source of truth for "what's changed in Congress lately."
 * Same shape regardless of whether the bill is newly introduced or just had
 * an action; consumers branch on whether the billId already exists.
 *
 * `type` arrives uppercase (HR, S, HJRES, HCONRES, …); map it to the
 * GovTrack-shape billType (house_bill, senate_bill, …) via parse-bill-id's
 * BILL_TYPE_MAP before constructing a billId.
 */
export interface CongressListBill {
  congress: number;
  number: string;
  type: string;
  originChamber?: string;
  originChamberCode?: string;
  title: string;
  updateDate: string;
  latestAction?: { actionDate?: string; text?: string };
  url?: string;
}

/**
 * Fetch every bill whose Congress.gov `updateDate` falls in `[from, to)`.
 *
 * Walks pagination with the same 250-row page size used elsewhere in this
 * file. Sorts ascending by updateDate so callers iterating windows resume
 * deterministically from a saved cursor. Caps at MAX_PAGES rows to avoid
 * runaway memory if Congress.gov ever returns a non-paginating response.
 *
 * The `updateDate` filter (rather than `introducedDate`) is deliberate:
 * Congress.gov surfaces a bill in this feed whenever ANY field changes —
 * introduction, committee action, vote, status — which is exactly the
 * signal we want for keeping our row in sync.
 */
export async function fetchCongressBillsByUpdate(params: {
  fromDateTime: string;
  toDateTime: string;
  signal?: AbortSignal;
}): Promise<CongressListBill[]> {
  const collected: CongressListBill[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await withRetry(() =>
      congressApiClient.get("/bill", {
        params: {
          fromDateTime: params.fromDateTime,
          toDateTime: params.toDateTime,
          sort: "updateDate+asc",
          limit: PAGE_LIMIT,
          offset,
        },
        signal: params.signal,
      }),
    );

    const arr = res.data?.bills;
    if (!Array.isArray(arr)) break;
    collected.push(...(arr as CongressListBill[]));

    if (arr.length < PAGE_LIMIT) break;
    const next: unknown = res.data?.pagination?.next;
    if (typeof next !== "string" || next.length === 0) break;
    offset += PAGE_LIMIT;
  }

  return collected;
}

/**
 * Lean fetch — returns just `introducedDate` from Congress.gov's
 * `/bill/{congress}/{type}/{number}` endpoint. The list endpoint we use
 * for ingestion (`fetchCongressBillsByUpdate`) omits introducedDate; we
 * need it on the CREATE path to satisfy the NOT NULL column on Bill.
 *
 * Returns `null` on missing field or network error so callers can fall
 * back to a reasonable substitute (e.g. latestAction.actionDate) rather
 * than failing the whole ingest run.
 */
export async function fetchBillIntroducedDate(
  congress: number,
  apiBillType: string,
  billNumber: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await withRetry(() =>
      congressApiClient.get(`/bill/${congress}/${apiBillType}/${billNumber}`, {
        signal,
      }),
    );
    const v = res.data?.bill?.introducedDate;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    return null;
  }
}

/**
 * Lean fetch — returns just the sponsor's bioguideId from Congress.gov
 * by hitting the `/bill/{congress}/{type}/{number}` endpoint exactly
 * once. Used by the sponsorBioguideId backfill, which doesn't want to
 * pay the cost (or risk overwriting fresher fields) of a full
 * `fetchBillMetadata` call.
 *
 * Returns:
 * - the bioguideId string when Congress.gov has a sponsor with one,
 * - `null` when the bill exists but has no sponsor / no bioguideId,
 * - throws on network errors so the caller can retry / log.
 */
export async function fetchBillSponsorBioguideId(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<string | null> {
  const res = await withRetry(() =>
    congressApiClient.get(`/bill/${congress}/${apiBillType}/${billNumber}`),
  );
  const sponsorItem = Array.isArray(res.data?.bill?.sponsors)
    ? res.data.bill.sponsors[0]
    : null;
  if (!sponsorItem) return null;
  return typeof sponsorItem.bioguideId === "string"
    ? sponsorItem.bioguideId
    : null;
}

export async function fetchBillMetadata(
  congress: number,
  apiBillType: string,
  billNumber: number,
): Promise<BillMetadata | null> {
  try {
    const [billRes, cosponsorList, summary, titles] = await Promise.all([
      withRetry(() =>
        congressApiClient.get(`/bill/${congress}/${apiBillType}/${billNumber}`),
      ),
      // Full list, paginated — cosponsorCount below is taken from the bill
      // endpoint, but partySplit derives from the actual list we've fetched
      // so we need the full roster to avoid undercounting big bills.
      fetchAllPages<{ party?: string }>(
        `/bill/${congress}/${apiBillType}/${billNumber}/cosponsors`,
        "cosponsors",
      ).catch(() => null),
      fetchBillSummary(congress, apiBillType, billNumber),
      fetchBillTitles(congress, apiBillType, billNumber),
    ]);

    const bill = billRes.data?.bill;
    if (!bill) return null;

    const sponsorItem = Array.isArray(bill.sponsors) ? bill.sponsors[0] : null;
    const sponsor = sponsorItem
      ? `${sponsorItem.fullName ?? ""}`.trim() || null
      : null;
    const sponsorBioguideId =
      sponsorItem && typeof sponsorItem.bioguideId === "string"
        ? sponsorItem.bioguideId
        : null;

    const safeCosponsorList = cosponsorList ?? [];
    let partySplit: string | null = null;
    if (safeCosponsorList.length > 0) {
      const counts: Record<string, number> = {};
      for (const c of safeCosponsorList) {
        const p = (c.party || "?").toUpperCase();
        counts[p] = (counts[p] || 0) + 1;
      }
      partySplit = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${n} ${p}`)
        .join(", ");
    }

    return {
      sponsor,
      sponsorBioguideId,
      cosponsorCount:
        bill.cosponsors?.count ?? safeCosponsorList.length ?? null,
      cosponsorPartySplit: partySplit,
      policyArea: bill.policyArea?.name ?? null,
      latestActionDate: bill.latestAction?.actionDate ?? null,
      latestActionText: bill.latestAction?.text ?? null,
      shortText: summary,
      popularTitle: titles?.popularTitle ?? null,
      displayTitle: titles?.displayTitle ?? null,
      shortTitle: titles?.shortTitle ?? null,
    };
  } catch (error: unknown) {
    if (isQuotaError(error)) throw error;
    console.error(
      "Failed to fetch bill metadata:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Parse XML into structured sections using BillXmlParser.
 */
export async function parseXmlIntoSections(
  rawXml: string,
): Promise<ParsedChunk[]> {
  const xmlObj = await parseStringPromise(rawXml, {
    preserveChildrenOrder: true,
    explicitChildren: true,
    charsAsChildren: true,
    trim: true,
    includeWhiteChars: false,
  });
  return BillXmlParser.extractSections(xmlObj);
}
