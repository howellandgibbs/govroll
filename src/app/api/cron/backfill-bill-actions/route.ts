import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { fetchBillActions, isQuotaError } from "@/lib/congress-api";
import { parseBillId } from "@/lib/parse-bill-id";
import { reconcileStatus } from "@/lib/reconcile-bill-status";
import { reportError } from "@/lib/error-reporting";

/**
 * GET /api/cron/backfill-bill-actions
 *
 * Rolling refresh of BillAction + reconciliation of Bill.currentStatus.
 *
 * Action history drives the bill-journey timeline on /bills/[id] AND
 * feeds the status reconciliation that fixes GovTrack staleness (the
 * Farm Bill May 2026 class: GovTrack stuck at `reported` while
 * congress.gov shows the House passed the bill).
 *
 * Prior behavior (pre-rewrite): WHERE was `actions: { none: {} }`,
 * which permanently excluded any bill that had ever had any action
 * stored. That made the route a one-shot initial backfill — once a
 * bill had any action, this cron never touched it again, and
 * currentStatus drifted forever. 24 production bills ended up with
 * passage roll calls in our DB but `currentStatus = "reported"`.
 *
 * Current behavior: pick bills that have never been refreshed, OR
 * were refreshed before the cooldown cutoff, OR have status that's
 * older than their underlying action data. Refresh actions, call
 * `reconcileStatus`, write currentStatus/currentStatusDate +
 * latestActionText/Date when the data says so, and ALWAYS stamp
 * lastActionRefreshAt so each pass advances the queue.
 *
 * Protected by CRON_SECRET. Bills with NULL lastActionRefreshAt come
 * first (never refreshed), then oldest refresh, then random tiebreak.
 * Each call is idempotent — fetchBillActions upserts on
 * (billId, actionDate, text).
 */

export const maxDuration = 60;
const TIMEOUT_MS = 55_000;
// How long a bill can go without an action refresh before it re-enters
// the pool. 6h is short enough that a chamber vote shows up the same
// day, long enough that the ~5k live bills don't hammer congress.gov.
const REFRESH_COOLDOWN_HOURS = 6;
// Latest-action evidence (see the evidence pass below) gets at most this
// many slots per run, so a large backlog drains steadily without starving
// the routine refresh of live bills.
const EVIDENCE_LIMIT = 10;
// congress.gov latest-action text that only a later status can explain.
// Terminal: any status short of enacted is behind (veto rows included —
// reconcileStatus decides what the action log supports).
const TERMINAL_EVIDENCE =
  "became (public|private) law|signed by (the )?president|presented to (the )?president|vetoed by (the )?president|pocket vetoed";
// Passage: only contradicts a bill still stored as introduced/reported.
const PASSAGE_EVIDENCE =
  "passed/agreed to in (house|senate)|^passed (the )?(house|senate)|received in the (house|senate)|resolution agreed to in (house|senate)|considered,? and agreed to|message on (house|senate) action sent";
