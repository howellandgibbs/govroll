"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { partyLetter } from "@/lib/representative-utils";
import { getTopicForPolicyArea } from "@/lib/topic-mapping";
import { pickBillHeadline } from "@/lib/bill-headline";
import { billHref } from "@/lib/bills/url";
import { formatBillNumber } from "@/lib/bill-grouping";
import { billStatusLine } from "@/lib/bill-status-labels";
import { MIN_SEARCH_LENGTH } from "@/lib/bill-search";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { RepPhoto } from "@/components/representatives/rep-photo";
import type { GlobalSearchResponse } from "@/app/api/search/route";
import type { BillSummary } from "@/types";
import type { RepSearchResult } from "@/lib/queries/representatives";

const DEBOUNCE_MS = 200;
const MIN_QUERY = MIN_SEARCH_LENGTH;

// Flattened, navigable result list. The dropdown renders sections, but
// keyboard arrows traverse the whole list — building a single ordered
// array is the simplest way to keep the cursor index honest across
// section boundaries (and the "see all" rows).
type FlatItem =
  | { kind: "rep"; href: string; rep: RepSearchResult }
  | { kind: "bill"; href: string; bill: BillSummary }
  | { kind: "see-all-bills"; href: string };

function repHref(rep: { slug: string | null; bioguideId: string }): string {
  return `/representatives/${rep.slug ?? rep.bioguideId}`;
}

function flatten(
  results: GlobalSearchResponse | null,
  query: string,
): FlatItem[] {
  if (!results) return [];
  const out: FlatItem[] = [];
  for (const rep of results.representatives) {
    out.push({ kind: "rep", href: repHref(rep), rep });
  }
  if (results.exactBill) {
    out.push({
      kind: "bill",
      href: billHref(results.exactBill),
      bill: results.exactBill,
    });
  }
  for (const bill of results.bills) {
    if (results.exactBill && bill.id === results.exactBill.id) continue;
    out.push({ kind: "bill", href: billHref(bill), bill });
  }
  if (results.bills.length > 0 || results.exactBill) {
    out.push({
      kind: "see-all-bills",
      href: `/bills?search=${encodeURIComponent(query)}`,
    });
  }
  return out;
}

interface SearchState {
  query: string;
  results: GlobalSearchResponse | null;
  phase: "idle" | "loading" | "done";
  setQuery: (q: string) => void;
  reset: () => void;
}

