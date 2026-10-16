"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { SectionRenderer } from "./section-renderer";
import { CollapsibleTopSection } from "./collapsible-top-section";
import { ExpandCollapseAll } from "./expand-collapse-all";
import { DeepLinkScroller } from "./deep-link-scroller";
import { ScrollSpyProvider } from "./scroll-spy";
import { StickyBreadcrumb } from "./sticky-breadcrumb";
import { OutlineRail } from "./outline-rail";
import { SelectionPopover } from "./selection-popover";
import { ReaderInteractive } from "./reader-interactive";
import { ReaderHeaderMeta } from "./reader-header-meta";
import { congressGovBillTextUrl } from "@/lib/bills/url";
import type {
  ReaderBillMeta,
  ReaderSection,
  ReaderVersionListEntry,
  ReaderVersionMeta,
} from "./reader-types";

/**
 * Client shell for the bill reader.
 *
 * The RSC page server-renders the *latest* text-bearing version into this
 * component's initial props, so the full bill text is in the initial HTML
 * (SEO) and the whole route stays full-route ISR-cacheable — the page no
 * longer reads `searchParams`, which previously opted it into dynamic
 * rendering and defeated the documented 1-hour cache.
 *
 * Version switching (`?v=`) and the section deep link (`?section=`) are
 * handled here on the client:
 *   - The version picker fetches the chosen version's sections from
 *     `/api/bills/[id]/text-versions/[versionCode]` and swaps them in,
 *     pushing the URL so it stays shareable and the back button steps
 *     through versions — all without a server round-trip.
 *   - A `?v=` present on first load (a shared older-version link) is read
 *     on mount and fetched, since the server rendered the latest.
 *   - `?section=` is read client-side by <DeepLinkScroller>.
 */
