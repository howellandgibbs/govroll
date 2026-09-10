"use client";

import { useQuery } from "@tanstack/react-query";
import { resolveOverall } from "@/components/congress-status/resolve";
import type { CongressStatusResponse } from "@/app/api/congress/status/route";
import {
  CONGRESS_STATUS_QUERY_KEY,
  fetchCongressStatus,
} from "@/components/congress-status/status-query";

/**
 * System banner (guide §10) — the full-bleed strip directly under the nav
 * that states a session-status fact: a named recess, a shutdown, a new
 * Congress. It is the only illustrated surface and the only large gold
 * area in the system. Not dismissible, one at a time, never promotional.
 *
 * Gate: identical to the inline RecessNotice — render only for the
 * calendar-confirmed `recess` status (never `no_session`, so it can't cry
 * wolf every Saturday). No poll of its own: it reads the React Query cache
 * the NavBar pill keeps warm.
 */
export function SystemBanner() {
  const { data } = useQuery<CongressStatusResponse>({
    queryKey: CONGRESS_STATUS_QUERY_KEY,
    queryFn: fetchCongressStatus,
    staleTime: 30_000,
  });

  const resolved = resolveOverall(data);
  if (resolved.status !== "recess") return null;

  const winner = resolved.primaryChamber
    ? data?.chambers[resolved.primaryChamber]
    : null;
  const detail = winner?.detail ?? null;

  return (
    <section
      aria-label="Session status"
      className="bg-gold/30 border-ink relative overflow-hidden border-b-2"
    >
      {/* The text/illustration split is measured against the centered
          max-w-6xl wrapper, not the full-bleed section: percentage padding
          on the wrapper resolves against the *section's* width, so at wide
          viewports a `pr-[46%]` ate the whole capped wrapper and the copy
          wrapped one word per line. Anchoring the image to the wrapper keeps
          the copy at ≥52% of the wrapper no matter how wide the window is. */}
      <div className="relative mx-auto flex max-w-6xl flex-col justify-center px-6 py-7 min-[900px]:min-h-[160px]">
        {/* Illustration — starts at 54% of the wrapper and bleeds off the
            right edge of the viewport (`right: calc(50% - 50vw)` reaches
            from the centered wrapper to the window edge; the section's
            overflow-hidden clips the rest). Decorative only; the text
            carries the whole fact. Hidden below 900px, where the banner
            becomes text-only. */}
        {/* The frame is a div, not the <img>: an absolutely positioned
            replaced element with auto width keeps its intrinsic width and
            ignores `right`, so only a non-replaced box stretches between
            the two insets. */}
        <div
          aria-hidden
          className="border-ink absolute top-0 right-[calc(50%-50vw)] bottom-0 left-[54%] hidden border-l-2 min-[900px]:block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/illos/illo-2.jpg"
            alt=""
            className="h-full w-full object-cover object-left-bottom"
          />
        </div>

        <div className="flex flex-col gap-1.5 min-[900px]:max-w-[52%]">
          <p className="text-ink/70 text-[10.5px] font-bold tracking-[0.18em] uppercase">
            Session status
          </p>
          <h2 className="wdth-118 text-ink text-[30px] leading-none tracking-tight">
            Congress in recess
          </h2>
          <p className="text-ink max-w-xl text-sm leading-relaxed">
            {detail ? `${detail}. ` : ""}
            {resolved.nextTransitionLabel
              ? `${resolved.nextTransitionLabel}. `
              : ""}
            Votes and floor action are paused, so the latest activity below may
            look a few days old — new bills still appear as they&apos;re
            introduced.
          </p>
        </div>
      </div>
    </section>
  );
}
