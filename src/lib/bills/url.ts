/**
 * Bill URL helpers. Single source of truth for the `/bills/...` route shape
 * so we never hardcode a path anywhere else.
 *
 * Canonical: `/bills/{congress}/{chamber}/{number}[-{slug}]`
 *   e.g. `/bills/118/s/3706-victims-voices-act`
 *
 * Chamber codes mirror the Congress.gov API:
 *   hr | s | hjres | sjres | hconres | sconres | hres | sres
 *
 * `parseBillPath` also accepts the Congress.gov public-site alias
 * (`118th-congress/senate-bill/3706`) and mixed casing, and flags them
 * as non-canonical so the caller can 301 to the canonical shape.
 */

import { formatOrdinal } from "@/lib/parse-bill-citation";

export const BILL_TYPE_TO_CHAMBER_CODE = {
  house_bill: "hr",
  senate_bill: "s",
  house_joint_resolution: "hjres",
  senate_joint_resolution: "sjres",
  house_concurrent_resolution: "hconres",
  senate_concurrent_resolution: "sconres",
  house_resolution: "hres",
  senate_resolution: "sres",
} as const;

export const CHAMBER_CODE_TO_BILL_TYPE: Record<string, string> =
  Object.fromEntries(
    Object.entries(BILL_TYPE_TO_CHAMBER_CODE).map(([k, v]) => [v, k]),
  );

// Word-form aliases used by the Congress.gov public site.
const WORD_FORM_TO_CHAMBER_CODE: Record<string, string> = {
  "house-bill": "hr",
  "senate-bill": "s",
  "house-joint-resolution": "hjres",
  "senate-joint-resolution": "sjres",
  "house-concurrent-resolution": "hconres",
  "senate-concurrent-resolution": "sconres",
  "house-resolution": "hres",
  "senate-resolution": "sres",
};

const CHAMBER_CODE_TO_WORD_FORM: Record<string, string> = Object.fromEntries(
  Object.entries(WORD_FORM_TO_CHAMBER_CODE).map(([k, v]) => [v, k]),
);

const CHAMBER_CODES = new Set<string>(Object.values(BILL_TYPE_TO_CHAMBER_CODE));

/**
 * Slugify a bill title to a URL segment. Deliberately more forgiving than
 * `nameToSlug` (reps) because bill titles contain punctuation, numbers,
 * and acronyms we want to preserve where possible.
 *
 * Caps length so the URL doesn't blow up on 40-word titles — the slug is
 * for humans/SEO, not for identification.
 */
const TITLE_SLUG_MAX = 60;

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= TITLE_SLUG_MAX) return slug;
  // Truncate at the last hyphen that fits within the limit so we don't
  // cut a word in half. If no hyphen, hard-truncate.
  const truncated = slug.slice(0, TITLE_SLUG_MAX);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 20 ? truncated.slice(0, lastHyphen) : truncated;
}

/**
 * Parse a bill's text identifier (`senate_bill-3706-118`) into its parts.
 * This is the `Bill.billId` column, stored as a GovTrack-style composite.
 */
export function parseBillIdentifier(billIdText: string): {
  billType: string;
  number: number;
  congress: number;
} | null {
  // billType can contain underscores ("senate_joint_resolution"); number
  // and congress are trailing integers. Split from the right.
  const lastDash = billIdText.lastIndexOf("-");
  if (lastDash === -1) return null;
  const congress = Number(billIdText.slice(lastDash + 1));
  const rest = billIdText.slice(0, lastDash);
  const secondLastDash = rest.lastIndexOf("-");
  if (secondLastDash === -1) return null;
  const number = Number(rest.slice(secondLastDash + 1));
  const billType = rest.slice(0, secondLastDash);
  if (!Number.isInteger(congress) || congress <= 0) return null;
  if (!Number.isInteger(number) || number <= 0) return null;
  if (!(billType in BILL_TYPE_TO_CHAMBER_CODE)) return null;
  return { billType, number, congress };
}

/**
 * Inverse of `parseBillIdentifier` — compose the DB billId key from parts.
 * Used by the route handler to look up by the unique `billId` text column.
 */
export function billIdentifierFor(
  chamberCode: string,
  number: number,
  congress: number,
): string | null {
  const billType = CHAMBER_CODE_TO_BILL_TYPE[chamberCode];
  if (!billType) return null;
  return `${billType}-${number}-${congress}`;
}

export interface BillForUrl {
  billId: string; // GovTrack composite, e.g. "senate_bill-3706-118"
  title: string;
}

/**
 * Canonical URL for a bill detail page. Always includes the slug —
 * bare `/bills/118/s/3706` also resolves, but the slugged form is what
 * we emit in links and the sitemap for SEO + preview text.
 */
export function billHref(bill: BillForUrl): string {
  const base = billPathBase(bill);
  if (!base) return `/bills`;
  const slug = slugifyTitle(bill.title);
  return slug ? `${base}-${slug}` : base;
}