function useSearchState(): SearchState {
  const [query, setQueryRaw] = useState("");
  const [results, setResults] = useState<GlobalSearchResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Stamp + check ensures the most recent query wins when responses
  // arrive out of order. AbortController already covers the common case;
  // this guards the rare "two requests both completed before either
  // resolved" edge.
  const seqRef = useRef(0);

  const fetchResults = useCallback(async (q: string, seq: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data: GlobalSearchResponse = await res.json();
      if (seq !== seqRef.current) return;
      setResults(data);
      setPhase("done");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Header search is not load-bearing — log and move on.
      console.error("global search failed", e);
    }
  }, []);

  const setQuery = useCallback(
    (value: string) => {
      setQueryRaw(value);
      const trimmed = value.trim();
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (trimmed.length < MIN_QUERY) {
        setPhase("idle");
        setResults(null);
        seqRef.current += 1;
        return;
      }

      seqRef.current += 1;
      const seq = seqRef.current;
      if (!results) setPhase("loading");
      debounceRef.current = setTimeout(
        () => fetchResults(trimmed, seq),
        DEBOUNCE_MS,
      );
    },
    [fetchResults, results],
  );

  const reset = useCallback(() => {
    setQueryRaw("");
    setResults(null);
    setPhase("idle");
    seqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return { query, results, phase, setQuery, reset };
}

interface SearchInputProps {
  state: SearchState;
  variant: "desktop" | "sheet";
  autoFocus?: boolean;
  onNavigate?: () => void;
}

/**
 * The actual search input + dropdown, shared between the desktop header and
 * the mobile sheet. `variant` controls chrome only — keyboard handling and
 * data flow are identical so a user typing the same query in either place
 * sees the same suggestions.
 */
function SearchInput({
  state,
  variant,
  autoFocus,
  onNavigate,
}: SearchInputProps) {
  const router = useRouter();
  const { query, results, phase, setQuery, reset } = state;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const items = useMemo(() => flatten(results, query), [results, query]);

  // Derived-state pattern (React 19): when query or results identity
  // changes, reset the cursor and un-dismiss without scheduling an
  // extra render. Tracking the previous values inline avoids the
  // effect-with-setState cascade that the lint rule flags.
  const [prevQuery, setPrevQuery] = useState(query);
  const [prevResults, setPrevResults] = useState(results);
  if (prevQuery !== query) {
    setPrevQuery(query);
    setActiveIndex(-1);
    setDismissed(false);
  }
  if (prevResults !== results) {
    setPrevResults(results);
    setActiveIndex(-1);
  }

  // Click outside collapses the desktop dropdown. The mobile sheet has
  // its own dismiss path (overlay click / X button) so we skip this
  // listener inside the sheet variant.
  useEffect(() => {
    if (variant !== "desktop") return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setDismissed(true);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [variant]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        navigateTo(items[activeIndex].href);
      } else if (query.trim().length >= MIN_QUERY) {
        // No highlighted item — send the user to the bills search page so
        // pressing Enter never feels like a dead end.
        navigateTo(`/bills?search=${encodeURIComponent(query.trim())}`);
      }
    } else if (e.key === "Escape") {
      if (variant === "desktop") {
        setDismissed(true);
        inputRef.current?.blur();
      }
    }
  };

  const navigateTo = (href: string) => {
    router.push(href);
    reset();
    setDismissed(true);
    onNavigate?.();
  };

  // Desktop: collapse when query is empty or user dismissed.
  // Sheet: always show the surface; an empty state guides the user.
  const showDropdown =
    variant === "sheet" ||
    (!dismissed && (phase === "loading" || phase === "done"));

  // Desktop lives in the ink nav bar: a translucent paper-on-ink field.
  // Square corners; keyboard focus gets the system-wide gold ring.
  const inputClasses =
    variant === "desktop"
      ? "h-9 w-full border border-paper/20 bg-paper/10 pl-9 pr-9 text-sm text-paper placeholder:text-paper/50 focus:border-paper/40 focus:bg-paper/15 focus:outline-none focus-visible:outline-2 focus-visible:outline-gold"
      : "border-rule h-11 w-full border bg-paper pl-10 pr-10 text-base text-ink placeholder:text-ink-muted focus:border-ink/40 focus:outline-none focus-visible:outline-2 focus-visible:outline-gold";

  const iconClasses =
    variant === "desktop"
      ? "pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-paper/50"
      : "pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-muted";

  const clearClasses =
    variant === "desktop"
      ? "absolute right-2 top-1/2 -translate-y-1/2 p-1 text-paper/50 hover:bg-paper/10 hover:text-paper"
      : "absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-ink-muted hover:bg-sand hover:text-ink";

  return (
    <div
      ref={containerRef}
      className={cn("relative", variant === "desktop" && "w-full")}
    >
      <div className="relative">
        <Search className={iconClasses} aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setDismissed(false)}
          placeholder="Search bills or members"
          className={inputClasses}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={showDropdown && items.length > 0}
          aria-controls="global-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `global-search-item-${activeIndex}` : undefined
          }
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              reset();
              inputRef.current?.focus();
            }}
            className={clearClasses}
            aria-label="Clear search"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {showDropdown && (
        <SearchResults
          items={items}
          phase={phase}
          query={query}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          onSelect={navigateTo}
          variant={variant}
        />
      )}
    </div>
  );
}

interface SearchResultsProps {
  items: FlatItem[];
  phase: SearchState["phase"];
  query: string;
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  onSelect: (href: string) => void;
  variant: "desktop" | "sheet";
}

