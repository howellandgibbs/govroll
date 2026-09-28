import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { AI_TRAINING_CRAWLERS, SEO_TOOL_CRAWLERS } from "./crawlers";

type Rule = { userAgent?: string | string[]; disallow?: string | string[] };

function rules(): Rule[] {
  const r = robots().rules;
  return Array.isArray(r) ? r : [r];
}

/** User agents that robots.txt disallows from the whole site. */
function blockedEverywhere(): string[] {
  return rules()
    .filter(
      (r) =>
        r.disallow === "/" ||
        (Array.isArray(r.disallow) && r.disallow.includes("/")),
    )
    .flatMap((r) =>
      Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent ?? ""],
    );
}

describe("robots.txt crawler policy", () => {
  it("blocks every AI training and SEO-tool crawler site-wide", () => {
    const blocked = blockedEverywhere();
    for (const ua of [...AI_TRAINING_CRAWLERS, ...SEO_TOOL_CRAWLERS]) {
      expect(blocked).toContain(ua);
    }
  });

  it.each([
    "Googlebot",
    "Bingbot",
    "Applebot",
    "DuckDuckBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "PerplexityBot",
    "Perplexity-User",
    "Claude-SearchBot",
    "Claude-User",
    "facebookexternalhit",
  ])("keeps %s allowed (search engines and AI search stay in)", (ua) => {
    expect(blockedEverywhere().map((b) => b.toLowerCase())).not.toContain(
      ua.toLowerCase(),
    );
  });

  it("keeps the default rules and the sitemap index", () => {
    const star = rules().find((r) => r.userAgent === "*");
    expect(star?.disallow).toEqual(["/api/", "/auth/", "/account/"]);
    expect(robots().sitemap).toBe("https://www.govroll.com/sitemap.xml");
  });
});
