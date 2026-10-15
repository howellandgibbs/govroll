import axios from "axios";
import { withRetry } from "./congress-api";

/**
 * Current members of Congress from the unitedstates/congress-legislators
 * dataset (public domain, maintained on GitHub, served from GitHub Pages).
 *
 * Replaced GovTrack's /role API in Oct 2026 when govtrack.us went behind a
 * Cloudflare bot challenge that 403s server-side clients. GovTrack builds its
 * member data from this same dataset, so names, party strings ("Democrat",
 * "Republican", "Independent"), district numbering (0 = at-large/delegate)
 * and term end dates are identical to the GovTrack-era rows.
 */
export const LEGISLATORS_CURRENT_URL =
  "https://unitedstates.github.io/congress-legislators/legislators-current.json";

export interface LegislatorTerm {
  type: "rep" | "sen";
  start: string;
  end: string;
  state: string;
  district?: number;
  party: string;
}

export interface Legislator {
  id: { bioguide: string };
  name: { first: string; last: string };
  terms: LegislatorTerm[];
}

export async function fetchCurrentLegislators(): Promise<Legislator[]> {
  const res = await withRetry(() =>
    axios.get<Legislator[]>(LEGISLATORS_CURRENT_URL, { timeout: 30_000 }),
  );
  if (!Array.isArray(res.data)) {
    throw new Error("legislators-current.json did not return an array");
  }
  return res.data;
}

/** The member's current (last) term. */
export function currentTerm(legislator: Legislator): LegislatorTerm | null {
  return legislator.terms?.[legislator.terms.length - 1] ?? null;
}
