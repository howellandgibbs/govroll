import "dotenv/config";
import {
  fetchBillIntroducedDate,
  fetchCongressBillsByUpdate,
  isTransientCongressError,
  type CongressListBill,
} from "../lib/congress-api";
import { createStandalonePrisma } from "../lib/prisma-standalone";
import dayjs, { type Dayjs } from "dayjs";

const prisma = createStandalonePrisma();

// Tunables for the cursor-driven chunked ingest, sized to fit under the cron
// route's 300s Fluid Compute maxDuration: 6-hour windows (small enough that
// each window's fetch + upserts finish quickly and the cursor advances after
// every window, so a slow Congress.gov patch — or a dense backlog window full
// of brand-new bills, each needing a detail call — can't wedge progress
// mid-run), a 48-hour rewind on each run so late-arriving updates don't slip
// the cursor, and a 280s deadline enforced as a hard AbortSignal — see
// fetchBillsFunction — not just a cooperative time check an in-flight request
// can overrun.
const WINDOW_HOURS = 6;
const LOOKBACK_HOURS = 48;
// When the saved cursor is further behind than this, skip the LOOKBACK_HOURS
// rewind entirely (see fetchBillsFunction). Sized one window past the rewind so
// we never flap between rewind / no-rewind around the boundary.
const CATCHUP_THRESHOLD_HOURS = LOOKBACK_HOURS + WINDOW_HOURS;
const BACKSTOP_DAYS = 14;
const DEADLINE_MS = 280_000;
const UPSERT_CONCURRENCY = 8;
const CURSOR_KEY = "fetch-bills";

// Congress.gov returns billType uppercase (HR, S, HJRES, …). We keep the
// GovTrack-shape billType strings ("house_bill", "senate_bill", …) in the
// DB because the billId PK format depends on them and changing it would
// orphan every existing row.
const CONGRESS_TYPE_TO_GOVTRACK: Record<string, string> = {
  HR: "house_bill",
  S: "senate_bill",
  HJRES: "house_joint_resolution",
  SJRES: "senate_joint_resolution",
  HCONRES: "house_concurrent_resolution",
  SCONRES: "senate_concurrent_resolution",
  HRES: "house_resolution",
  SRES: "senate_resolution",
};

const GOVTRACK_TO_API_BILL_TYPE: Record<string, string> = {
  house_bill: "hr",
  senate_bill: "s",
  house_joint_resolution: "hjres",
  senate_joint_resolution: "sjres",
  house_concurrent_resolution: "hconres",
  senate_concurrent_resolution: "sconres",
  house_resolution: "hres",
  senate_resolution: "sres",
};

export interface FetchBillsResult {
  processed: number;
  created: number;
  updated: number;
  windows: number;
  cursor: Date;
  done: boolean;
  timedOut: boolean;
  /** Stopped early on a TRANSIENT Congress.gov error — 429 (quota), a 5xx
   *  (origin/Cloudflare hiccup, incl. 520-526), or a network drop. Not a
   *  failure: the cursor is preserved and the next run resumes once upstream
   *  recovers. A sustained outage surfaces via the ingest-health watchdog
   *  (stale cursor), not here. */
  upstreamPaused: boolean;
  elapsedMs: number;
}

/**
 * Cursor-driven ingest of bills from Congress.gov.
 *
 * Walks `updateDate` windows (not `introducedDate`) so the feed surfaces
 * both newly introduced bills and existing bills with new action — one
 * pass keeps every row in sync.
 *
 *   1. Read (or initialize) an IngestCursor row holding the last
 *      `updateDate` we processed. First run backstops `BACKSTOP_DAYS` ago.
 *   2. Rewind `LOOKBACK_HOURS` from that cursor before walking forward,
 *      so updates that arrived after our last pass don't slip through.
 *      Upserts are idempotent — re-seeing a bill is free.
 *   3. Step forward in `WINDOW_HOURS` slices, fetching the Congress.gov
 *      `/bill` list endpoint and upserting in parallel chunks.
 *   4. Bail at `DEADLINE_MS` with the cursor advanced to wherever we got.
 *      The next cron invocation resumes from there.
 *
 * Replaces the previous GovTrack-backed implementation, which lagged
 * Congress.gov by 3–5 days because GovTrack scrapes the official source
 * on its own delayed schedule.
 *
 * When `billIds` is provided (CLI/manual invocation), re-ingests those
 * specific bills and ignores the cursor.
 */
