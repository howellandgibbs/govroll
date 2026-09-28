import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { fetchVotesFunction } from "@/scripts/fetch-votes";
import { reportError } from "@/lib/error-reporting";
import { isTransientCongressError } from "@/lib/congress-api";

/**
 * Dedicated votes-only cron.
 *
 * The main /api/cron/fetch-data runs once a day and handles bills,
 * bill text, cosponsors, momentum, etc. Votes trail at stage 7,
 * which means a recorded roll call that happens right after the
 * cron fires may not appear on the site for ~24 hours — and if the
 * earlier stages exhaust the time budget, the votes stage can get
 * skipped entirely.
 *
 * For the "how did my rep vote?" question — the thing citizens
 * actually care about — that's too slow. This endpoint runs votes
 * in isolation every few hours so a Senate roll call at 6pm ET
 * shows up by 10pm ET, not the next morning.
 *
 * Idempotent: fetchVotesFunction upserts by (representativeId,
 * billId, rollCallNumber), so overlapping windows are fine.
 *
 * Resumable: fetchVotesFunction reads/advances an IngestCursor row and walks
 * from min(saved cursor, now - 2d). The default path re-walks the last ~2
 * days (self-heal for a missed run); a cursor stalled by a longer outage is
 * honored so no roll call in the gap is lost. Pass `?since=YYYY-MM-DD` to
 * force a deep backfill from an explicit date — it advances the cursor
 * per-day, so a backfill bigger than one run's budget resumes on the next.
 *
 * Transient GovTrack failures (timeouts, dropped connections, 429/5xx) are
 * non-paging, same as the Congress.gov crons: the run stops with the cursor
 * where it was and the next hourly run re-walks the day. These used to email
 * an alert once or twice a day. A sustained outage still pages — the
 * ingest-health watchdog alerts when the fetch-votes cursor stops advancing.
 */

export const maxDuration = 60;

// Soft budget below the 60s Hobby cap. The day loop breaks cleanly between
// days when exceeded, leaving the cursor at the last fully-ingested day, so a
// large backfill is hard-killed neither mid-write nor without progress.
const DEADLINE_MS = 50_000;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("CRON_SECRET is not configured");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const auth = request.headers.get("authorization");
  if (!timingSafeEqualStr(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Optional deep-backfill start, e.g. ?since=2025-01-01 from a manual
  // workflow_dispatch. Strict YYYY-MM-DD; anything else is a 400 so a typo
  // doesn't silently fall back to the default window.
  const sinceParam = new URL(request.url).searchParams.get("since");
  let since: Date | undefined;
  if (sinceParam !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
      return NextResponse.json(
        { ok: false, error: `invalid since (want YYYY-MM-DD): ${sinceParam}` },
        { status: 400 },
      );
    }
    const parsed = new Date(`${sinceParam}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { ok: false, error: `invalid since: ${sinceParam}` },
        { status: 400 },
      );
    }
    since = parsed;
  }

  const start = Date.now();

  try {
    await fetchVotesFunction({ since, deadlineMs: DEADLINE_MS });
    const ms = Date.now() - start;
    console.log(`[fetch-votes cron] completed in ${ms}ms`);
    return NextResponse.json({ ok: true, ms });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isTransientCongressError(error)) {
      // The classifier is generic over axios errors, so it covers GovTrack.
      console.warn(
        `[fetch-votes cron] stopped on a transient GovTrack error (${msg}); cursor preserved, resuming next run`,
      );
      return NextResponse.json({
        ok: true,
        ms: Date.now() - start,
        upstreamPaused: true,
      });
    }
    console.error(`[fetch-votes cron] failed:`, msg);
    await reportError(error instanceof Error ? error : new Error(msg), {
      context: "fetch-votes cron",
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
