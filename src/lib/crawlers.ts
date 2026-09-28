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
 * also denied at the edge by the Vercel Firewall rule "Block AI training
 * crawlers" — keep the two in sync.
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
];

/**
 * Commercial SEO-tool crawlers. They send no readers, and were the heaviest
 * identified bot traffic (SemrushBot alone ~720 requests/day in Sep 2026).
 */
export const SEO_TOOL_CRAWLERS = [
  "SemrushBot",
  "AhrefsBot",
  "barkrowler",
  "MJ12bot",
  "DotBot",
  "DataForSeoBot",
  "BLEXBot",
];
