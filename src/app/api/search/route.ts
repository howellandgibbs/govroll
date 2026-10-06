import { NextRequest, NextResponse } from "next/server";
import { fetchBillsPage, lookupBillCitation } from "@/lib/queries/bills";
import {
  DEFAULT_BILLS_FILTERS,
  toBillsQueryInput,
} from "@/lib/queries/bills-client";
import {
  searchRepresentatives,
  type RepSearchResult,
} from "@/lib/queries/representatives";
import { classifySearch } from "@/lib/bill-search";
import { reportError } from "@/lib/error-reporting";
import type { BillSummary, ParsedCitationSummary } from "@/types";

export interface GlobalSearchResponse {
  query: string;
  representatives: RepSearchResult[];
  bills: BillSummary[];
  /** Set when the query parses as a bill citation ("HR 1234"). */
  citation: ParsedCitationSummary | null;
  /** Direct bill match for the typed citation. */
  exactBill: BillSummary | null;
}

const REP_LIMIT = 5;
const BILL_LIMIT = 5;

/**
 * Header search endpoint. Returns a small grouped payload (members + bills)
 * for the typeahead dropdown. Deliberately combines the two queries into a
 * single round trip so the dropdown isn't waiting on two requests serially.
 *
 * The bill rows are the first five results of /bills?search=<q>: the same
 * fetchBillsPage call with the page's default filters. "See all bill
 * matches" therefore opens a page that starts with exactly the rows the
 * dropdown showed, and a bill found here can't vanish there.
 *
 * A typed citation ("HR 1234") returns only its bill. The /bills page
 * lists the regular feed under its jump-to row, but in a five-row
 * dropdown those trending bills read as matches for "HR 1234".
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const query = (searchParams.get("q") ?? "").trim();
  const search = classifySearch(query);

  if (search.kind === "none") {
    return NextResponse.json<GlobalSearchResponse>({
      query,
      representatives: [],
      bills: [],
      citation: null,
      exactBill: null,
    });
  }

  try {
    const [representatives, billResults] = await Promise.all([
      searchRepresentatives(query, REP_LIMIT),
      search.kind === "citation"
        ? lookupBillCitation(search.citation).then((r) => ({
            bills: [],
            citation: r.citation,
            exactMatch: r.exactMatch,
          }))
        : fetchBillsPage(
            toBillsQueryInput(
              { ...DEFAULT_BILLS_FILTERS, search: query },
              1,
              BILL_LIMIT,
            ),
          ),
    ]);

    return NextResponse.json<GlobalSearchResponse>({
      query,
      representatives,
      bills: billResults.bills,
      citation: billResults.citation,
      exactBill: billResults.exactMatch,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "api_error",
        route: "GET /api/search",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    reportError(error, { route: "GET /api/search" });
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
