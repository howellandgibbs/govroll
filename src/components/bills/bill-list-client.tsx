"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQueryStates, parseAsString, parseAsStringLiteral } from "nuqs";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { BillCard } from "./bill-card";
import { BillGroupCard } from "./bill-group-card";
import { TOPICS } from "@/lib/topic-mapping";
import { useAuth } from "@/hooks/use-auth";
import { useUserPref } from "@/hooks/use-user-pref";
import { groupBills, type BillFeedItem } from "@/lib/bill-grouping";
import { formatOrdinal } from "@/lib/parse-bill-citation";
import { classifySearch } from "@/lib/bill-search";
import {
  DEFAULT_BILLS_FILTERS,
  billsQueryKey,
  fetchBillsPageClient,
  type BillsFilterState,
} from "@/lib/queries/bills-client";
import type { BillsQueryResult } from "@/lib/queries/bills";
import type { BillSearchGroup, BillSummary, VoteType } from "@/types";

// "relevant" means momentum while browsing and best match while
// searching, so its tab is relabeled when a keyword search is active.
const SORT_OPTIONS = [
  { value: "relevant", label: "Trending", searchLabel: "Best match" },
  { value: "latest", label: "Latest Activity", searchLabel: null },
  { value: "newest", label: "Newest", searchLabel: null },
] as const;

const SEARCH_EXAMPLES = ["H.R. 1", "S. 1", "defense"] as const;

const filterParsers = {
  search: parseAsString.withDefault(DEFAULT_BILLS_FILTERS.search),
  chamber: parseAsStringLiteral([
    "both",
    "house",
    "senate",
  ] as const).withDefault(DEFAULT_BILLS_FILTERS.chamber),
  status: parseAsString.withDefault(DEFAULT_BILLS_FILTERS.status),
  momentum: parseAsStringLiteral([
    "live",
    "graveyard",
    "all",
  ] as const).withDefault(DEFAULT_BILLS_FILTERS.momentum),
  sortBy: parseAsStringLiteral([
    "relevant",
    "latest",
    "newest",
  ] as const).withDefault(DEFAULT_BILLS_FILTERS.sortBy),
  topic: parseAsString.withDefault(DEFAULT_BILLS_FILTERS.topic),
};

const filterOptions = {
  history: "replace" as const,
  clearOnDefault: true,
  shallow: true,
  throttleMs: 300,
};

// Pre-server-sync we stored hideVoted in localStorage. Migrate any leftover
// value into the server-backed pref the first time a signed-in user lands
// here, then clear the key. Idempotent — once cleared it never runs again.
const LEGACY_HIDE_VOTED_STORAGE_KEY = "bills:hide-voted";

// Topic filter chips are neutral — line colour is identification on rows,
// never a chip fill (the encoding law). Outline chip → active ink fill.
const CHIP_BASE =
  "shrink-0 border px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-colors";
const CHIP_IDLE = "border-rule text-ink hover:border-ink/40 bg-paper";
const CHIP_ACTIVE = "border-ink bg-ink text-sand";

const EMPTY_ACTION =
  "text-ink border-rule hover:border-ink/40 bg-paper inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors";

const SECTION_LABEL =
  "text-ink-muted mb-1.5 px-0.5 text-[11px] font-bold tracking-[0.18em] uppercase tabular-nums";

// Labels for best-match search groups. Default returns null so a bundle
// cached from before a new group existed renders it unlabeled instead
// of crashing.
function searchGroupLabel(group: BillSearchGroup | null): string | null {
  switch (group) {
    case "name":
      return "Bills with this name";
    case "live":
      return "Active or enacted";
    case "inactive":
      return "Stalled, dormant or dead";
    default:
      return null;
  }
}

interface FeedSection {
  group: BillSearchGroup | null;
  items: BillFeedItem[];
}

// Split the feed into runs of the same search group, grouping duplicate
// bills within each run so a cluster never straddles a section label.
// Outside best-match search every bill has no group: one section.
function sectionFeed(bills: BillSummary[]): FeedSection[] {
  const sections: FeedSection[] = [];
  let run: BillSummary[] = [];
  let runGroup: BillSearchGroup | null = null;
  const flush = () => {
    if (run.length > 0) {
      sections.push({ group: runGroup, items: groupBills(run) });
    }
  };
  for (const bill of bills) {
    const group = bill.searchGroup ?? null;
    if (run.length > 0 && group !== runGroup) {
      flush();
      run = [];
    }
    runGroup = group;
    run.push(bill);
  }
  flush();
  return sections;
}

