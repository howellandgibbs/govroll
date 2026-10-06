import { TOPICS } from "@/lib/topic-mapping";
import type {
  BillsChamber,
  BillsMomentum,
  BillsSortBy,
  BillsQueryInput,
  BillsQueryResult,
} from "@/lib/queries/bills";

/**
 * Filter state as it lives in the URL. Mirrors the nuqs parsers in
 * BillListClient and the args accepted by /api/bills.
 */
export interface BillsFilterState {
  search: string;
  chamber: BillsChamber;
  status: string;
  momentum: BillsMomentum;
  sortBy: BillsSortBy;
  /** User-facing topic label, e.g. "Environment". */
  topic: string;
}

export const BILLS_PAGE_SIZE = 20;

/**
 * What /bills shows with nothing in the URL. The page's URL parsers,
 * /api/bills and the header's /api/search all start from this, so the
 * header's preview rows are always the top of the page's results.
 */
export const DEFAULT_BILLS_FILTERS: BillsFilterState = {
  search: "",
  chamber: "both",
  status: "",
  momentum: "live",
  sortBy: "relevant",
  topic: "",
};

/**
 * Stable queryKey. Must match exactly between the RSC prefetch and the
 * client useInfiniteQuery — any drift means the prefetched data doesn't
 * hydrate and the user sees a flash of empty + refetch.
 */
export function billsQueryKey(filters: BillsFilterState) {
  return ["bills", filters] as const;
}

/**
 * Translate the URL-facing topic label into the comma-joined CRS policy
 * areas the API / DB actually filter by.
 */
function resolveTopic(label: string): string {
  if (!label) return "";
  const match = TOPICS.find((t) => t.label === label);
  return match ? match.policyAreas.join(",") : "";
}

/**
 * URL filter state → fetchBillsPage input, for server callers. The topic
 * arrives as a label ("Environment") and must become CRS policy areas
 * before it reaches SQL; passing the label straight through matched
 * nothing, which emptied any topic link loaded directly.
 */
export function toBillsQueryInput(
  filters: BillsFilterState,
  page: number,
  limit: number = BILLS_PAGE_SIZE,
): BillsQueryInput {
  return { ...filters, topic: resolveTopic(filters.topic), page, limit };
}

export function buildBillsSearchParams(
  filters: BillsFilterState,
  page: number,
): URLSearchParams {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(BILLS_PAGE_SIZE),
    sortBy: filters.sortBy,
    order: "desc",
    momentum: filters.momentum,
  });
  if (filters.chamber !== "both") params.set("chamber", filters.chamber);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  const topic = resolveTopic(filters.topic);
  if (topic) params.set("topic", topic);
  return params;
}

export async function fetchBillsPageClient(
  filters: BillsFilterState,
  page: number,
  signal?: AbortSignal,
): Promise<BillsQueryResult> {
  const params = buildBillsSearchParams(filters, page);
  const res = await fetch(`/api/bills?${params}`, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load bills (${res.status})`);
  }
  return res.json();
}
