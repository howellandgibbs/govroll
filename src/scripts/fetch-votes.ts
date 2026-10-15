import "dotenv/config";
import {
  fetchHouseRollCall,
  fetchSenateMemberRoster,
  fetchSenateRollCall,
  fetchSenateVoteMenu,
  type ParsedRollCall,
  type SenateMenuEntry,
} from "../lib/official-votes";
import { fetchSpecificBills } from "./fetch-bills";
import { createStandalonePrisma } from "../lib/prisma-standalone";
import dayjs, { type Dayjs } from "dayjs";

const prisma = createStandalonePrisma();

// Resumable-ingest plumbing. The cursor records the high-water mark of
// contiguous day-by-day ingestion so an outage longer than OVERLAP_DAYS
// doesn't silently drop every roll call in the gap (a fixed now-2d lookback
// did exactly that). Mirrors the fetch-bills cursor pattern.
const CURSOR_KEY = "fetch-votes";
// Re-walk at least this many days on every run so a healthy cursor still
// self-heals a missed cron tick; the overlap is free thanks to skipDuplicates.
const OVERLAP_DAYS = 2;
// Pause between roll-call file fetches. The Clerk and senate.gov are free,
// keyless public sites — a busy day is a few dozen files, so stay polite.
const FETCH_SPACING_MS = 100;