export function BillReader({
  bill,
  initialVersion,
  availableVersions,
  initialSections,
  latestVersionCode,
}: {
  bill: ReaderBillMeta;
  initialVersion: ReaderVersionMeta;
  availableVersions: ReaderVersionListEntry[];
  initialSections: ReaderSection[];
  /** versionCode of the server-rendered latest version — the canonical
   *  URL carries no `?v=`, every other version does. */
  latestVersionCode: string;
}) {
  const [sections, setSections] = useState(initialSections);
  const [version, setVersion] = useState(initialVersion);
  const [loadingVersionCode, setLoadingVersionCode] = useState<string | null>(
    null,
  );

  const loadVersion = useCallback(
    async (versionCode: string, pushHistory: boolean) => {
      if (versionCode === version.versionCode) return;
      setLoadingVersionCode(versionCode);
      try {
        const res = await fetch(
          `/api/bills/${bill.id}/text-versions/${encodeURIComponent(versionCode)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          version: Omit<ReaderVersionMeta, "versionDate"> & {
            versionDate: string;
          };
          sections: ReaderSection[];
        };
        setSections(data.sections);
        setVersion({
          ...data.version,
          versionDate: new Date(data.version.versionDate),
        });

        if (pushHistory) {
          // Keep the URL shareable + back/forward-navigable without a
          // server round-trip. Latest is the canonical URL (no ?v=).
          const url = new URL(window.location.href);
          if (versionCode === latestVersionCode) {
            url.searchParams.delete("v");
          } else {
            url.searchParams.set("v", versionCode);
          }
          // The deep-link anchor is version-specific; drop it on a switch.
          url.searchParams.delete("section");
          window.history.pushState(null, "", url);
        }
      } catch {
        // Leave the current version in place on failure — the reader stays
        // usable and the picker re-enables in `finally`.
      } finally {
        setLoadingVersionCode(null);
      }
    },
    [bill.id, latestVersionCode, version.versionCode],
  );

  // A `?v=` on first load points at a non-latest version (the server
  // rendered the latest), so fetch and swap it in once on mount.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("v");
    if (requested && requested !== latestVersionCode) {
      void loadVersion(requested, false);
    }
    // Mount-only: re-running on loadVersion identity would re-fetch on
    // every successful swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward through version history: re-load whatever `?v=` the URL
  // now carries (or the latest when it's gone).
  useEffect(() => {
    function onPopState() {
      const requested =
        new URLSearchParams(window.location.search).get("v") ??
        latestVersionCode;
      void loadVersion(requested, false);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadVersion, latestVersionCode]);

  const slugsInOrder = useMemo(() => sections.map((s) => s.slug), [sections]);
  const outlineEntries = useMemo(
    () =>
      sections.map((s) => ({
        slug: s.slug,
        heading: s.heading,
        depth: s.depth,
        caption: s.caption,
      })),
    [sections],
  );
  const breadcrumbSections = useMemo(
    () => sections.map((s) => ({ slug: s.slug, heading: s.heading })),
    [sections],
  );
  const minutes = useMemo(() => readingMinutes(sections), [sections]);
  const groups = useMemo(() => groupByTopLevel(sections), [sections]);
  const autoExpandAll = useMemo(() => shouldAutoExpand(sections), [sections]);

  const congressGovUrl = congressGovBillTextUrl({ billId: bill.billId });

  return (
    <ScrollSpyProvider slugsInOrder={slugsInOrder}>
      <DeepLinkScroller />
      <SelectionPopover billId={bill.id} sections={breadcrumbSections} />

      <ReaderInteractive
        billId={bill.id}
        outlineEntries={outlineEntries}
        congressGovUrl={congressGovUrl}
      >
        <div className="bill-prose-page min-h-screen">
          <StickyBreadcrumb
            bill={{ billId: bill.billId, title: bill.title }}
            headline={bill.headline}
            sections={breadcrumbSections}
          />

          <div className="mx-auto flex max-w-[1280px] gap-8 px-4 sm:px-6 lg:gap-12">
            <OutlineRail
              entries={outlineEntries}
              congressGovUrl={congressGovUrl}
            />

            <main
              id="bill-reader-main"
              className="max-w-[72ch] min-w-0 flex-1 pt-6 pb-32 sm:pt-8 lg:pb-24"
            >
              <ReaderHeaderMeta
                bill={bill}
                version={version}
                availableVersions={availableVersions}
                sectionCount={sections.length}
                readingMinutes={minutes}
                onVersionChange={(code) => loadVersion(code, true)}
                pending={loadingVersionCode !== null}
                expandCollapseSlot={
                  groups.length > 1 ? <ExpandCollapseAll /> : null
                }
              />

              <article
                className="bill-prose"
                aria-label={`Full text of ${bill.headline}`}
              >
                {groups.map((group) => {
                  if (!group.head) {
                    // Orphans: subsections before any depth-1 heading.
                    // Rare, but render flat so content isn't lost.
                    return group.body.map((section) => (
                      <SectionRenderer key={section.slug} section={section} />
                    ));
                  }
                  return (
                    <CollapsibleTopSection
                      key={group.head.slug}
                      head={group.head}
                      body={group.body}
                      defaultOpen={autoExpandAll}
                    />
                  );
                })}
              </article>

              {congressGovUrl && (
                <SourceFooter congressGovUrl={congressGovUrl} />
              )}
            </main>
          </div>
        </div>
      </ReaderInteractive>
    </ScrollSpyProvider>
  );
}

/**
 * End-of-article attribution. The most important "Source" placement —
 * when a reader finishes the bill text and asks "where did this come
 * from?", the answer is right there in reading-flow order. The rail
 * Sources block is the always-visible counterpart for in-flight
 * verification.
 */
function SourceFooter({ congressGovUrl }: { congressGovUrl: string }) {
  return (
    <footer
      aria-label="Bill text source"
      className="text-ink-muted bill-prose-meta border-rule mt-12 border-t pt-4 text-xs"
    >
      <p>
        Source: <SourceFooterLink href={congressGovUrl} label="Congress.gov" />
      </p>
    </footer>
  );
}

function SourceFooterLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-ink inline-flex items-center gap-1 underline underline-offset-2"
    >
      {label}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

/**
 * Rough reading-time estimate. ~250 words/min is the conventional
 * average; legal text reads slower, but this is an orientation cue,
 * not a budget.
 */
function readingMinutes(sections: ReaderSection[]): number {
  const words = countWords(sections);
  return Math.max(1, Math.round(words / 250));
}

function countWords(sections: ReaderSection[]): number {
  return sections.reduce(
    (sum, s) => sum + s.content.split(/\s+/).filter(Boolean).length,
    0,
  );
}

interface TopLevelGroup {
  /** The depth-1 "head" section. May be null only when the bill begins
   *  with deeper sections before any depth-1 heading — a parser quirk
   *  we tolerate rather than lose content over. */
  head: ReaderSection | null;
  /** Every subsequent section (any depth ≥ 2, plus any depth-1 content
   *  split across a single logical group isn't supported — each depth-1
   *  starts a new group). */
  body: ReaderSection[];
}

/**
 * Walk the flat section list and partition it into top-level groups.
 * A new group starts at every depth-1 section; subsequent deeper
 * sections get attached to the most recent top-level until the next
 * depth-1 arrives.
 */
function groupByTopLevel(sections: ReaderSection[]): TopLevelGroup[] {
  const groups: TopLevelGroup[] = [];
  for (const section of sections) {
    if (section.depth === 1) {
      groups.push({ head: section, body: [] });
    } else if (groups.length > 0) {
      groups[groups.length - 1].body.push(section);
    } else {
      // Orphan (no depth-1 ancestor yet). Rare; keep content visible.
      groups.push({ head: null, body: [section] });
    }
  }
  return groups;
}

/**
 * Short bills read better fully expanded — the scroll cost is trivial
 * and readers see the whole thing at once. Long bills collapse by
 * default so the page doesn't feel overwhelming; the summary rail and
 * the AI captions on each collapsed group give readers enough to pick
 * what to expand.
 *
 * Thresholds: ≤12 groups OR ≤3,000 words of body text. Either of those
 * tends to mean the bill fits in a few screens at normal reading speed.
 */
function shouldAutoExpand(sections: ReaderSection[]): boolean {
  const topLevelCount = sections.filter((s) => s.depth === 1).length;
  if (topLevelCount === 0) return true;
  if (topLevelCount <= 12) return true;
  return countWords(sections) <= 3000;
}
