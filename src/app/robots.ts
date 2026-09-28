import type { MetadataRoute } from "next";
import { AI_TRAINING_CRAWLERS, SEO_TOOL_CRAWLERS } from "@/lib/crawlers";

/**
 * Search engines and AI search bots crawl everything public; AI training and
 * SEO-tool crawlers are disallowed site-wide (see lib/crawlers). govroll runs
 * on Vercel's free tier, whose Active CPU and ISR budgets were being
 * exhausted by crawlers sweeping ~43k bill pages.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: [...AI_TRAINING_CRAWLERS, ...SEO_TOOL_CRAWLERS],
        disallow: "/",
      },
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/auth/", "/account/"],
      },
    ],
    sitemap: "https://www.govroll.com/sitemap.xml",
  };
}