export async function fetchBillsFunction(
  billIds?: string[],
): Promise<FetchBillsResult | void> {
  if (billIds && billIds.length > 0) {
    await fetchSpecificBills(billIds);
    return;
  }

  const started = Date.now();
  const now = dayjs();

  // Enforce the 280s budget as a hard AbortSignal, not just the cooperative
  // `Date.now()` checks below. Those checks only fire BETWEEN network calls, so
  // a single slow window fetch (15s axios timeout × up to 3 withRetry attempts
  // ≈ 48s) could run past the 300s Fluid maxDuration before the next check.
  // Aborting in-flight Congress.gov requests at the deadline caps that tail so
  // we always return under the cap.
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), DEADLINE_MS);

  const cursorRow = await prisma.ingestCursor.findUnique({
    where: { key: CURSOR_KEY },
  });
  // Normally rewind LOOKBACK_HOURS from the saved cursor. Congress.gov
  // re-surfaces a bill into the updateDate feed when ANY field changes,
  // and those edits commonly land hours after the bill first appeared.
  // Without the rewind, we'd miss the late-arriving update and never
  // re-check that window.
  //
  // EXCEPT while catching up from a large gap (e.g. after an ingest outage).
  // A single 50s run only clears ~LOOKBACK_HOURS worth of dense, in-session
  // windows, so the rewind exactly cancels the forward progress and the cursor
  // livelocks — it re-walks the same 48h every run and never crosses the gap.
  // When the cursor is more than CATCHUP_THRESHOLD_HOURS behind, drop the
  // rewind so every run moves strictly forward; it resumes automatically once
  // we're back within the threshold (late-update capture matters again, and the
  // sparse current feed clears many windows per run, so there's no livelock).
  const caughtUp =
    !cursorRow ||
    dayjs(cursorRow.cursor).isAfter(
      now.subtract(CATCHUP_THRESHOLD_HOURS, "hour"),
    );
  const lookbackHours = caughtUp ? LOOKBACK_HOURS : 0;
  let windowStart: Dayjs = cursorRow
    ? dayjs(cursorRow.cursor).subtract(lookbackHours, "hour")
    : now.subtract(BACKSTOP_DAYS, "day");

  let processed = 0;
  let created = 0;
  let updated = 0;
  let windows = 0;
  let timedOut = false;
  let upstreamPaused = false;

  try {
    while (windowStart.isBefore(now)) {
      if (Date.now() - started > DEADLINE_MS) {
        timedOut = true;
        break;
      }

      const tentativeEnd = windowStart.add(WINDOW_HOURS, "hour");
      const windowEnd = tentativeEnd.isAfter(now) ? now : tentativeEnd;

      let bills: CongressListBill[];
      try {
        bills = await fetchCongressBillsByUpdate({
          fromDateTime: toCongressIso(windowStart),
          toDateTime: toCongressIso(windowEnd),
          signal: controller.signal,
        });
      } catch (err) {
        // A deadline abort surfaces here as an axios cancel. Treat it like the
        // cooperative check: bail cleanly with the cursor left at the last
        // completed window, so the next run resumes from there.
        if (controller.signal.aborted) {
          timedOut = true;
          break;
        }
        // A transient upstream error — 429 (quota), a 5xx (origin/Cloudflare
        // hiccup, incl. 520-526), or a network drop — is backpressure, not a
        // failure. Stop cleanly with the cursor at the last completed window and
        // let the next 3-hourly run resume once upstream recovers, exactly like
        // the deadline path. Without this these propagated to a 500 and paged on
        // every occurrence; a SUSTAINED outage still surfaces via the
        // ingest-health watchdog (the cursor goes stale).
        if (isTransientCongressError(err)) {
          upstreamPaused = true;
          break;
        }
        throw err;
      }

      try {
        for (let i = 0; i < bills.length; i += UPSERT_CONCURRENCY) {
          if (Date.now() - started > DEADLINE_MS) {
            timedOut = true;
            break;
          }
          const chunk = bills.slice(i, i + UPSERT_CONCURRENCY);
          const results = await Promise.all(
            chunk.map((b) => upsertBillFromList(b, controller.signal)),
          );
          processed += results.length;
          for (const r of results) {
            if (r === "created") created++;
            else if (r === "updated") updated++;
          }
        }
      } catch (err) {
        // The CREATE path calls fetchBillIntroducedDate, which re-throws a 429
        // (it must not launder a quota outage into a missing date). Handle it
        // here the same way as the list-fetch above: a transient upstream stop
        // is clean and resumable, an abort is the deadline, anything else is a
        // real failure.
        if (controller.signal.aborted) {
          timedOut = true;
          break;
        }
        if (isTransientCongressError(err)) {
          upstreamPaused = true;
          break;
        }
        throw err;
      }

      if (timedOut || upstreamPaused) break;

      await prisma.ingestCursor.upsert({
        where: { key: CURSOR_KEY },
        update: { cursor: windowEnd.toDate() },
        create: { key: CURSOR_KEY, cursor: windowEnd.toDate() },
      });

      windowStart = windowEnd;
      windows++;
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  const elapsedMs = Date.now() - started;
  return {
    processed,
    created,
    updated,
    windows,
    cursor: windowStart.toDate(),
    done: !timedOut && !upstreamPaused && !windowStart.isBefore(now),
    timedOut,
    upstreamPaused,
    elapsedMs,
  };
}

function toCongressIso(d: Dayjs): string {
  // Congress.gov's `/bill` endpoint wants "YYYY-MM-DDTHH:mm:ssZ".
  // dayjs.toISOString() includes milliseconds, which the endpoint silently
  // ignores but isn't part of the documented format — strip them so the
  // value matches the docs and the test fixtures.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function fetchSpecificBills(billIds: string[]): Promise<void> {
  console.log(`Fetching ${billIds.length} specific bills:`, billIds);
  for (const billId of billIds) {
    try {
      const synthetic = await buildListBillFromBillId(billId);
      if (!synthetic) {
        console.warn(`No bill found for ${billId}`);
        continue;
      }
      await upsertBillFromList(synthetic);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error fetching bill ${billId}:`, msg);
    }
  }
}

async function buildListBillFromBillId(
  billId: string,
): Promise<CongressListBill | null> {
  const parts = billId.split("-");
  if (parts.length < 3) return null;
  const [govTrackType, numberStr, congressStr] = parts;
  const apiBillType = GOVTRACK_TO_API_BILL_TYPE[govTrackType];
  const number = parseInt(numberStr, 10);
  const congress = parseInt(congressStr, 10);
  if (!apiBillType || !number || !congress) return null;

  const introducedDate = await fetchBillIntroducedDate(
    congress,
    apiBillType,
    number,
  );
  if (!introducedDate) return null;

  const congressType = Object.entries(CONGRESS_TYPE_TO_GOVTRACK).find(
    ([, v]) => v === govTrackType,
  )?.[0];
  if (!congressType) return null;

  // Synthetic list-shaped record so the CLI path can reuse upsertBillFromList.
  // Title is left as a placeholder — the refresh-bill-metadata cron will fill
  // in the real title from /bill/{c}/{t}/{n}/titles on its next pass.
  return {
    congress,
    number: numberStr,
    type: congressType,
    originChamberCode: govTrackType.startsWith("house") ? "H" : "S",
    title: "(pending refresh)",
    updateDate: introducedDate,
    latestAction: { actionDate: introducedDate, text: "Introduced" },
  };
}

async function upsertBillFromList(
  listBill: CongressListBill,
  signal?: AbortSignal,
): Promise<"created" | "updated" | "skipped"> {
  const govTrackType = CONGRESS_TYPE_TO_GOVTRACK[listBill.type.toUpperCase()];
  if (!govTrackType) {
    console.warn(`Unknown Congress.gov bill type: ${listBill.type}`);
    return "skipped";
  }
  const number = parseInt(listBill.number, 10);
  if (!number) return "skipped";

  const billId = `${govTrackType}-${number}-${listBill.congress}`;
  const apiBillType = GOVTRACK_TO_API_BILL_TYPE[govTrackType];

  const latestActionDate = listBill.latestAction?.actionDate
    ? new Date(listBill.latestAction.actionDate)
    : null;

  const existing = await prisma.bill.findUnique({
    where: { billId },
    select: { id: true },
  });

  if (existing) {
    // UPDATE — refresh only the fields the list endpoint owns. Don't touch
    // currentStatus / sponsor / metadata; those are managed by
    // refresh-bill-metadata and stomping them every cron tick would
    // overwrite enriched data with the leaner list response.
    await prisma.bill.update({
      where: { billId },
      data: {
        title: listBill.title,
        latestActionText: listBill.latestAction?.text ?? null,
        latestActionDate,
      },
    });
    return "updated";
  }

  // CREATE — list endpoint omits introducedDate. One extra detail call per
  // truly-new bill (chunked at UPSERT_CONCURRENCY so we don't burst the API).
  let introducedDateStr = await fetchBillIntroducedDate(
    listBill.congress,
    apiBillType,
    number,
    signal,
  );
  // Fall back to latestAction.actionDate if the detail endpoint errored —
  // we'd rather create the row with an approximate date than skip a fresh
  // bill on a transient 5xx.
  if (!introducedDateStr && listBill.latestAction?.actionDate) {
    introducedDateStr = listBill.latestAction.actionDate;
  }
  if (!introducedDateStr) return "skipped";

  const introducedDate = new Date(introducedDateStr);
  const chamber =
    listBill.originChamberCode === "H"
      ? "house"
      : listBill.originChamberCode === "S"
        ? "senate"
        : null;
  const link = `https://www.congress.gov/bill/${listBill.congress}th-congress/${govTrackType.replace(/_/g, "-")}/${number}`;

  try {
    await prisma.bill.create({
      data: {
        billId,
        title: listBill.title,
        date: introducedDate,
        billType: govTrackType,
        currentChamber: chamber,
        currentStatus: "introduced",
        currentStatusDate: latestActionDate ?? introducedDate,
        introducedDate,
        link,
        latestActionText: listBill.latestAction?.text ?? null,
        latestActionDate,
        congressNumber: listBill.congress,
      },
    });
    return "created";
  } catch (error) {
    // Lose the race against a concurrent create? Treat as update so the
    // chunk doesn't fail; the row already exists.
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Unique constraint")) {
      await prisma.bill.update({
        where: { billId },
        data: {
          title: listBill.title,
          latestActionText: listBill.latestAction?.text ?? null,
          latestActionDate,
        },
      });
      return "updated";
    }
    console.error(`Error creating bill ${billId}:`, msg);
    return "skipped";
  }
}

// CLI invocation
if (require.main === module) {
  const billIds = process.argv.slice(2);
  fetchBillsFunction(billIds.length > 0 ? billIds : undefined)
    .then((result) => {
      if (result) {
        console.log("Result:", JSON.stringify(result, null, 2));
      }
    })
    .finally(() => prisma.$disconnect());
}
