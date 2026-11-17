import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  ensureSummaryJob,
  generateSummaryForVersion,
  readSummaryState,
  assertOndemandSummaryDailyCap,
} from "@/lib/bill-summary";
import {
  assertIpRateLimit,
  getClientIp,
  RateLimitError,
} from "@/lib/rate-limit";
import { cpuThrottledAfterResponse } from "@/lib/hosting";

/**
 * POST /api/bills/[id]/summary
 *
 * Idempotently ensures an AI change-summary exists (or is being generated)
 * for the latest substantive version of the given bill. On first call this
 * kicks off generation via `after()` — the response returns immediately
 * (`status: "pending"`) while the server finishes the AI call in the
 * background. On Cloud Run, which throttles CPU after the response, the first
 * call instead waits for generation and returns the finished state.
 * Subsequent calls are safe, cheap status-polls.
 *
 * Response shapes:
 *   { status: "ready",         summary, versionCode, versionType, versionDate }
 *   { status: "pending",       versionCode, versionType, versionDate, startedAt }
 *   { status: "not_generated", versionCode, versionType, versionDate }
 *   { status: "disabled",      reason: "budget" | "manual" }
 *   { status: "error",         error, versionCode, versionType, versionDate }
 *   { status: "none" }  — bill has no substantive version
 *
 * Public: no auth required so the bill-reading UX works for anyone. Spend is
 * bounded three ways: the per-version SummaryJob dedup, a per-IP throttle plus
 * a fleet-wide daily cap on *new* generations (a paid Haiku call costs ~$0.10
 * per version and the backlog is ~12k bills), and the budget gate at the AI
 * layer. Only the `not_generated → trigger` path spends money; polls of an
 * already-ready/pending summary skip the throttles entirely.
 */

/** Per-IP ceiling on *new* generations per hour. Polls don't count — only the
 *  request that actually starts a generation does — so this is generous for a
 *  reader opening many backlog bills yet tight against a single abuser (≈30
 *  generations/hr ≈ $3/hr). */
const MAX_SUMMARY_TRIGGERS_PER_IP_PER_HOUR = 30;

export const maxDuration = 60;

function invalidBillId() {
  return NextResponse.json(
    { status: "error", error: "invalid bill id" },
    { status: 400 },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const billId = parseInt(id, 10);
  if (Number.isNaN(billId)) return invalidBillId();

  // Read current state with no side effects so a poll never spends money and
  // we can tell a poll apart from the one request that would start generation.
  const state = await readSummaryState(billId);

  // ready / pending / none are cheap reads — return them untouched.
  if (state.status !== "not_generated") {
    return NextResponse.json(state);
  }

  // This request would start a paid generation: gate it.
  try {
    assertIpRateLimit(
      getClientIp(request),
      MAX_SUMMARY_TRIGGERS_PER_IP_PER_HOUR,
    );
    await assertOndemandSummaryDailyCap();
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(err.toJSON(), {
        status: 429,
        headers: { "Retry-After": String(err.retryAfterSeconds) },
      });
    }
    throw err;
  }

  const outcome = await ensureSummaryJob(billId);

  if (outcome.started) {
    if (cpuThrottledAfterResponse()) {
      // Cloud Run throttles CPU once the response is sent, so generate inside
      // the request (a few seconds of Haiku) and return the finished state.
      await generateSummaryForVersion(outcome.versionId);
      return NextResponse.json(await readSummaryState(billId));
    }
    // Fire-and-forget generation; response returns to the client while the
    // instance keeps the handle alive. If the instance crashes mid-run the
    // STALE_PENDING_MS fallback lets the next caller retry.
    after(generateSummaryForVersion(outcome.versionId));
  }

  return NextResponse.json(outcome.state);
}

// GET is read-only. Browser prefetch, link unfurlers, and crawlers will GET
// this URL; they must never trigger a paid generation, so GET only reports the
// current persisted state. The bill page's client polls with POST to generate.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const billId = parseInt(id, 10);
  if (Number.isNaN(billId)) return invalidBillId();

  const state = await readSummaryState(billId);
  return NextResponse.json(state);
}
