"use client";

import { useEffect, useState, type ReactNode } from "react";

import {
  AiChatbox,
  type ChatSectionContext,
} from "@/components/chat/ai-chatbox";
import { ReaderChatButton } from "./reader-chat-button";
import { ReaderBottomBar } from "./reader-bottom-bar";
import { OutlineSheet } from "./outline-sheet";
import { pathFromHeading } from "@/lib/section-slug";
import type { OutlineEntry } from "./outline-tree";

/**
 * Owns the reader's sheet open states (outline + chat) and renders
 * the desktop / mobile triggers + sheets cohesively. Exists because:
 *
 *   - The desktop floating "Ask AI" button and the mobile bottom-bar
 *     "Ask AI" button must share open state with the chat sheet.
 *   - The mobile bottom-bar "Outline" button needs to share open state
 *     with `<OutlineSheet>`.
 *
 * Wraps the server-rendered article (passed via `children`) so the
 * shell layout stays in `<BillReader>` (server) where it can compute
 * data-derived classes / props without forcing the whole tree to
 * client.
 */
export function ReaderInteractive({
  billId,
  outlineEntries,
  congressGovUrl,
  children,
}: {
  billId: number;
  outlineEntries: OutlineEntry[];
  congressGovUrl: string | null;
  children: ReactNode;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [sectionContext, setSectionContext] =
    useState<ChatSectionContext | null>(null);

  // Event delegation: the per-section "Ask AI about this section"
  // affordance is a server-rendered `<button data-section-ask-ai>`
  // inside each section. Catching the click here (vs. wiring a click
  // prop into every server-rendered SectionRenderer) keeps the section
  // tree fully RSC-renderable and avoids one client island per
  // section.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>(
        "button[data-section-ask-ai]",
      );
      if (!button) return;
      const slug = button.dataset.sectionSlug;
      if (!slug) return;

      // Walk up to the section to recover the full heading and split
      // back into a path. The slug alone isn't enough for the chat's
      // section-context chip text.
      const sectionEl = button.closest<HTMLElement>(
        "section[data-section-slug]",
      );
      const heading = sectionEl?.dataset.sectionHeading ?? "";
      const sectionPath = pathFromHeading(heading);
      if (sectionPath.length === 0) return;

      // When the Ask-AI button lives inside a `<summary>` of a
      // collapsible group, a plain click would also toggle the
      // `<details>`. Stop propagation so the chat opens without
      // the section silently collapsing/expanding under the user.
      e.preventDefault();
      e.stopPropagation();
      setSectionContext({ sectionId: slug, sectionPath });
      setChatOpen(true);
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return (
    <>
      {children}

      <ReaderChatButton onClick={() => setChatOpen(true)} />

      <ReaderBottomBar
        onOpenOutline={() => setOutlineOpen(true)}
        onOpenChat={() => setChatOpen(true)}
      />

      <OutlineSheet
        open={outlineOpen}
        onOpenChange={setOutlineOpen}
        entries={outlineEntries}
        congressGovUrl={congressGovUrl}
      />

      <AiChatbox
        billId={billId}
        mode="reader"
        controlledOpen={chatOpen}
        onOpenChange={setChatOpen}
        sectionContext={sectionContext}
        onClearSectionContext={() => setSectionContext(null)}
      />
    </>
  );
}
