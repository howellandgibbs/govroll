import { OutlineTree, type OutlineEntry } from "./outline-tree";
import { SourceLinks } from "./source-links";

/**
 * Desktop-only left rail wrapping the `<OutlineTree>`. Sticky beneath
 * the breadcrumb, scrolls within its own viewport, doesn't compete
 * with the bill body for scroll. Hidden under `lg` (1024px) — at that
 * width the body needs the full measure and the outline lives in the
 * (Day 9) mobile bottom sheet instead.
 *
 * Server component — the sticky positioning and scrollbar handling
 * are pure CSS. The interactive bits (active highlighting, auto
 * scroll) live in the (client) `<OutlineTree>` underneath.
 *
 * The outline tree fills the top; a "Sources" attribution block pins
 * to the bottom (`mt-auto`). Sources is the answer to "where did this
 * text come from?" — keeping it always-visible-but-low-key matches
 * the convention on news long-reads and document viewers.
 */
export function OutlineRail({
  entries,
  congressGovUrl,
}: {
  entries: OutlineEntry[];
  congressGovUrl: string | null;
}) {
  return (
    <aside
      className="sticky top-[3.5rem] hidden h-[calc(100vh-3.5rem)] w-[280px] flex-none flex-col overflow-y-auto py-6 pr-2 lg:flex"
      aria-label="Bill sections"
    >
      <h2 className="text-ink-muted mb-3 px-2 font-sans text-[11px] font-bold tracking-[0.18em] uppercase">
        Outline
      </h2>
      <OutlineTree entries={entries} />
      <div className="border-rule mt-auto border-t pt-4">
        <SourceLinks congressGovUrl={congressGovUrl} />
      </div>
    </aside>
  );
}