/**
 * Reader sub-route (`/read`).
 */
export function billReadHref(bill: BillForUrl): string {
  const href = billHref(bill);
  return href === "/bills" ? href : `${href}/read`;
}

/**
 * Canonical Congress.gov overview page for a bill.
 *   `https://www.congress.gov/bill/119th-congress/house-resolution/1156`
 *
 * Built from the billId rather than the legacy `Bill.link` column, which
 * holds GovTrack URLs for most rows (GovTrack puts visitors through a bot
 * check since Oct 2026).
 */
export function congressGovBillUrl(bill: { billId: string }): string | null {
  const parsed = parseBillIdentifier(bill.billId);
  if (!parsed) return null;
  const chamberCode =
    BILL_TYPE_TO_CHAMBER_CODE[
      parsed.billType as keyof typeof BILL_TYPE_TO_CHAMBER_CODE
    ];
  if (!chamberCode) return null;
  const wordForm = CHAMBER_CODE_TO_WORD_FORM[chamberCode];
  if (!wordForm) return null;
  return `https://www.congress.gov/bill/${formatOrdinal(parsed.congress)}-congress/${wordForm}/${parsed.number}`;
}

/**
 * Canonical Congress.gov text URL for a bill.
 *   `https://www.congress.gov/bill/119th-congress/house-resolution/1156/text`
 *
 * The `/text` suffix lands the user on the bill text view rather than
 * the overview tab — matches the user's intent when clicking a "Source"
 * link from the reader.
 */
export function congressGovBillTextUrl(bill: {
  billId: string;
}): string | null {
  const base = congressGovBillUrl(bill);
  return base ? `${base}/text` : null;
}

/**
 * `/bills/{congress}/{chamber}/{number}` — no slug, no sub-route. Used
 * internally as the canonical base against which we compare provided
 * slugs in parseBillPath.
 */
function billPathBase(bill: BillForUrl): string | null {
  const parsed = parseBillIdentifier(bill.billId);
  if (!parsed) return null;
  const chamberCode =
    BILL_TYPE_TO_CHAMBER_CODE[
      parsed.billType as keyof typeof BILL_TYPE_TO_CHAMBER_CODE
    ];
  if (!chamberCode) return null;
  return `/bills/${parsed.congress}/${chamberCode}/${parsed.number}`;
}

export interface ParsedBillPath {
  congress: number;
  chamberCode: string;
  number: number;
  providedSlug: string | null;
  /** True if the input segments were already the canonical shape
   * (lowercase chamber code, bare congress, bare number or number-slug).
   * False means the caller should 301 to the canonical URL. */
  canonical: boolean;
}

/**
 * Parse and normalize the dynamic segments of
 * `/bills/[congress]/[chamber]/[numberSlug]`.
 *
 * Accepts:
 *   - canonical: `["118", "s", "3706"]` or `["118", "s", "3706-my-slug"]`
 *   - Congress.gov word form: `["118th-congress", "senate-bill", "3706"]`
 *   - mixed casing: `["118", "S", "3706"]`
 *
 * Returns null if the segments don't look like a bill.
 */
export function parseBillPath(
  segments: [string, string, string],
): ParsedBillPath | null {
  const [rawCongress, rawChamber, rawNumberSlug] = segments;

  let canonical = true;

  // ── congress ──────────────────────────────────────────────────────
  let congress: number;
  if (/^\d+$/.test(rawCongress)) {
    congress = Number(rawCongress);
  } else {
    // "118th-congress" or similar
    const match = rawCongress
      .toLowerCase()
      .match(/^(\d+)(?:st|nd|rd|th)?-congress$/);
    if (!match) return null;
    congress = Number(match[1]);
    canonical = false;
  }
  if (!Number.isInteger(congress) || congress <= 0) return null;

  // ── chamber ───────────────────────────────────────────────────────
  const chamberLower = rawChamber.toLowerCase();
  let chamberCode: string | null = null;
  if (CHAMBER_CODES.has(chamberLower)) {
    chamberCode = chamberLower;
    if (chamberLower !== rawChamber) canonical = false;
  } else if (chamberLower in WORD_FORM_TO_CHAMBER_CODE) {
    chamberCode = WORD_FORM_TO_CHAMBER_CODE[chamberLower];
    canonical = false;
  } else {
    return null;
  }

  // ── number + optional slug ────────────────────────────────────────
  // Number is the leading integer; everything after the first hyphen
  // is the slug. "3706" or "3706-victims-voices-act".
  const numberMatch = rawNumberSlug.match(/^(\d+)(?:-(.+))?$/);
  if (!numberMatch) return null;
  const number = Number(numberMatch[1]);
  const providedSlug = numberMatch[2] ?? null;
  if (!Number.isInteger(number) || number <= 0) return null;

  return { congress, chamberCode, number, providedSlug, canonical };
}