export function BillListClient() {
  const [rawFilters, setFilters] = useQueryStates(filterParsers, filterOptions);
  const queryFilters: BillsFilterState = rawFilters;

  const observerRef = useRef<HTMLDivElement>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const { user } = useAuth();
  const { value: hideVoted, setValue: setHideVoted } = useUserPref("hideVoted");

  // One-shot migration of the old localStorage value to the server-backed
  // pref. Runs only when signed in and the legacy key is set to "true";
  // clears the key afterward so subsequent loads skip the work.
  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined") return;
    try {
      const legacy = window.localStorage.getItem(LEGACY_HIDE_VOTED_STORAGE_KEY);
      if (legacy === "true") setHideVoted(true);
      if (legacy !== null)
        window.localStorage.removeItem(LEGACY_HIDE_VOTED_STORAGE_KEY);
    } catch {
      // localStorage may be unavailable; nothing we can do — the user just
      // re-toggles once and the new value persists server-side.
    }
  }, [user, setHideVoted]);

  const {
    data,
    error: queryError,
    isLoading,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    refetch,
  } = useInfiniteQuery<BillsQueryResult>({
    queryKey: billsQueryKey(queryFilters),
    queryFn: ({ pageParam, signal }) =>
      fetchBillsPageClient(queryFilters, pageParam as number, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const fetched = lastPage.page * lastPage.pageSize;
      return fetched < lastPage.total ? lastPage.page + 1 : undefined;
    },
    // Keep the previous filter's data visible while the new one loads —
    // prevents the skeleton flash when toggling a chamber pill.
    placeholderData: keepPreviousData,
  });

  const bills = useMemo(
    () => data?.pages.flatMap((p) => p.bills) ?? [],
    [data],
  );
  const total = data?.pages[0]?.total ?? 0;
  const hiddenByMomentum = data?.pages[0]?.hiddenByMomentum ?? 0;
  const groupCounts = data?.pages[0]?.groupCounts ?? null;
  const exactMatch = data?.pages[0]?.exactMatch ?? null;
  const citation = data?.pages[0]?.citation ?? null;
  // A keyword search covers every bill, so the live-only toggle doesn't
  // apply and "relevant" means best match. Citations still show the feed.
  const searchText = queryFilters.search.trim();
  const isKeywordSearch = classifySearch(searchText).kind === "keyword";
  const hasNarrowingFilters =
    queryFilters.topic !== "" ||
    queryFilters.chamber !== "both" ||
    queryFilters.status !== "";
  const error = queryError
    ? "Something went wrong loading bills. Please try again."
    : null;
  // The infinite query keeps prior pages during refetch; flag the "initial
  // load" differently from "appending a page" for UX (skeletons vs spinner).
  const isRefetchingFilter =
    isFetching && !isFetchingNextPage && bills.length === 0;
  const isRefiltering = isFetching && !isFetchingNextPage && bills.length > 0;

  // Voted bills — only relevant for signed-in users. Enabled-gated, cached
  // per user. We keep direction so the feed can tint the chip and fade the
  // title Reddit-visited-link style.
  const { data: votedData } = useQuery<{
    votes: Array<{ billId: number; voteType: VoteType }>;
  }>({
    queryKey: ["voted-bills", user?.id ?? null],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/user/voted-bills", {
        cache: "no-store",
        signal,
      });
      if (!res.ok) throw new Error("Failed to load voted bills");
      return res.json();
    },
    enabled: !!user,
    staleTime: 60_000,
  });
  const userVotes = useMemo(
    () =>
      new Map<number, VoteType>(
        (votedData?.votes ?? []).map((v) => [v.billId, v.voteType]),
      ),
    [votedData],
  );

  const visibleBills = useMemo(
    () => (hideVoted ? bills.filter((b) => !userVotes.has(b.id)) : bills),
    [bills, hideVoted, userVotes],
  );
  const hiddenByVoteCount = hideVoted ? bills.length - visibleBills.length : 0;
  const sections = useMemo(() => sectionFeed(visibleBills), [visibleBills]);
  // Label groups only when the matches span more than one of them.
  const showGroupLabels =
    groupCounts !== null &&
    [groupCounts.name, groupCounts.live, groupCounts.inactive].filter(
      (n) => n > 0,
    ).length > 1;

  // Infinite-scroll sentinel: fire fetchNextPage when it scrolls into view.
  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          hasNextPage &&
          !isFetchingNextPage &&
          !isFetching
        ) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isFetching]);

  const activeFilterCount =
    (queryFilters.chamber !== "both" ? 1 : 0) +
    (queryFilters.status !== "" ? 1 : 0);

  const filterPill = (
    label: string,
    value: string,
    current: string,
    key: "chamber" | "status",
    resetTo: string,
  ) => (
    <button
      key={value}
      onClick={() =>
        setFilters({ [key]: current === value ? resetTo : value } as Partial<
          typeof rawFilters
        >)
      }
      className={`${CHIP_BASE} ${current === value ? CHIP_ACTIVE : "text-ink-muted hover:text-ink border-transparent"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Row 1 — Search */}
      <div className="relative">
        <svg
          className="text-ink-muted absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <circle cx="11" cy="11" r="8" strokeWidth="2" />
          <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          aria-label="Search bills"
          placeholder="Search by name, number or topic"
          value={queryFilters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          className="border-rule bg-paper placeholder:text-ink-muted focus:border-ink focus-visible:ring-gold h-10 w-full border pr-3 pl-9 text-base focus:outline-none focus-visible:ring-2"
        />
      </div>

      {/* Search examples — appear on focus when input is empty */}
      {searchFocused && queryFilters.search === "" && (
        <div className="animate-fade-slide-up flex flex-wrap items-center gap-1.5 px-0.5">
          <span className="text-ink-muted text-xs">Try:</span>
          {SEARCH_EXAMPLES.map((example) => (
            <button
              key={example}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFilters({ search: example })}
              className="border-rule text-ink-muted hover:border-ink/40 hover:text-ink border px-2 py-0.5 text-xs tabular-nums transition-colors"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {/* Row 2 — Sort tabs: 2px ink baseline, active tab carries a 3px
          sapphire underline overlapping it. */}
      <div
        aria-label="Sort bills"
        className="border-ink flex items-end gap-5 border-b-2"
      >
        {SORT_OPTIONS.map((opt) => {
          const active = queryFilters.sortBy === opt.value;
          return (
            <button
              key={opt.value}
              aria-pressed={active}
              onClick={() => setFilters({ sortBy: opt.value })}
              className={`-mb-[2px] border-b-[3px] px-0.5 pb-1.5 text-[13px] font-semibold transition-colors ${
                active
                  ? "border-sapphire text-ink"
                  : "text-ink-muted hover:text-ink border-transparent"
              }`}
            >
              {isKeywordSearch && opt.searchLabel ? opt.searchLabel : opt.label}
            </button>
          );
        })}
      </div>

      {/* Row 3 — Topics + Filters toggle */}
      <div className="flex items-center gap-2">
        <div className="scrollbar-hide -mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1 pb-0.5">
          <button
            onClick={() => setFilters({ topic: "" })}
            className={`${CHIP_BASE} ${queryFilters.topic === "" ? CHIP_ACTIVE : CHIP_IDLE}`}
          >
            All Topics
          </button>
          {TOPICS.map((t) => (
            <button
              key={t.label}
              onClick={() =>
                setFilters({
                  topic: queryFilters.topic === t.label ? "" : t.label,
                })
              }
              className={`${CHIP_BASE} ${queryFilters.topic === t.label ? CHIP_ACTIVE : CHIP_IDLE}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold transition-colors ${
            showFilters || activeFilterCount > 0
              ? "border-ink text-ink"
              : "border-rule text-ink-muted hover:text-ink hover:border-ink/40"
          }`}
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
          >
            <path strokeLinecap="round" d="M3 6h18M7 12h10M10 18h4" />
          </svg>
          Filters
          {activeFilterCount > 0 && (
            <span className="bg-ink text-sand flex h-4 w-4 items-center justify-center rounded-full text-xs leading-none tabular-nums">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* Expandable filter row */}
      {showFilters && (
        <div className="animate-fade-slide-up flex flex-wrap items-center gap-3 pb-2">
          <div className="border-rule flex items-center gap-0.5 border px-1 py-0.5">
            {filterPill("All", "both", queryFilters.chamber, "chamber", "both")}
            {filterPill(
              "House",
              "house",
              queryFilters.chamber,
              "chamber",
              "both",
            )}
            {filterPill(
              "Senate",
              "senate",
              queryFilters.chamber,
              "chamber",
              "both",
            )}
          </div>

          <div className="border-rule flex items-center gap-0.5 border px-1 py-0.5">
            {filterPill("Any", "", queryFilters.status, "status", "")}
            {filterPill(
              "Introduced",
              "introduced",
              queryFilters.status,
              "status",
              "",
            )}
            {filterPill(
              "In Progress",
              "in_progress",
              queryFilters.status,
              "status",
              "",
            )}
            {filterPill("Passed", "passed", queryFilters.status, "status", "")}
            {filterPill(
              "Enacted",
              "enacted",
              queryFilters.status,
              "status",
              "",
            )}
            {filterPill("Failed", "failed", queryFilters.status, "status", "")}
          </div>
        </div>
      )}

      {/* Count + hidden bills link */}
      <div className="flex min-h-[24px] items-center justify-between">
        <p className="text-ink-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] tabular-nums">
          {isRefiltering && (
            <span className="inline-flex items-center gap-1.5">
              <span className="border-ink/15 border-t-ink/70 h-3 w-3 animate-spin rounded-full border-2" />
              Updating…
            </span>
          )}
          {!isRefiltering && total > 0 && (
            <>
              <span>
                {`${total.toLocaleString("en-US")} bill${total !== 1 ? "s" : ""}`}
              </span>
              {!isKeywordSearch &&
                queryFilters.momentum === "live" &&
                hiddenByMomentum > 0 && (
                  <button
                    onClick={() => setFilters({ momentum: "all" })}
                    className="hover:text-ink underline decoration-dotted underline-offset-2 transition-colors"
                  >
                    {`(${hiddenByMomentum.toLocaleString("en-US")} stalled, dormant or dead hidden)`}
                  </button>
                )}
              {!isKeywordSearch && queryFilters.momentum === "all" && (
                <button
                  onClick={() => setFilters({ momentum: "live" })}
                  className="hover:text-ink underline decoration-dotted underline-offset-2 transition-colors"
                >
                  (show active only)
                </button>
              )}
              {user && userVotes.size > 0 && (
                <button
                  onClick={() => setHideVoted(!hideVoted)}
                  className="hover:text-ink underline decoration-dotted underline-offset-2 transition-colors"
                >
                  {hideVoted
                    ? `(${hiddenByVoteCount} voted hidden)`
                    : "(hide voted)"}
                </button>
              )}
            </>
          )}
        </p>
      </div>

      {/* Jump-to row — when the user typed a bill citation. Sits above
          the main feed so they can still browse other results. */}
      {citation && (
        <div className="animate-fade-slide-up">
          <div className={SECTION_LABEL}>
            {exactMatch ? (
              <>
                Jump to {citation.shortLabel} {citation.number}
                {citation.congress !== null &&
                  ` · ${formatOrdinal(citation.congress)} Congress`}
              </>
            ) : (
              <>
                No bill found for {citation.shortLabel} {citation.number}
                {citation.congress !== null &&
                  ` · ${formatOrdinal(citation.congress)} Congress`}
              </>
            )}
          </div>
          {exactMatch && (
            <div className="border-hollow hover:border-ink/40 border border-dashed transition-colors">
              <BillCard
                bill={exactMatch}
                userVote={userVotes.get(exactMatch.id) ?? null}
              />
            </div>
          )}
        </div>
      )}

      {/* Bill list. Best-match search results arrive in groups (bills
          with the typed name, then active, then stalled/dormant/dead) and
          get a label per group; everything else is a single section. */}
      <div
        className={`space-y-2 transition-opacity duration-150 ${
          isRefiltering ? "pointer-events-none opacity-40" : ""
        }`}
        aria-busy={isRefiltering}
      >
        {sections.map((section, sectionIndex) => {
          const label = showGroupLabels
            ? searchGroupLabel(section.group)
            : null;
          const count =
            section.group && groupCounts ? groupCounts[section.group] : null;
          const offset = sections
            .slice(0, sectionIndex)
            .reduce((n, s) => n + s.items.length, 0);
          return (
            <Fragment key={`section-${sectionIndex}-${section.group ?? "all"}`}>
              {label && (
                <div
                  className={`${SECTION_LABEL} ${sectionIndex > 0 ? "pt-4" : ""}`}
                >
                  {label}
                  {count != null && ` · ${count.toLocaleString("en-US")}`}
                </div>
              )}
              {section.items.map((item, i) => {
                const key =
                  item.kind === "single"
                    ? `bill-${item.bill.id}`
                    : `group-${item.key}`;
                return (
                  <div
                    key={key}
                    className="animate-fade-slide-up"
                    style={{
                      animationDelay: `${Math.min(offset + i, 10) * 30}ms`,
                    }}
                  >
                    {item.kind === "single" ? (
                      <BillCard
                        bill={item.bill}
                        userVote={userVotes.get(item.bill.id) ?? null}
                      />
                    ) : (
                      <BillGroupCard bills={item.bills} userVotes={userVotes} />
                    )}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      {(isLoading || isRefetchingFilter) && bills.length === 0 && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="border-rule bg-paper relative overflow-hidden border px-5 py-4"
              aria-hidden
            >
              <div className="bg-rule absolute top-0 bottom-0 left-0 w-[5px]" />
              <div className="space-y-2.5 pl-3">
                <div
                  className="bg-muted h-4 motion-safe:animate-pulse"
                  style={{ width: `${70 - i * 3}%` }}
                />
                <div
                  className="bg-muted/70 h-3 motion-safe:animate-pulse"
                  style={{ width: `${55 - i * 2}%` }}
                />
                <div className="flex items-center gap-2 pt-1">
                  <div className="bg-muted/80 h-3 w-10 motion-safe:animate-pulse" />
                  <div className="bg-muted/70 h-4 w-16 motion-safe:animate-pulse" />
                  <div className="bg-muted/70 h-4 w-14 motion-safe:animate-pulse" />
                  <div className="bg-muted/60 h-3 w-20 motion-safe:animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isFetchingNextPage && (
        <div className="flex justify-center py-6">
          <div className="text-ink-muted flex items-center gap-2 text-sm">
            <div className="border-ink/15 border-t-ink/60 h-4 w-4 animate-spin rounded-full border-2" />
            Loading more…
          </div>
        </div>
      )}

      {error && (
        <div className="border-rule bg-paper space-y-3 border p-6 text-center">
          <p className="text-ink-muted text-base">{error}</p>
          <button
            onClick={() => refetch()}
            className="text-ink border-rule hover:border-ink/40 bg-paper inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* Empty states name the way out. A browse filter that hides
          inactive bills offers them; a search with filters offers to
          drop the filters. */}
      {!isLoading && !isFetching && !error && bills.length === 0 && (
        <div className="space-y-3 py-16 text-center">
          <p className="text-ink-muted text-base">
            {isKeywordSearch ? (
              <>
                No bills match &ldquo;{searchText}&rdquo;
                {hasNarrowingFilters ? " with these filters." : "."}
              </>
            ) : queryFilters.momentum === "live" && hiddenByMomentum > 0 ? (
              "No active bills match these filters."
            ) : (
              "No bills found matching your filters."
            )}
          </p>
          {isKeywordSearch && !hasNarrowingFilters && (
            <p className="text-ink-muted text-sm">
              Check the spelling, try fewer words, or search by bill number,
              like H.R. 1.
            </p>
          )}
          {!isKeywordSearch &&
          queryFilters.momentum === "live" &&
          hiddenByMomentum > 0 ? (
            <button
              onClick={() => setFilters({ momentum: "all" })}
              className={EMPTY_ACTION}
            >
              {`Show ${hiddenByMomentum.toLocaleString("en-US")} stalled, dormant or dead ${hiddenByMomentum === 1 ? "bill" : "bills"}`}
            </button>
          ) : hasNarrowingFilters ? (
            <button
              onClick={() =>
                setFilters({ topic: "", chamber: "both", status: "" })
              }
              className={EMPTY_ACTION}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      )}

      <div ref={observerRef} className="h-4" />
    </div>
  );
}