function SearchResults({
  items,
  phase,
  query,
  activeIndex,
  setActiveIndex,
  onSelect,
  variant,
}: SearchResultsProps) {
  const reps = items.filter(
    (i): i is Extract<FlatItem, { kind: "rep" }> => i.kind === "rep",
  );
  const billItems = items.filter(
    (i): i is Extract<FlatItem, { kind: "bill" }> => i.kind === "bill",
  );
  const seeAllBills = items.find((i) => i.kind === "see-all-bills");

  // Popover on paper with a rule hairline — flat and square, no shadow.
  const wrapperClasses =
    variant === "desktop"
      ? "border-rule absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[70vh] overflow-y-auto border bg-paper py-2"
      : "mt-3 max-h-[70vh] overflow-y-auto";

  if (phase === "loading" && items.length === 0) {
    return (
      <div className={wrapperClasses} id="global-search-listbox" role="listbox">
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-4 py-3" role="presentation">
            <div
              className="bg-rule/60 h-4 animate-pulse"
              style={{ width: `${75 - i * 15}%` }}
            />
          </div>
        ))}
      </div>
    );
  }

  if (
    phase === "done" &&
    items.length === 0 &&
    query.trim().length >= MIN_QUERY
  ) {
    return (
      <div className={wrapperClasses} id="global-search-listbox" role="listbox">
        <div className="text-ink-muted px-4 py-6 text-center text-sm">
          No matches for{" "}
          <span className="text-ink font-medium">
            &ldquo;{query.trim()}&rdquo;
          </span>
        </div>
      </div>
    );
  }

  if (items.length === 0) return null;

  return (
    <div className={wrapperClasses} id="global-search-listbox" role="listbox">
      {reps.length > 0 && <SectionHeader>Members</SectionHeader>}
      {reps.map((item) => {
        const idx = items.indexOf(item);
        return (
          <RepRow
            key={`rep-${item.rep.bioguideId}`}
            id={`global-search-item-${idx}`}
            rep={item.rep}
            active={idx === activeIndex}
            onMouseEnter={() => setActiveIndex(idx)}
            onSelect={() => onSelect(item.href)}
          />
        );
      })}

      {billItems.length > 0 && <SectionHeader>Bills</SectionHeader>}
      {billItems.map((item) => {
        const idx = items.indexOf(item);
        return (
          <BillRow
            key={`bill-${item.bill.id}`}
            id={`global-search-item-${idx}`}
            bill={item.bill}
            active={idx === activeIndex}
            onMouseEnter={() => setActiveIndex(idx)}
            onSelect={() => onSelect(item.href)}
          />
        );
      })}

      {seeAllBills && (
        <SeeAllRow
          id={`global-search-item-${items.indexOf(seeAllBills)}`}
          query={query}
          active={items.indexOf(seeAllBills) === activeIndex}
          onMouseEnter={() => setActiveIndex(items.indexOf(seeAllBills))}
          onSelect={() => onSelect(seeAllBills.href)}
        />
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-ink-muted px-4 pt-2 pb-1 text-[11px] font-bold tracking-[0.18em] uppercase">
      {children}
    </div>
  );
}

interface RepRowProps {
  id: string;
  rep: RepSearchResult;
  active: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}

function RepRow({ id, rep, active, onMouseEnter, onSelect }: RepRowProps) {
  const chamberAndDistrict =
    rep.chamber === "senator"
      ? `Senator · ${rep.state}`
      : rep.district
        ? `Representative · ${rep.state}-${rep.district}`
        : `Representative · ${rep.state}`;

  return (
    <Link
      href={repHref(rep)}
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        // Prevent input blur before navigation fires.
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors",
        active ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <div className="border-ink bg-sand relative size-9 flex-shrink-0 overflow-hidden rounded-full border-[1.5px]">
        <RepPhoto
          bioguideId={rep.bioguideId}
          firstName={rep.firstName}
          lastName={rep.lastName}
          imgClassName="object-cover object-top"
          fallbackClassName="text-xs font-medium"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-ink truncate font-medium">
          {rep.firstName} {rep.lastName}
        </div>
        <div className="text-ink-muted truncate text-xs">
          {chamberAndDistrict}
        </div>
      </div>
      {/* Party is a letter in an identical ink-ring frame — never a
          colour (the encoding law). */}
      <span
        className="party-node party-node--sm"
        title={rep.party.replace("Democratic", "Democrat")}
        aria-label={rep.party.replace("Democratic", "Democrat")}
      >
        {partyLetter(rep.party)}
      </span>
    </Link>
  );
}

interface BillRowProps {
  id: string;
  bill: BillSummary;
  active: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}

function BillRow({ id, bill, active, onMouseEnter, onSelect }: BillRowProps) {
  const headline = pickBillHeadline(bill);
  const citation = formatBillNumber(bill.billType, bill.billId);
  const topic = getTopicForPolicyArea(bill.policyArea);

  return (
    <Link
      href={billHref(bill)}
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      className={cn(
        "relative flex cursor-pointer flex-col gap-0.5 px-4 py-2.5 text-sm transition-colors",
        active ? "bg-accent" : "hover:bg-accent",
      )}
    >
      {/* Topic line hue appears only as a thin left-margin bar — never a
          chip fill, never type. Unmapped topics get no bar. */}
      {topic?.line && (
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 w-[5px]", topic.line)}
        />
      )}
      <div className="flex items-center gap-2">
        {citation && (
          <span className="text-ink-muted bg-sand px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
            {citation}
          </span>
        )}
        <span className="text-ink line-clamp-1 font-medium">
          {headline.headline}
        </span>
      </div>
      {/* Stage plus momentum, in the card's words: a dormant or dead
          bill says so before anyone clicks through. */}
      <div className="text-ink-muted truncate pl-1 text-xs">
        {billStatusLine(bill)}
      </div>
    </Link>
  );
}

interface SeeAllRowProps {
  id: string;
  query: string;
  active: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}

function SeeAllRow({
  id,
  query,
  active,
  onMouseEnter,
  onSelect,
}: SeeAllRowProps) {
  return (
    <Link
      href={`/bills?search=${encodeURIComponent(query)}`}
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      className={cn(
        "border-rule mt-1 flex cursor-pointer items-center justify-between border-t px-4 py-2.5 text-sm transition-colors",
        active ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <span className="text-ink font-medium">See all bill matches</span>
      <span className="text-ink-muted text-xs">&rarr;</span>
    </Link>
  );
}

/**
 * Header search. Renders a visible input on md+ and a search-icon trigger
 * that opens a sheet on smaller screens. Both presentations share state
 * via a hook so a query started in one isn't lost when the viewport
 * changes (rotate phone, resize window).
 */
export function GlobalSearch() {
  const desktopState = useSearchState();
  const mobileState = useSearchState();
  const [sheetOpen, setSheetOpen] = useState(false);

  // `/` focuses the desktop input, GitHub-style. Skipped when the user
  // is already in a text input or contenteditable so writing about
  // fractions doesn't hijack focus.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      const desktopInput = document.querySelector<HTMLInputElement>(
        '[data-global-search-input="desktop"]',
      );
      if (desktopInput) {
        e.preventDefault();
        desktopInput.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      {/* Desktop: visible input in the navbar */}
      <div className="hidden max-w-md flex-1 md:block">
        <div data-global-search-wrapper="desktop">
          <SearchInputWithDataAttr
            state={desktopState}
            variant="desktop"
            attr="desktop"
          />
        </div>
      </div>

      {/* Mobile: icon button → sheet */}
      <div className="md:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <button
                type="button"
                aria-label="Search"
                className="text-paper/60 hover:bg-paper/10 hover:text-paper flex size-8 cursor-pointer items-center justify-center transition-colors"
              />
            }
          >
            <Search className="size-[18px]" />
          </SheetTrigger>
          <SheetContent showCloseButton={false} className="p-4">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <SearchInputWithDataAttr
                  state={mobileState}
                  variant="sheet"
                  attr="mobile"
                  autoFocus
                  onNavigate={() => setSheetOpen(false)}
                />
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="text-ink-muted hover:text-ink px-2 py-1 text-sm"
              >
                Cancel
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

/**
 * Wrap SearchInput so we can stamp a data attr on the underlying <input>
 * without polluting the SearchInput API surface — only used by the `/`
 * focus shortcut to find the desktop input.
 */
function SearchInputWithDataAttr({
  attr,
  ...props
}: SearchInputProps & { attr: "desktop" | "mobile" }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = wrapperRef.current?.querySelector("input");
    if (input) input.setAttribute("data-global-search-input", attr);
  }, [attr]);
  return (
    <div ref={wrapperRef}>
      <SearchInput {...props} />
    </div>
  );
}