// The other chamber acting on a bill also means its own chamber passed
// it: a House bill reaches the Senate calendar or a Senate committee
// ("Read twice and referred to the Committee on Finance.") only after
// House passage, and a Senate bill reaches a House committee only after
// Senate passage. "Read twice" is the Senate's own introduction wording
// for its bills, so it counts only against House bills.
const SENATE_ACTING = "\\msenate\\M|^read twice";
const HOUSE_ACTING = "\\mhouse\\M";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const auth = request.headers.get("authorization");
  if (!timingSafeEqualStr(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  // Actions are ~1s each (one API call). Batch of 20 fits in ~30s with
  // overhead. Reconcile + Bill.update adds ~50ms per bill, negligible.
  const limit = Math.min(
    30,
    parseInt(url.searchParams.get("limit") ?? "20", 10),
  );
  const tiers = (url.searchParams.get("tiers") ?? "ACTIVE,ADVANCING,STALLED")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const started = Date.now();
  const deadline = started + TIMEOUT_MS;
  const cooldownCutoff = new Date(
    Date.now() - REFRESH_COOLDOWN_HOURS * 60 * 60 * 1000,
  );

  type BatchRow = {
    id: number;
    billId: string;
    billType: string;
    currentStatus: string;
    currentStatusDate: Date;
    latestActionText: string | null;
    latestActionDate: Date | null;
  };

  // Priority pass: bills where we have direct evidence the chamber
  // acted but currentStatus hasn't caught up — a passage-category
  // RepresentativeVote dates AFTER the bill's currentStatusDate.
  // These are the visibly-broken bills (the Farm Bill class). They
  // can be in any tier — `compute-momentum` mis-tiers DEAD/DORMANT
  // bills specifically because their status didn't advance, so the
  // tier filter we use below would hide them from the normal pool.
  // Cap the priority pull so it can't fully starve the routine
  // refresh — we still want fresh bills cycling through.
  const priorityLimit = Math.min(limit, 10);
  const priorityRows = await prisma.$queryRaw<BatchRow[]>`
    SELECT b.id, b."billId", b."billType", b."currentStatus",
           b."currentStatusDate", b."latestActionText", b."latestActionDate"
    FROM "Bill" b
    WHERE b."currentStatus" IN (
      'introduced', 'reported', 'pass_over_house', 'pass_over_senate',
      'passed_house', 'passed_senate'
    )
      AND (
        b."lastActionRefreshAt" IS NULL
        OR b."lastActionRefreshAt" < ${cooldownCutoff}
      )
      AND EXISTS (
        SELECT 1 FROM "RepresentativeVote" rv
        WHERE rv."billId" = b.id
          AND rv.category IN ('passage', 'passage_suspension', 'veto_override')
          AND rv."votedAt" > b."currentStatusDate" + INTERVAL '1 day'
      )
    ORDER BY b."lastActionRefreshAt" ASC NULLS FIRST, b."currentStatusDate" ASC
    LIMIT ${priorityLimit};
  `;

  // Evidence pass: congress.gov's own latest action — kept fresh on every
  // bill by refresh-bill-metadata — names a milestone the stored status
  // hasn't reached. Bills imported after they'd already gone quiet were
  // computed DORMANT/DEAD on arrival and so never entered the routine
  // pool below: ~1,100 signed laws (the Laken Riley Act and the GENIUS
  // Act among them, ~930 from before 2013) sat at "introduced", tiered
  // DEAD. Any tier qualifies. Only bills whose actions haven't been
  // fetched since that latest action do, so a bill whose action log
  // can't explain the text is fetched once, not every run.
  const voteIds = priorityRows.map((r) => r.id);
  const evidenceLimit = Math.min(
    EVIDENCE_LIMIT,
    Math.max(0, limit - priorityRows.length),
  );
  const evidenceRows = evidenceLimit
    ? await prisma.$queryRaw<BatchRow[]>`
        SELECT b.id, b."billId", b."billType", b."currentStatus",
               b."currentStatusDate", b."latestActionText", b."latestActionDate"
        FROM "Bill" b
        WHERE b."currentStatus" NOT LIKE 'enacted%'
          AND b."latestActionDate" IS NOT NULL
          AND (
            b."lastActionRefreshAt" IS NULL
            OR b."lastActionRefreshAt" < b."latestActionDate"
          )
          AND (
            b."latestActionText" ~* ${TERMINAL_EVIDENCE}
            OR (
              b."currentStatus" IN ('introduced', 'reported')
              AND (
                b."latestActionText" ~* ${PASSAGE_EVIDENCE}
                OR (
                  b."billType" LIKE 'house%'
                  AND b."latestActionText" ~* ${SENATE_ACTING}
                )
                OR (
                  b."billType" LIKE 'senate%'
                  AND b."latestActionText" ~* ${HOUSE_ACTING}
                )
              )
            )
          )
          ${voteIds.length ? Prisma.sql`AND b.id NOT IN (${Prisma.join(voteIds)})` : Prisma.empty}
        ORDER BY b."congressNumber" DESC NULLS LAST, b."latestActionDate" DESC
        LIMIT ${evidenceLimit};
      `
    : [];

  const priorityIds = [...voteIds, ...evidenceRows.map((r) => r.id)];
  const remainingSlots = Math.max(0, limit - priorityIds.length);

  // Routine pass: bills due for refresh, ordered by NULLS-FIRST and
  // newest-status first. Excludes anything already in the priority
  // batch to avoid double-processing.
  const routineRows: BatchRow[] = remainingSlots
    ? await prisma.bill.findMany({
        where: {
          momentumTier: { in: tiers },
          currentStatus: { not: { startsWith: "enacted_" } },
          ...(priorityIds.length ? { id: { notIn: priorityIds } } : {}),
          OR: [
            { lastActionRefreshAt: null },
            { lastActionRefreshAt: { lt: cooldownCutoff } },
          ],
        },
        orderBy: [
          { lastActionRefreshAt: { sort: "asc", nulls: "first" } },
          { currentStatusDate: "desc" },
        ],
        select: {
          id: true,
          billId: true,
          billType: true,
          currentStatus: true,
          currentStatusDate: true,
          latestActionText: true,
          latestActionDate: true,
        },
        take: remainingSlots,
      })
    : [];

  const batch: BatchRow[] = [...priorityRows, ...evidenceRows, ...routineRows];

  let processed = 0;
  let statusesReconciled = 0;
  let latestActionUpdated = 0;
  let timedOut = false;
  let quotaExhausted = false;
  const errors: Array<{ billId: string; error: string }> = [];

  for (const b of batch) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    try {
      const parsed = parseBillId(b.billId);
      if (!parsed.congress || !parsed.apiBillType || !parsed.billNumber) {
        errors.push({ billId: b.billId, error: "invalid bill id" });
        // Stamp anyway so we don't loop on this unparseable id.
        await prisma.bill.update({
          where: { id: b.id },
          data: { lastActionRefreshAt: new Date() },
        });
        continue;
      }
      const actions = await fetchBillActions(
        parsed.congress,
        parsed.apiBillType,
        parsed.billNumber,
      );

      // Stamp refresh-attempted clock no matter what — we're trying to
      // *drain the queue*, not just record successes. A bill that has
      // no congress.gov actions yet shouldn't monopolize the next ten
      // runs as a NULL-first head-of-queue.
      const refreshStamp = { lastActionRefreshAt: new Date() };

      if (!actions || actions.length === 0) {
        await prisma.bill.update({
          where: { id: b.id },
          data: refreshStamp,
        });
        processed++;
        continue;
      }

      // Dedupe on (actionDate, text) — congress.gov occasionally
      // returns identical action rows, which would race the
      // (billId, actionDate, text) unique constraint when upserted
      // in parallel.
      const seen = new Set<string>();
      const uniqueActions = actions.filter((a) => {
        if (!a.actionDate || !a.text) return false;
        const key = `${a.actionDate}::${a.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await Promise.all(
        uniqueActions.map((a) =>
          prisma.billAction.upsert({
            where: {
              billId_actionDate_text: {
                billId: b.id,
                actionDate: new Date(a.actionDate),
                text: a.text,
              },
            },
            update: {},
            create: {
              billId: b.id,
              actionDate: new Date(a.actionDate),
              chamber: a.chamber,
              text: a.text,
              actionType: a.type,
            },
          }),
        ),
      );

      // Reconcile currentStatus + latest action against what
      // congress.gov now shows. The reconcile function returns null
      // when GovTrack's status looks fine; otherwise it returns the
      // corrected status string.
      const correctedStatus = reconcileStatus(
        b.currentStatus,
        b.billType,
        actions,
      );

      // Latest action is the newest by actionDate. Even when status
      // doesn't change, latestActionText/Date can advance (e.g. a
      // motion vote on a still-pending bill).
      const latest = uniqueActions.reduce<
        (typeof uniqueActions)[number] | null
      >(
        (acc, a) =>
          !acc || new Date(a.actionDate) > new Date(acc.actionDate) ? a : acc,
        null,
      );

      const billUpdate: {
        lastActionRefreshAt: Date;
        currentStatus?: string;
        currentStatusDate?: Date;
        latestActionText?: string;
        latestActionDate?: Date;
      } = { ...refreshStamp };

      if (correctedStatus && correctedStatus !== b.currentStatus) {
        billUpdate.currentStatus = correctedStatus;
        // Use the latest action date as the status date — the action
        // that drove the status change is the most relevant timestamp.
        if (latest) {
          billUpdate.currentStatusDate = new Date(latest.actionDate);
        }
        statusesReconciled++;
      }

      if (latest) {
        const latestDate = new Date(latest.actionDate);
        // Only write when newer than what's on the row — avoid
        // pointless writes (and avoid clobbering manual fixes if the
        // ingest somehow returns a slightly older latest).
        if (
          !b.latestActionDate ||
          latestDate > b.latestActionDate ||
          (b.latestActionText !== latest.text &&
            latestDate.getTime() === b.latestActionDate.getTime())
        ) {
          billUpdate.latestActionText = latest.text;
          billUpdate.latestActionDate = latestDate;
          latestActionUpdated++;
        }
      }

      await prisma.bill.update({
        where: { id: b.id },
        data: billUpdate,
      });
      processed++;
    } catch (err) {
      // A quota rejection (429) is systemic — every remaining bill will hit
      // it. Stop the batch and DON'T stamp lastActionRefreshAt: stamping
      // would launder a transient throttle into a 6h cooldown for a bill we
      // never actually read. The run fails loudly below; the next scheduled
      // pass resumes once the quota window resets.
      if (isQuotaError(err)) {
        quotaExhausted = true;
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ billId: b.billId, error: msg });
      // Stamp on failure too — a bill that throws on every fetch
      // (deleted, redirected, unparseable congress.gov page) must not
      // monopolize the head of the queue. It'll come back around in
      // REFRESH_COOLDOWN_HOURS, behind everyone we successfully
      // touched in the meantime.
      try {
        await prisma.bill.update({
          where: { id: b.id },
          data: { lastActionRefreshAt: new Date() },
        });
      } catch {
        // best-effort; don't mask the original error
      }
    }
  }

  const remaining = await prisma.bill.count({
    where: {
      momentumTier: { in: tiers },
      currentStatus: { not: { startsWith: "enacted_" } },
      OR: [
        { lastActionRefreshAt: null },
        { lastActionRefreshAt: { lt: cooldownCutoff } },
      ],
    },
  });

  const elapsedMs = Date.now() - started;

  if (quotaExhausted) {
    await reportError(
      new Error(
        "Congress.gov quota exhausted (429) during backfill-bill-actions",
      ),
      { route: "GET /api/cron/backfill-bill-actions", processed },
    );
    return NextResponse.json(
      {
        ok: false,
        error: "congress_quota_exhausted",
        processed,
        statusesReconciled,
        latestActionUpdated,
        errorCount: errors.length,
        remaining,
        elapsedMs,
      },
      { status: 503 },
    );
  }

  if (errors.length > 0) {
    await reportError(new Error(`Action backfill errors: ${errors.length}`), {
      route: "GET /api/cron/backfill-bill-actions",
      errors: errors.slice(0, 10),
    });
  }

  return NextResponse.json({
    ok: true,
    processed,
    priorityProcessed: priorityRows.length,
    evidenceProcessed: evidenceRows.length,
    statusesReconciled,
    latestActionUpdated,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
    remaining,
    timedOut,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  });
}
