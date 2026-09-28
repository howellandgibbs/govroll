import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchBillTextFunction } from "@/scripts/fetch-bill-text";
import { parseBillIdentifier } from "@/lib/bills/url";
import { getCurrentCongress } from "@/lib/momentum";

/**
 * Cold-start threshold — if we haven't tried to fetch a bill's text within
 * this window, a page view is allowed to trigger a fresh attempt.
 *
 * The hourly cron covers the happy path; this exists for the case where a
 * user hits a brand-new bill before the cron has reached it, or a bill
 * the cron has repeatedly failed on (rotated to the back of the queue).
 */
const TRY_AGAIN_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long the text backfill cron waits before re-trying a bill from a
 * Congress that has already ended. Such a bill's text is either published
 * already (and fetched on the first attempt) or never coming — pre-2003 bills
 * have no machine-readable text at all — so ~12.5k of them cycling through the
 * hourly queue, plus page views re-trying them hourly, burned ~1,700 fetch
 * attempts a day (each several Congress.gov calls on the shared 5k/hr key and
 * a dozen GovInfo probes) for nothing.
 */
export const ENDED_CONGRESS_TEXT_RETRY_DAYS = 180;

/** True when the bill belongs to a Congress that has already ended. */
export function isFromEndedCongress(
  billId: string,
  now: Date = new Date(),
): boolean {
  const parsed = parseBillIdentifier(billId);
  return parsed !== null && parsed.congress < getCurrentCongress(now);
}

/**
 * If `bill` has no text and we haven't tried recently, kick off a fetch
 * after the response returns. Uses Next's `after()` so the fetch runs as
 * a background task on the same Vercel function instance (Fluid Compute)
 * without blocking the page render.
 *
 * Bills from an ended Congress get one attempt here, ever; after that the
 * backfill cron's slow lane (ENDED_CONGRESS_TEXT_RETRY_DAYS) owns retries.
 * Those page views are almost all crawlers sweeping the archive.
 *
 * Concurrency: we atomically "claim" the fetch by bumping the attempt
 * timestamp via updateMany WHERE the stale-timestamp predicate still
 * matches. Only the view that wins the claim runs the fetch; the rest
 * bail out, so N concurrent page loads don't produce N concurrent
 * Congress.gov requests.
 *
 * Safe to call unconditionally from the bill detail page's server
 * component — the claim query is a fast indexed update, and early-outs
 * cheaply when text is already present.
 */
export function maybeFetchBillTextInBackground(bill: {
  id: number;
  billId: string;
  hasFullText: boolean;
  textFetchAttemptedAt: Date | null;
}): void {
  if (bill.hasFullText) return;

  if (bill.textFetchAttemptedAt != null && isFromEndedCongress(bill.billId)) {
    return;
  }

  const staleAt = new Date(Date.now() - TRY_AGAIN_AFTER_MS);
  if (
    bill.textFetchAttemptedAt != null &&
    bill.textFetchAttemptedAt > staleAt
  ) {
    return;
  }

  after(async () => {
    try {
      // Atomic claim: only the request that flips the timestamp from
      // "stale" to "now" actually runs the fetch. updateMany returns
      // {count} so we can see whether we won the race.
      const claimed = await prisma.bill.updateMany({
        where: {
          id: bill.id,
          fullText: null,
          OR: [
            { textFetchAttemptedAt: null },
            { textFetchAttemptedAt: { lt: staleAt } },
          ],
        },
        data: { textFetchAttemptedAt: new Date() },
      });
      if (claimed.count === 0) return;

      // Share the request's long-lived pooled client — this can race the cron
      // over the same shared client, so fetchBillTextFunction must not
      // disconnect a client it didn't create. Both bill pages render per
      // request, so there's no cached page to revalidate afterwards.
      await fetchBillTextFunction(bill.billId, 1, prisma);
    } catch {
      // Swallow — the failure is already logged by fetchBillTextFunction,
      // and the claim timestamp we just wrote will prevent hot-looping.
    }
  });
}
