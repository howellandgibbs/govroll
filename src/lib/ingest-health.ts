/**
 * Ingest health evaluation — the detector for the failure modes the per-request
 * cron alerts can't see.
 *
 * The Congress.gov crons stop cleanly on a 429 and resume next run, so a
 * *transient* quota blip is a non-event (and no longer pages). But two real
 * problems hide behind those green runs:
 *
 *   1. SUSTAINED quota exhaustion / a cron that stopped running — the pipeline
 *      silently falls behind. Caught here as a stale cursor: every cursor-based
 *      cron walks its window to `now()` and stamps `updatedAt` on every run
 *      regardless of whether Congress produced anything, so a cursor that hasn't
 *      moved in hours means the cron itself is stuck — not that the Capitol is
 *      quiet. (This is why we key on cursor `updatedAt`, not on data age, which
 *      would false-positive every weekend.)
 *
 *   2. SILENT zero-progress — a cron running green while writing nothing (the
 *      #139 class: refresh-metadata "succeeded" for weeks, stamped nothing).
 *      Caught here as a backfill whose newest progress timestamp has gone stale
 *      while it still has bills queued.
 *
 * This module is pure so it can be unit-tested without a DB; the route gathers
 * the signals and does the alerting.
 */

/** Hours a cursor's `updatedAt` may lag `now()` before we treat the cron as
 *  stuck. Sized to several missed cycles so a delayed/dropped GitHub Actions
 *  run (or a transient quota stop that resumes next run) never trips it —
 *  only a genuine multi-cycle stall does. */
export const CURSOR_STALE_HOURS: Record<string, number> = {
  // Runs every 3h. 12h ≈ four missed cycles.
  "fetch-bills": 12,
  // fetch-votes runs hourly with one cursor per chamber, so an outage at one
  // chamber's source pages for that chamber alone. 8h ≈ eight missed cycles —
  // comfortably a real stall, not a dropped GitHub run.
  "fetch-votes-house": 8,
  "fetch-votes-senate": 8,
};

/** Hours a rotating backfill's newest progress stamp may lag before we treat
 *  it as silently stalled (running but not advancing). */
export const BACKFILL_STALE_HOURS = 6;

export interface CursorSignal {
  key: string;
  /** `IngestCursor.updatedAt`, or null when the row is absent (never ran). */
  updatedAt: Date | null;
  maxStaleHours: number;
}

export interface BackfillSignal {
  name: string;
  /** How many bills the cron would still process. Zero means caught up — a
   *  stale stamp on an empty queue is not a stall, so we don't alarm on it. */
  backlog: number;
  /** Newest "we touched a bill" timestamp for this pipeline (e.g.
   *  max(lastMetadataRefreshAt)), or null when it has never run. */
  lastProgressAt: Date | null;
  maxStaleHours: number;
}

export interface IngestHealthInput {
  now: Date;
  cursors: CursorSignal[];
  backfills: BackfillSignal[];
}

export interface HealthBreach {
  pipeline: string;
  detail: string;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Returns one breach per stuck pipeline (empty array = healthy). Pure: all
 * inputs are passed in, including `now`, so it's deterministic to test.
 */
export function evaluateIngestHealth(input: IngestHealthInput): HealthBreach[] {
  const breaches: HealthBreach[] = [];
  const hoursSince = (d: Date) =>
    (input.now.getTime() - d.getTime()) / MS_PER_HOUR;

  for (const c of input.cursors) {
    if (!c.updatedAt) {
      breaches.push({
        pipeline: c.key,
        detail: "no IngestCursor row — the cron has never completed a run",
      });
      continue;
    }
    const age = hoursSince(c.updatedAt);
    if (age > c.maxStaleHours) {
      breaches.push({
        pipeline: c.key,
        detail: `cursor hasn't advanced in ${age.toFixed(1)}h (limit ${c.maxStaleHours}h) — cron stalled, sustained-quota-blocked, or failing`,
      });
    }
  }

  for (const b of input.backfills) {
    // An untouched but empty queue is "caught up," not "stalled" — don't alarm.
    if (b.backlog <= 0) continue;
    if (!b.lastProgressAt) {
      breaches.push({
        pipeline: b.name,
        detail: `${b.backlog} bills queued but the pipeline has never recorded progress`,
      });
      continue;
    }
    const age = hoursSince(b.lastProgressAt);
    if (age > b.maxStaleHours) {
      breaches.push({
        pipeline: b.name,
        detail: `${b.backlog} bills queued but nothing processed in ${age.toFixed(1)}h (limit ${b.maxStaleHours}h) — running but not advancing`,
      });
    }
  }

  return breaches;
}
