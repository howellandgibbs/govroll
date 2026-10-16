/**
 * Shared types for the bill reader (`/bills/[id]/read`).
 *
 * `ReaderSection` is the merged shape passed from the RSC page down
 * into the (eventually) client `<BillReader>` shell — it bundles the
 * parsed section content, the canonical slug, and the AI caption (if
 * any) so the rendering tree never has to know about the parser or
 * the captions table independently.
 */

import type { BillSection } from "@/lib/bill-sections";

export interface ReaderSection extends BillSection {
  /** Stable URL-safe slug, computed once via `sectionSlugsForBill`. */
  slug: string;
  /** Visual nesting depth (1 = top-level Section/Title/Division, deeper
   *  = subsections). Used to map to h2/h3/h4 in the renderer. */
  depth: number;
  /** AI-generated one-sentence caption, or null if not yet generated
   *  (or filtered out by validation in section-caption.ts). */
  caption: string | null;
}

export interface ReaderBillMeta {
  id: number;
  billId: string;
  /** Verbatim official title from Congress.gov. Used for slug/URL
   *  generation and as the citable text in `aria-label`. For visible
   *  display, prefer `headline`. */
  title: string;
  /** Display headline derived from the full title-resolution chain
   *  (popularTitle → shortTitle → displayTitle → summary extract → AI
   *  → rule synth → amendment synth → title). Always renderable;
   *  for short clean titles it's identical to `title`. */
  headline: string;
  billType: string;
  /** GovTrack-style status key (e.g. "enacted_signed", "pass_over_senate"). */
  currentStatus: string;
  /** Raw Congress.gov sponsor string, e.g. "Sen. Cornyn, John [R-TX]". */
  sponsor: string | null;
  /** Short display number, e.g. "S. 3706" or "H.R. 1234". */
  displayNumber: string;
  /** "118th", "119th", etc. — for the small header meta line. */
  congressLabel: string;
  /** Canonical detail-page URL (one level up from /read). */
  detailHref: string;
}

export interface ReaderVersionMeta {
  id: number;
  versionCode: string;
  versionType: string;
  versionDate: Date;
  isSubstantive: boolean;
}

/**
 * Minimal shape for rendering the version picker — every text-bearing
 * version the bill has, each keyed by its versionCode.
 */
export interface ReaderVersionListEntry {
  versionCode: string;
  versionType: string;
  versionDate: Date;
}
