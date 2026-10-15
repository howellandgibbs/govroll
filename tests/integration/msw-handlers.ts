import { http, HttpResponse } from "msw";

/**
 * Safe, do-nothing defaults for every external host the cron routes touch.
 * A test that needs real-looking data overrides the specific endpoint with
 * `server.use(...)`. Anything not covered here triggers an "unhandled
 * request" error per the `onUnhandledRequest: "error"` setup.
 */
export const defaultHandlers = [
  // GovTrack
  http.get("https://www.govtrack.us/api/v2/bill", () =>
    HttpResponse.json({ objects: [], meta: { total_count: 0 } }),
  ),
  http.get("https://www.govtrack.us/api/v2/bill/:id", () =>
    HttpResponse.json({}, { status: 404 }),
  ),
  http.get("https://www.govtrack.us/api/v2/role", () =>
    HttpResponse.json({ objects: [], meta: { total_count: 0 } }),
  ),

  // Roll-call votes (fetch-votes): no House roll published, no Senate votes.
  http.get("https://clerk.house.gov/evs/*", () =>
    HttpResponse.text("", { status: 404 }),
  ),
  http.get("https://www.senate.gov/legislative/LIS/roll_call_lists/*", () =>
    HttpResponse.text("", { status: 404 }),
  ),
  http.get("https://www.senate.gov/legislative/LIS/roll_call_votes/*", () =>
    HttpResponse.text("", { status: 404 }),
  ),
  http.get(
    "https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml",
    () => HttpResponse.text("<senators></senators>"),
  ),

  // Congress.gov
  http.get("https://api.congress.gov/v3/*", () =>
    HttpResponse.json({}, { status: 404 }),
  ),

  // GovInfo
  http.get("https://www.govinfo.gov/*", () =>
    HttpResponse.text("", { status: 404 }),
  ),
  http.head("https://www.govinfo.gov/*", () =>
    HttpResponse.text("", { status: 404 }),
  ),

  // Google Civic
  http.get("https://www.googleapis.com/civicinfo/*", () =>
    HttpResponse.json({}, { status: 404 }),
  ),

  // Anthropic — fails closed with a 503 so tests never pay for AI and the
  // generate-change-summaries path falls through to its AI-error branch
  // deterministically. A test that wants happy-path AI behavior overrides
  // this with `server.use(...)`.
  http.post("https://api.anthropic.com/v1/messages", () =>
    HttpResponse.json(
      { error: "anthropic disabled in tests" },
      { status: 503 },
    ),
  ),

  // OpenAI moderation — used by src/lib/moderation/layer2.ts. Returns a
  // not-flagged result so name / comment moderation paths don't blow up on
  // a missing handler in tests that don't care about moderation.
  http.post("https://api.openai.com/v1/moderations", () =>
    HttpResponse.json({
      id: "modr-test",
      model: "omni-moderation-latest",
      results: [{ flagged: false, categories: {}, category_scores: {} }],
    }),
  ),

  // Resend (error-reporting.ts) — ensures reportError never leaks
  http.post("https://api.resend.com/emails", () =>
    HttpResponse.json({ id: "test" }),
  ),
];
