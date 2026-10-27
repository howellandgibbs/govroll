import "dotenv/config";
import axios from "axios";
import {
  fetchHouseRollCall,
  fetchSenateMemberRoster,
  fetchSenateRollCall,
  fetchSenateVoteMenu,
  type ParsedRollCall,
  type SenateMenuEntry,
  type VoteChamber,
} from "../lib/official-votes";
import {
  fetchVoteviewSenateMenu,
  fetchVoteviewSenateRollCall,
  type VoteviewMenuEntry,
} from "../lib/voteview";
import { isTransientCongressError } from "../lib/congress-api";
import { fetchSpecificBills } from "./fetch-bills";
import { createStandalonePrisma } from "../lib/prisma-standalone";
import dayjs, { type Dayjs } from "dayjs";

const prisma = createStandalonePrisma();

// Resumable-ingest plumbing. Each chamber's cursor records the high-water mark
// of its contiguous day-by-day ingestion so an outage longer than OVERLAP_DAYS
// doesn't silently drop every roll call in the gap (a fixed now-2d lookback
// did exactly that). Mirrors the fetch-bills cursor pattern. The chambers have
// separate sources, so they get separate cursors: with one shared cursor,
// senate.gov refusing us (Oct 2026) stalled the House votes too.
const CURSOR_KEYS: Record<VoteChamber, string> = {
  house: "fetch-votes-house",
  senate: "fetch-votes-senate",
};
// The shared cursor the chambers split from. A chamber with no row of its own
// yet resumes from it, so the first run after the split re-walks the gap.
const LEGACY_CURSOR_KEY = "fetch-votes";
// Re-walk at least this many days on every run so a healthy cursor still
// self-heals a missed cron tick; the overlap is free thanks to skipDuplicates.
// It also covers Voteview's overnight publishing lag.
const OVERLAP_DAYS = 2;
// Pause between roll-call file fetches. The Clerk, senate.gov and Voteview
// are free, keyless public sites — a busy day is a few dozen files, so stay
// polite.
const FETCH_SPACING_MS = 100;