export interface FetchVotesOptions {
  /**
   * Explicit start date (deep backfill). When set, overrides the cursor and
   * walks forward from here. The per-day cursor advance still applies, so a
   * backfill that exceeds the deadline resumes on the next run.
   */
  since?: Date;
  /**
   * Soft wall-clock budget. The day loop stops once exceeded, leaving the
   * cursor at the last fully-ingested day so the next invocation resumes
   * there instead of being hard-killed mid-write.
   */
  deadlineMs?: number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "YYYY-MM-DD" of `d` in US Eastern time — the chambers' calendar. */
function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Calendar date of a votedAt (ET wall clock stored in UTC fields). */
function votedAtDate(votedAt: Date): string {
  return votedAt.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" + 1 day, in pure UTC arithmetic (no host-timezone drift). */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Where the House walk resumes within one session year. */
interface HouseWalk {
  next: number;
  /** A fetched roll call dated after the day being processed. */
  pending: ParsedRollCall | null;
  /** The Clerk hasn't published roll `next` yet — nothing newer exists. */
  exhausted: boolean;
}

/**
 * Walk forward day by day (ET) from the resume point to today, gathering each
 * day's roll calls from both chambers and writing them before advancing the
 * cursor past that day.
 *
 *   Senate — the session's vote menu lists every vote with its date, so a
 *            day's votes are a filter over it (menu fetched once per year).
 *   House  — the Clerk has no date index, only sequential roll numbers. The
 *            walk starts just past the newest roll call already stored before
 *            the start day and reads forward, holding back a roll call dated
 *            after the current day until the loop reaches it. The first roll
 *            number not yet published ends the House walk for that year.
 */
export async function fetchVotesFunction(opts: FetchVotesOptions = {}) {
  const started = Date.now();
  const deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const pastDeadline = () => Date.now() - started > deadlineMs;

  try {
    const now = dayjs();
    const today = etDate(now.toDate());
    // `since` is a calendar date (UTC midnight); the cursor is an instant.
    let day = opts.since
      ? opts.since.toISOString().slice(0, 10)
      : etDate((await resolveStartDate(now)).toDate());

    const senateMenus = new Map<number, SenateMenuEntry[]>();
    const houseWalks = new Map<number, HouseWalk>();
    let senateRoster: Map<string, string> | null = null;

    while (day <= today) {
      // Stop between days (never mid-write) once the budget is spent. The
      // cursor is already at the last completed day, so the next run resumes.
      if (pastDeadline()) {
        console.log(
          `[fetch-votes] deadline reached at ${day}; resuming next run`,
        );
        break;
      }

      const year = Number(day.slice(0, 4));
      const rollCalls: ParsedRollCall[] = [];
      let abandonedDay = false;

      // ── Senate ──
      let menu = senateMenus.get(year);
      if (!menu) {
        menu = await fetchSenateVoteMenu(year);
        senateMenus.set(year, menu);
      }
      const senateToday = menu
        .filter((e) => e.date === day)
        .sort((a, b) => a.voteNumber - b.voteNumber);
      for (const entry of senateToday) {
        if (pastDeadline()) {
          abandonedDay = true;
          break;
        }
        senateRoster ??= await fetchSenateMemberRoster();
        rollCalls.push(await fetchSenateRollCall(year, entry.voteNumber));
        await delay(FETCH_SPACING_MS);
      }

      // ── House ──
      let walk = houseWalks.get(year);
      if (!walk) {
        walk = {
          next: (await newestStoredHouseRoll(year, day)) + 1,
          pending: null,
          exhausted: false,
        };
        houseWalks.set(year, walk);
      }
      while (!abandonedDay && !walk.exhausted) {
        if (pastDeadline()) {
          abandonedDay = true;
          break;
        }
        let rc = walk.pending;
        if (!rc) {
          rc = await fetchHouseRollCall(year, walk.next);
          await delay(FETCH_SPACING_MS);
        }
        if (!rc) {
          walk.exhausted = true;
          break;
        }
        if (votedAtDate(rc.votedAt) > day) {
          walk.pending = rc;
          break;
        }
        walk.pending = null;
        walk.next = rc.rollCallNumber + 1;
        rollCalls.push(rc);
      }

      // Write whatever was gathered — rows are idempotent, so a partial day
      // is safe to keep — but only advance the cursor past a complete day.
      await persistRollCalls(rollCalls, senateRoster);
      console.log(
        `[fetch-votes] ${day}: ${rollCalls.length} roll calls` +
          (abandonedDay
            ? " (partial — deadline reached, redoing next run)"
            : ""),
      );
      if (abandonedDay) break;

      // Advance the cursor only after the day's writes succeed. If a later
      // day throws, the cursor stays at the last fully-ingested day rather
      // than jumping to now and stranding the gap. Errors propagate so the
      // caller (cron route) surfaces a 500 instead of a false success.
      // Noon UTC is the same calendar date in ET, so etDate() reads it back as
      // the next day to walk. Today's run stores `now`, so the next run
      // re-walks today for roll calls cast later this evening.
      const advanced =
        day === today ? now.toDate() : new Date(`${nextDay(day)}T12:00:00Z`);
      await prisma.ingestCursor.upsert({
        where: { key: CURSOR_KEY },
        update: { cursor: advanced },
        create: { key: CURSOR_KEY, cursor: advanced },
      });

      day = nextDay(day);
    }

    console.log("Votes fetched and stored successfully.");
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Where to start the day-by-day walk when no explicit `since` (manual/admin
 * deep backfill) was given.
 *
 *   - Walk from min(saved cursor, now - OVERLAP_DAYS): a healthy cursor still
 *     re-walks the overlap window (self-heal), while a cursor stalled by an
 *     outage is honored so the whole gap is recovered.
 *   - No cursor yet (first run): just the overlap window.
 */
async function resolveStartDate(now: Dayjs): Promise<Dayjs> {
  const overlapStart = now.subtract(OVERLAP_DAYS, "day");
  const cursorRow = await prisma.ingestCursor.findUnique({
    where: { key: CURSOR_KEY },
  });
  if (cursorRow && dayjs(cursorRow.cursor).isBefore(overlapStart)) {
    return dayjs(cursorRow.cursor);
  }
  return overlapStart;
}

/**
 * Highest House roll number stored for `year`'s session that was cast before
 * `day` (0 if none). Roll numbers restart every session, so the lookup is
 * fenced to the calendar year. Only bill-linked roll calls are stored, so a
 * few non-bill roll calls after it get re-read — cheap and idempotent.
 */
async function newestStoredHouseRoll(
  year: number,
  day: string,
): Promise<number> {
  const row = await prisma.representativeVote.aggregate({
    _max: { rollCallNumber: true },
    where: {
      chamber: "house",
      votedAt: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lt: new Date(`${day}T00:00:00Z`),
      },
    },
  });
  return row._max.rollCallNumber ?? 0;
}

/**
 * Write a batch of roll calls with bulk operations: one findMany for
 * representatives, one findMany for bills (plus a create pass for any bill we
 * haven't ingested yet), one createMany for votes.
 *
 * Deliberate semantics, unchanged from the GovTrack era:
 *
 * 1. Only roll calls tied to a bill are stored (nominations, quorum calls,
 *    adjournment motions have no bill to attach to).
 *
 * 2. Bill rows are owned by fetch-bills / refresh-bill-metadata. A bill we
 *    don't have yet is created through fetch-bills' own single-bill path, so
 *    it gets the same shape as every other row; existing bills are never
 *    touched here.
 *
 * 3. RepresentativeVote rows use createMany({ skipDuplicates }). A
 *    (representativeId, billId, rollCallNumber) tuple is immutable once the
 *    roll call is recorded, so re-runs are idempotent without an UPSERT.
 */
async function persistRollCalls(
  rollCalls: ParsedRollCall[],
  senateRoster: Map<string, string> | null,
) {
  const linked = rollCalls.filter(
    (rc): rc is ParsedRollCall & { billId: string } => rc.billId !== null,
  );
  if (linked.length === 0) return;

  // ── Bills ──
  const billIds = [...new Set(linked.map((rc) => rc.billId))];
  const findBills = () =>
    prisma.bill.findMany({
      where: { billId: { in: billIds } },
      select: { id: true, billId: true },
    });
  let bills = await findBills();
  const missing = billIds.filter((id) => !bills.some((b) => b.billId === id));
  if (missing.length > 0) {
    await fetchSpecificBills(missing);
    bills = await findBills();
    const stillMissing = billIds.filter(
      (id) => !bills.some((b) => b.billId === id),
    );
    if (stillMissing.length > 0) {
      // The next run's overlap re-walk retries these roll calls.
      console.warn(
        `[fetch-votes] skipping votes on bills not yet ingestible: ${stillMissing.join(", ")}`,
      );
    }
  }
  const billRowId = new Map(bills.map((b) => [b.billId, b.id]));

  // ── Representatives ──
  // House voters carry bioguide ids. Senate voters carry LIS ids, resolved
  // through the Senate's roster of sitting senators; a senator who has since
  // left office falls back to last name + state among our senators.
  const reps = await prisma.representative.findMany({
    where: {
      OR: [
        { chamber: "senator" },
        { bioguideId: { in: houseBioguides(linked) } },
      ],
    },
    select: {
      id: true,
      bioguideId: true,
      lastName: true,
      state: true,
      chamber: true,
    },
  });
  const repIdByBioguide = new Map(reps.map((r) => [r.bioguideId, r.id]));
  const senatorIdByNameState = new Map(
    reps
      .filter((r) => r.chamber === "senator")
      .map((r) => [`${r.lastName.toLowerCase()}|${r.state}`, r.id]),
  );

  const votePayloads: {
    representativeId: number;
    billId: number;
    vote: string;
    rollCallNumber: number;
    chamber: string;
    votedAt: Date;
    category: string;
  }[] = [];
  for (const rc of linked) {
    const billId = billRowId.get(rc.billId);
    if (!billId) continue;
    for (const v of rc.voters) {
      if (!v.vote) continue;
      const bioguide =
        v.bioguideId ?? (v.lisId ? senateRoster?.get(v.lisId) : undefined);
      const representativeId =
        (bioguide ? repIdByBioguide.get(bioguide) : undefined) ??
        (rc.chamber === "senate"
          ? senatorIdByNameState.get(`${v.lastName.toLowerCase()}|${v.state}`)
          : undefined);
      // Members we don't track (e.g. delegates absent from our roster) are
      // skipped, as before.
      if (!representativeId) continue;
      votePayloads.push({
        representativeId,
        billId,
        vote: v.vote,
        rollCallNumber: rc.rollCallNumber,
        // Lowercase at write time so the every-10-min vote-recency query
        // (vote-recency.ts) can use an exact-match index, not ILIKE.
        chamber: rc.chamber,
        votedAt: rc.votedAt,
        category: rc.category,
      });
    }
  }
  if (votePayloads.length === 0) return;

  await prisma.representativeVote.createMany({
    data: votePayloads,
    skipDuplicates: true,
  });
}

function houseBioguides(rollCalls: ParsedRollCall[]): string[] {
  const ids = new Set<string>();
  for (const rc of rollCalls) {
    for (const v of rc.voters) if (v.bioguideId) ids.add(v.bioguideId);
  }
  return [...ids];
}

if (require.main === module) {
  // Optional CLI arg: a YYYY-MM-DD start date for a manual deep backfill.
  const sinceArg = process.argv[2];
  const since = sinceArg ? new Date(`${sinceArg}T00:00:00Z`) : undefined;
  fetchVotesFunction({ since }).catch((err) => {
    console.error("fetch-votes failed:", err);
    process.exitCode = 1;
  });
}
