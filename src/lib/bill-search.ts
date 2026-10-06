import {
  parseBillCitation,
  type BillCitation,
} from "@/lib/parse-bill-citation";

/**
 * Shared rules for what a typed bill query means. The header typeahead,
 * the /bills search box, and fetchBillsPage all classify input through
 * here, so "is this a search?" can't drift between the two boxes.
 */

/** Shorter queries are ignored: the feed stays a feed and the header stays closed. */
export const MIN_SEARCH_LENGTH = 2;

export type BillSearch =
  | { kind: "none" }
  /** "HR 1234", "S.J.Res. 10" — resolved by exact lookup, not text search. */
  | { kind: "citation"; citation: BillCitation }
  | {
      kind: "keyword";
      text: string;
      /**
       * The query reads like a bill's name rather than a topic, so bills
       * titled exactly that are pinned to the top of best-match results.
       * See hasNameIntent.
       */
      nameIntent: boolean;
    };

export function classifySearch(raw: string): BillSearch {
  const text = raw.trim();
  if (text.length < MIN_SEARCH_LENGTH) return { kind: "none" };
  const citation = parseBillCitation(text);
  if (citation) return { kind: "citation", citation };
  return { kind: "keyword", text, nameIntent: hasNameIntent(text) };
}

/**
 * Does the query read like a bill's name ("NEST act", "kids online
 * safety") rather than a topic ("housing")?
 *
 * Single words are treated as topics unless they say "act". Hundreds of
 * acronym bills share a common word with a topic (CARE Act, DEFENSE Act,
 * HOUSING Act), and pinning those above every active bill on the subject
 * would bury what someone browsing by topic came for. Someone who wants
 * one of those bills by name types "act", and a bare acronym still finds
 * it through ordinary relevance ranking.
 */
export function hasNameIntent(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== "the");
  return words.includes("act") || words.length >= 2;
}