export interface FetchVotesOptions {
  /**
   * Explicit start date (deep backfill). When set, overrides the cursors and
   * walks forward from here. The per-day cursor advance still applies, so a
   * backfill that exceeds the deadline resumes on the next run.
   */
  since?: Date;
  /**
   * Soft wall-clock budget. The day loop stops once exceeded, leaving each
   * cursor at its last fully-ingested day so the next invocation resumes
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

/** One chamber's roll calls for one ET day. */
interface DayVotes {
  rollCalls: ParsedRollCall[];
  /** The deadline cut the day short: keep what was read, redo it next run. */
  partial: boolean;
}

/** Reads one chamber's roll calls day by day, keeping its place across days. */
type DayReader = (
  day: string,
  pastDeadline: () => boolean,
) => Promise<DayVotes>;

/** Where the House walk resumes within one session year. */
interface HouseWalk {
  next: number;
  /** A fetched roll call dated after the day being processed. */
  pending: ParsedRollCall | null;
  /** The Clerk hasn't published roll `next` yet — nothing newer exists. */
  exhausted: boolean;
}

/**
 * House — the Clerk has no date index, only sequential roll numbers. The walk
 * starts just past the newest roll call already stored before the start day
 * and reads forward, holding back a roll call dated after the current day
 * until the loop reaches it. The first roll number not yet published ends the
 * House walk for that year.
 */
function houseReader(): DayReader {
  const walks = new Map<number, HouseWalk>();
  return async (day, pastDeadline) => {
    const year = Number(day.slice(0, 4));
    let walk = walks.get(year);
    if (!walk) {
      walk = {
        next: (await newestStoredHouseRoll(year, day)) + 1,
        pending: null,
        exhausted: false,
      };
      walks.set(year, walk);
    }
    const rollCalls: ParsedRollCall[] = [];
    while (!walk.exhausted) {
      if (pastDeadline()) return { rollCalls, partial: true };
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
    return { rollCalls, partial: false };
  };
}

/**
 * Senate — the session's vote menu lists every vote with its date, so a day's
 * votes are a filter over it (menu fetched once per year).
 *
 * Read from senate.gov while it answers, else from Voteview (voteview.ts).
 * senate.gov's Akamai WAF has refused every server-side client since
 * 2026-10-23, so the first senate.gov request that gets no answer moves the
 * rest of the run to Voteview: a blocked run costs one refused request, not
 * one per vote. An answer that won't parse still fails, so a format change
 * gets noticed rather than papered over.
 */
function senateReader(): DayReader {
  let useVoteview = false;
  const menus = new Map<number, SenateMenuEntry[]>();
  const voteviewMenus = new Map<number, VoteviewMenuEntry[]>();
  let roster: Map<string, string> | null = null;

  const fromSenateGov: DayReader = async (day, pastDeadline) => {
    const year = Number(day.slice(0, 4));
    let menu = menus.get(year);
    if (!menu) {
      menu = await fetchSenateVoteMenu(year);
      menus.set(year, menu);
    }
    const rollCalls: ParsedRollCall[] = [];
    for (const entry of menu
      .filter((e) => e.date === day)
      .sort((a, b) => a.voteNumber - b.voteNumber)) {
      if (pastDeadline()) return { rollCalls, partial: true };
      roster ??= await fetchSenateMemberRoster();
      const rc = await fetchSenateRollCall(year, entry.voteNumber);
      // senate.gov keys senators by LIS id; resolve bioguide ids through the
      // Senate's roster of sitting senators (Voteview supplies them directly).
      const lisToBioguide = roster;
      rollCalls.push({
        ...rc,
        voters: rc.voters.map((v) => ({
          ...v,
          bioguideId:
            v.bioguideId ??
            (v.lisId ? lisToBioguide.get(v.lisId) : null) ??
            null,
        })),
      });
      await delay(FETCH_SPACING_MS);
    }
    return { rollCalls, partial: false };
  };

  const fromVoteview: DayReader = async (day, pastDeadline) => {
    const year = Number(day.slice(0, 4));
    let menu = voteviewMenus.get(year);
    if (!menu) {
      menu = await fetchVoteviewSenateMenu(year);
      voteviewMenus.set(year, menu);
    }
    const rollCalls: ParsedRollCall[] = [];
    // The index already names each vote's bill, and only bill-linked roll
    // calls are stored, so nominations and the like aren't fetched at all.
    for (const entry of menu
      .filter((e) => e.date === day && e.billId !== null)
      .sort((a, b) => a.voteNumber - b.voteNumber)) {
      if (pastDeadline()) return { rollCalls, partial: true };
      rollCalls.push(await fetchVoteviewSenateRollCall(entry));
      await delay(FETCH_SPACING_MS);
    }
    return { rollCalls, partial: false };
  };

  return async (day, pastDeadline) => {
    if (!useVoteview) {
      try {
        return await fromSenateGov(day, pastDeadline);
      } catch (error) {
        if (!axios.isAxiosError(error)) throw error;
        useVoteview = true;
        console.warn(
          `[fetch-votes] senate.gov unavailable (${error.message}); reading the Senate from Voteview for the rest of this run`,
        );
      }
    }
    return fromVoteview(day, pastDeadline);
  };
}

interface ChamberWalk {
  chamber: VoteChamber;
  read: DayReader;
  /** First ET day this chamber walks. */
  from: string;
  failed: boolean;
}

/**
 * Walk forward day by day (ET) to today, reading each chamber's roll calls
 * for the day and writing them before advancing that chamber's cursor past
 * it. The chambers share the day loop and the deadline but nothing else: one
 * whose source fails stops there for this run, its cursor left for the next
 * run (and the watchdog), while the other carries on.
 */
export async function fetchVotesFunction(opts: FetchVotesOptions = {}) {
  const started = Date.now();
  const deadlineMs = opts.deadlineMs ?? Number.POSITIVE_INFINITY;
  const pastDeadline = () => Date.now() - started > deadlineMs;

  try {
    const now = dayjs();
    const today = etDate(now.toDate());
    const readers: [VoteChamber, DayReader][] = [
      ["house", houseReader()],
      ["senate", senateReader()],
    ];
    const walks: ChamberWalk[] = [];
    for (const [chamber, read] of readers) {
      walks.push({
        chamber,
        read,
        // `since` is a calendar date (UTC midnight); the cursor is an instant.
        from: opts.since
          ? opts.since.toISOString().slice(0, 10)
          : etDate((await resolveStartDate(chamber, now)).toDate()),
        failed: false,
      });
    }

    const errors: unknown[] = [];
    let day = walks.reduce((min, w) => (w.from < min ? w.from : min), today);
    walk: while (day <= today && walks.some((w) => !w.failed)) {
      // Stop between days (never mid-write) once the budget is spent. The
      // cursors are already at the last completed day, so the next run resumes.
      if (pastDeadline()) {
        console.log(
          `[fetch-votes] deadline reached at ${day}; resuming next run`,
        );
        break;
      }

      for (const w of walks) {
        if (w.failed || day < w.from) continue;
        try {
          const { rollCalls, partial } = await w.read(day, pastDeadline);
          // Write whatever was gathered — rows are idempotent, so a partial
          // day is safe to keep — but only advance the cursor past a complete
          // day.
          await persistRollCalls(rollCalls);
          console.log(
            `[fetch-votes] ${day} ${w.chamber}: ${rollCalls.length} roll calls` +
              (partial
                ? " (partial — deadline reached, redoing next run)"
                : ""),
          );
          if (partial) break walk;

          // Advance the cursor only after the day's writes succeed. If a later
          // day throws, the cursor stays at the last fully-ingested day rather
          // than jumping to now and stranding the gap. Noon UTC is the same
          // calendar date in ET, so etDate() reads it back as the next day to
          // walk. Today's run stores `now`, so the next run re-walks today for
          // roll calls cast later this evening.
          const advanced =
            day === today
              ? now.toDate()
              : new Date(`${nextDay(day)}T12:00:00Z`);
          await prisma.ingestCursor.upsert({
            where: { key: CURSOR_KEYS[w.chamber] },
            update: { cursor: advanced },
            create: { key: CURSOR_KEYS[w.chamber], cursor: advanced },
          });
        } catch (error) {
          w.failed = true;
          errors.push(error);
          console.error(
            `[fetch-votes] ${w.chamber} stopped at ${day}; resuming there next run:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      day = nextDay(day);
    }

    // Errors propagate so the caller (cron route) surfaces a 500 instead of a
    // false success. A hard failure outranks a transient one, so a chamber
    // that is genuinely broken still pages while the other merely backs off.
    if (errors.length > 0) {
      throw errors.find((e) => !isTransientCongressError(e)) ?? errors[0];
    }
    console.log("Votes fetched and stored successfully.");
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Where a chamber's day-by-day walk starts when no explicit `since` (manual/
 * admin deep backfill) was given.
 *
 *   - Walk from min(saved cursor, now - OVERLAP_DAYS): a healthy cursor still
 *     re-walks the overlap window (self-heal), while a cursor stalled by an
 *     outage is honored so the whole gap is recovered.
 *   - No cursor yet: the pre-split shared cursor if there is one, else just
 *     the overlap window (first run).
 */
async function resolveStartDate(
  chamber: VoteChamber,
  now: Dayjs,
): Promise<Dayjs> {
  const overlapStart = now.subtract(OVERLAP_DAYS, "day");
  const rows = await prisma.ingestCursor.findMany({
    where: { key: { in: [CURSOR_KEYS[chamber], LEGACY_CURSOR_KEY] } },
  });
  const cursorRow =
    rows.find((r) => r.key === CURSOR_KEYS[chamber]) ??
    rows.find((r) => r.key === LEGACY_CURSOR_KEY);
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
async function persistRollCalls(rollCalls: ParsedRollCall[]) {
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
  // Voters carry bioguide ids where the source could give one (for senate.gov,
  // via the Senate's roster of sitting senators). A senator who has since
  // left office falls back to last name + state among our senators.
  const reps = await prisma.representative.findMany({
    where: {
      OR: [
        { chamber: "senator" },
        { bioguideId: { in: voterBioguides(linked) } },
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
      const representativeId =
        (v.bioguideId ? repIdByBioguide.get(v.bioguideId) : undefined) ??
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

function voterBioguides(rollCalls: ParsedRollCall[]): string[] {
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
