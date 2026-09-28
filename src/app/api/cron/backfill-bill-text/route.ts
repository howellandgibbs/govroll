import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { prisma } from "@/lib/prisma";
import { fetchBillTextFunction } from "@/scripts/fetch-bill-text";
import { isQuotaError } from "@/lib/congress-api";
import { reportError } from "@/lib/error-reporting";
import { runWithConcurrency } from "@/lib/concurrency";
import { getCurrentCongress } from "@/lib/momentum";
import { ENDED_CONGRESS_TEXT_RETRY_DAYS } from "@/lib/on-demand-bill-text";

/**
 * GET /api/cron/backfill-bill-text
 *
 * Paginated backfill for bills missing fullText. Targets the backlog of
 * bills whose text we've never successfully fetched, ordered by when we
 * last tried (NULLS FIRST, so never-attempted bills go first). Bumping
 * the attempt timestamp inside fetchBillTextFunction — even on failure —
 * is what stops permanently-unavailable bills (H.R. 6833, etc.) from
 * blocking the queue head forever.
 *
 * Protected by CRON_SECRET. Each call processes up to `limit` bills
 * selected from all bills missing text, regardless of momentum tier — a
 * just-voted-down bill can be the day's highest-interest story. Calls
 * are idempotent and self-resuming — keep calling until `remaining: 0`.
 *
 * Fetches run with bounded concurrency (3-way) inside a 55s budget so
 * we can ingest ~18 bills per invocation instead of 6, which keeps up
 * with the ~60-120 bills/day of new legislation.
 *
 * Bills from an ended Congress ride a slow lane: after their first attempt
 * they only come back around every ENDED_CONGRESS_TEXT_RETRY_DAYS. Their
 * text is either already fetched or never coming (pre-2003 bills have no
 * machine-readable text), and ~12.5k of them rotating through the hourly
 * queue was most of this cron's work for nothing.
 */

// Hobby plan cap is 60s. We budget 55s and bail early if approaching.
export const maxDuration = 60;
const TIMEOUT_MS = 55_000;
const CONCURRENCY = 3;

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
  // With 3-way concurrency each "slot" takes ~8s. 18 bills = 6 groups × 8s
  // = ~48s, safely within the 55s budget. Larger batches risk timeout.
  const limit = Math.min(
    30,
    parseInt(url.searchParams.get("limit") ?? "18", 10),
  );
  // Optional tier filter — default "all tiers" so DEAD bills eligible too.
  // Pass ?tiers=ACTIVE,ADVANCING,ENACTED to restrict, or leave off.
  const tierParam = url.searchParams.get("tiers");
  const tiers = tierParam
    ? tierParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : null;

  const started = Date.now();
  const deadline = started + TIMEOUT_MS;

  const endedCongressRetryCutoff = new Date(
    started - ENDED_CONGRESS_TEXT_RETRY_DAYS * 86_400_000,
  );
  const eligible = {
    ...(tiers ? { momentumTier: { in: tiers } } : {}),
    fullText: null,
    textVersions: { none: { fullText: { not: null } } },
    // Current-Congress bills rotate hourly; an ended Congress's bills get
    // their first attempt, then the slow lane (see the header comment).
    OR: [
      { congressNumber: null },
      { congressNumber: { gte: getCurrentCongress() } },
      { textFetchAttemptedAt: null },
      { textFetchAttemptedAt: { lt: endedCongressRetryCutoff } },
    ],
  } satisfies Prisma.BillWhereInput;

  // Least-recently-attempted first, with never-attempted bills (NULLS)
  // before any attempted ones. This turns the stuck-at-head-of-queue
  // problem into a rotation: bills that can't be fetched drop to the
  // back for ~24h while fresh bills get tried first.
  const batch = await prisma.bill.findMany({
    where: eligible,
    orderBy: [{ textFetchAttemptedAt: { sort: "asc", nulls: "first" } }],
    select: { billId: true },
    take: limit,
  });

  const results: Array<{
    billId: string;
    ok: boolean;
    error?: string;
    quota?: boolean;
  }> = await runWithConcurrency(batch, CONCURRENCY, async (b) => {
    if (Date.now() >= deadline)
      return { billId: b.billId, ok: false, error: "timeout" };
    try {
      // Inject the long-lived pooled client so all 3 concurrent workers share
      // one connection lifecycle. fetchBillTextFunction must not disconnect a
      // client it didn't create — otherwise the first worker to finish would
      // tear the pool out from under its siblings still mid-query.
      const summary = await fetchBillTextFunction(b.billId, 1, prisma);
      // fetchBillTextFunction swallows per-bill "no text available" cases and
      // stamps them as attempted; a non-zero errorCount means the bill
      // genuinely errored. Wire it through so this route's errorCount stops
      // being dead always-0 code.
      if (summary.errorCount > 0) {
        return {
          billId: b.billId,
          ok: false,
          error: summary.errors[0]?.error ?? "bill text fetch failed",
        };
      }
      return { billId: b.billId, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        billId: b.billId,
        ok: false,
        error: msg,
        quota: isQuotaError(err),
      };
    }
  });

  const processed = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => !r.ok && r.error !== "timeout");
  const timedOut = results.some((r) => r.error === "timeout");
  const quotaExhausted = results.some((r) => r.quota);

  const remaining = await prisma.bill.count({ where: eligible });

  const elapsedMs = Date.now() - started;

  // Quota exhaustion is systemic — fail the run loudly (non-200 + alert) so it
  // surfaces in GH Actions instead of looking like a green "no data" run, and
  // let the next scheduled invocation resume once the quota window resets.
  if (quotaExhausted) {
    await reportError(
      new Error("Congress.gov quota exhausted (429) during backfill-bill-text"),
      { route: "GET /api/cron/backfill-bill-text", processed },
    );
    return NextResponse.json(
      {
        ok: false,
        error: "congress_quota_exhausted",
        processed,
        errorCount: errors.length,
        remaining,
        elapsedMs,
      },
      { status: 503 },
    );
  }

  if (errors.length > 0) {
    await reportError(new Error(`Backfill errors: ${errors.length}`), {
      route: "GET /api/cron/backfill-bill-text",
      errors: errors.slice(0, 10),
    });
  }

  return NextResponse.json({
    ok: true,
    processed,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
    remaining,
    timedOut,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
  });
}
