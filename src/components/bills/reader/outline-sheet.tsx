"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OutlineTree, type OutlineEntry } from "./outline-tree";
import { SourceLinks } from "./source-links";

/**
 * Mobile / tablet outline sheet wrapping `<OutlineTree>`. Opened from
 * the `<ReaderBottomBar>` on small screens; desktop (≥lg) gets the
 * persistent `<OutlineRail>` instead.
 *
 * The shared `<Sheet>` primitive renders full-screen on mobile and
 * right-edge slide-over on tablets — both are appropriate for outline
 * browsing. Auto-closes when the user picks a section so the
 * jumped-to heading is visible behind the now-dismissed sheet.
 *
 * A "Sources" block sits at the bottom of the sheet (parity with the
 * desktop rail) so mobile users discover the same attribution surface
 * via the same affordance.
 */
export function OutlineSheet({
  open,
  onOpenChange,
  entries,
  congressGovUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: OutlineEntry[];
  congressGovUrl: string | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Outline</SheetTitle>
        </SheetHeader>
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <OutlineTree
            entries={entries}
            onItemClick={() => onOpenChange(false)}
          />
          <div className="border-rule mt-6 border-t pt-4">
            <SourceLinks congressGovUrl={congressGovUrl} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
