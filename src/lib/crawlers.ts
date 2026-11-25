/**
 * Crawlers disallowed in robots.txt (see src/app/robots.ts).
 *
 * Search engines and AI *search* / user-triggered fetchers (OAI-SearchBot,
 * ChatGPT-User, PerplexityBot, Perplexity-User, Claude-SearchBot,
 * Claude-User, …) are deliberately absent — they send readers to govroll and
 * let AI answers cite it. These lists are crawlers that only take.
 */

/**
 * AI *training* crawlers. The ones that ignore robots.txt (Bytespider, …) are
 * also denied at the edge by the Cloudflare WAF user-agent block rule — keep
 * the two in sync.
 */
export const AI_TRAINING_CRAWLERS = [
  "GPTBot", // OpenAI training (OAI-SearchBot / ChatGPT-User stay allowed)
  "ClaudeBot", // Anthropic training (Claude-SearchBot / Claude-User stay allowed)
  "anthropic-ai",
  "CCBot", // Common Crawl, the base corpus most LLMs train on
  "Google-Extended", // Gemini training token; doesn't affect Googlebot
  "Applebot-Extended", // Apple AI training token; doesn't affect Applebot
  "Bytespider",
  "meta-externalagent",
  "FacebookBot",
  "Amazonbot",
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "Omgilibot",
  "omgili",
  "ImagesiftBot",
  "AI2Bot",
  "Ai2Bot-Dolma",
  "Timpibot",
  "PanguBot",
  // ElevenLabs model training. Its sibling ElevenlabsBot (pages customers add
  // to their agents' knowledge bases) stays allowed. ~5.6k reader-page
  // requests in 5h on 2026-11-08, from rotating proxy IPs.
  "ElevenlabsCrawler",
];

/**
 * Commercial SEO-tool crawlers. They send no readers, and were the heaviest
 * identified bot traffic (SemrushBot alone ~720 requests/day in Sep 2026).
 * SERankingBacklinksBot is also denied by the Cloudflare WAF rule: it swept
 * ~13.6k bill pages in a day (2026-11-08) and pushed Active CPU near the cap.
 */
export const SEO_TOOL_CRAWLERS = [
  "SemrushBot",
  "AhrefsBot",
  "barkrowler",
  "MJ12bot",
  "DotBot",
  "DataForSeoBot",
  "BLEXBot",
  "SERankingBacklinksBot",
];

/**
 * Crawlers blocked for cost alone, even though they serve AI *search* and so
 * would otherwise be allowed. govroll's hosting (Google Cloud Run) has a
 * 1 GB/month free allowance for outbound data and a $0 spend limit that takes
 * the site offline when exceeded. Also denied at the edge by the Cloudflare
 * WAF user-agent block rule; keep the two in sync.
 */
export const COSTLY_CRAWLERS = [
  // Meta AI search indexer, from Meta's own IPs (2a03:2880::/32, 57.141.x).
  // On 2026-11-18 it fetched ~40k bill pages a day, ~90% of all traffic,
  // and on pace for ~19 GB/month outbound. Its link-preview fetcher
  // facebookexternalhit stays allowed.
  "meta-webindexer",
];
