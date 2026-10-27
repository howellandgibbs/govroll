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
 *   3. A vote source that answers but has STOPPED PUBLISHING — fetch-votes
 *      walks each day, finds no roll calls, and advances its cursor exactly as
 *      it does through a recess, so neither check above can see it. The Senate
 *      is where this bites: while senate.gov refuses server-side clients, its
 *      votes come from Voteview, a mirror that publishes overnight. Caught here
 *      against an independent record of the votes — Congress.gov's own Senate
 *      actions, which name each roll call ("Record Vote Number: 253") — as a
 *      roll call Congress.gov recorded that RepresentativeVote still lacks a
 *      day and a half later. Only votes that actually happened are checked, so
 *      a weekend or a recess (no votes) can't trip it.
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

/** Hours past the end of a Senate roll call's day that RepresentativeVote may
 *  still lack it. Voteview publishes overnight (Sep 30's votes were in its
 *  files by 07:00 UTC Oct 1) and fetch-votes runs hourly, so a healthy
 *  pipeline has the vote by the next morning; 36h rides out a whole missed
 *  night on top. Counted from the day's end because Congress.gov dates an
 *  action but doesn't time it. */
export const SENATE_VOTE_GRACE_HOURS = 36;

/** How far back roll calls are checked. A vote missing for longer is a
 *  backfill job (fetch-votes ?since=), not a live stall — and without the
 *  bound, one old gap would page through every recess after it. */
export const SENATE_VOTE_LOOKBACK_DAYS = 7;

/** Days either side of Congress.gov's action date that a stored roll call
 *  may fall and still match. Vote numbers restart every session, so a
 *  same-numbered vote from another year must not count. */
export const SENATE_VOTE_MATCH_DAYS = 3;

/** An action Congress.gov published on one of our bills: its latest action
 *  (kept current by fetch-bills) or a row of its action history
 *  (backfill-bill-actions). Only Senate roll calls are read from it. */
export interface CongressActionSignal {
  billId: string;
  /** Congress.gov's actionDate — a calendar day, stored at UTC midnight. */
  actionDate: Date;
  text: string;
}

/** A Senate roll call RepresentativeVote holds. */
export interface StoredRollCallSignal {
  rollCallNumber: number;
  votedAt: Date;
}

export interface SenateVoteInput {
  now: Date;
  actions: CongressActionSignal[];
  stored: StoredRollCallSignal[];
}

const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Missing roll calls named in the breach before the rest become "+N more". */
const MAX_LISTED = 5;

/**
 * The Senate roll call an action records, or null. Congress.gov writes every
 * one the same way — "…by Yea-Nay Vote. 53 - 46. Record Vote Number: 253." —
 * the shape of every such action we've stored since 2023. The House writes
 * "(Roll no. 456)" instead. The older "Record Vote No. 38" now only turns up
 * in motions to reconsider, citing a vote taken anywhere up to weeks before
 * the motion's date, so it isn't read.
 */
export function senateRollCallNumber(text: string): number | null {
  const m = text.match(
    /Yea-Nay Vote\.\s*\d+\s*-\s*\d+\.\s*Record Vote Number:\s*(\d+)/,
  );
  return m ? Number(m[1]) : null;
}

/**
 * One breach when Congress.gov has recorded a Senate roll call on one of our
 * bills that RepresentativeVote still lacks SENATE_VOTE_GRACE_HOURS after the
 * vote's day ended (empty array = healthy). Pure, like evaluateIngestHealth.
 *
 * Only some roll calls are visible this way — those still a bill's latest
 * action, or in an action history backfill-bill-actions has re-fetched — but
 * a stalled source misses every vote, so a stall across a voting week shows.
 */
export function evaluateSenateVotes(input: SenateVoteInput): HealthBreach[] {
  const now = input.now.getTime();
  const oldest = now - SENATE_VOTE_LOOKBACK_DAYS * MS_PER_DAY;
  // Keyed by vote: a bill's latest action and its history can name the same one.
  const missing = new Map<
    string,
    { rollCallNumber: number; day: Date; billId: string }
  >();

  for (const a of input.actions) {
    const rollCallNumber = senateRollCallNumber(a.text);
    if (rollCallNumber === null) continue;
    const day = a.actionDate.getTime();
    if (day < oldest) continue;
    const dueAt = day + MS_PER_DAY + SENATE_VOTE_GRACE_HOURS * MS_PER_HOUR;
    if (now <= dueAt) continue;
    const stored = input.stored.some(
      (s) =>
        s.rollCallNumber === rollCallNumber &&
        Math.abs(s.votedAt.getTime() - day) <=
          SENATE_VOTE_MATCH_DAYS * MS_PER_DAY,
    );
    if (!stored) {
      missing.set(`${rollCallNumber}@${day}`, {
        rollCallNumber,
        day: a.actionDate,
        billId: a.billId,
      });
    }
  }

  if (missing.size === 0) return [];
  const list = [...missing.values()].sort(
    (x, y) =>
      x.day.getTime() - y.day.getTime() || x.rollCallNumber - y.rollCallNumber,
  );
  const named = list
    .slice(0, MAX_LISTED)
    .map(
      (m) =>
        `#${m.rollCallNumber} on ${m.day.toISOString().slice(0, 10)} (${m.billId})`,
    );
  if (list.length > MAX_LISTED) named.push(`+${list.length - MAX_LISTED} more`);
  return [
    {
      pipeline: "fetch-votes-senate",
      detail: `${list.length} Senate roll call${list.length === 1 ? "" : "s"} Congress.gov recorded still not stored ${SENATE_VOTE_GRACE_HOURS}h after the day ${list.length === 1 ? "it was" : "they were"} cast: ${named.join(", ")} — the Senate vote source stopped publishing, or fetch-votes can't read it`,
    },
  ];
}
