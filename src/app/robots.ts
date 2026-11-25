import type { MetadataRoute } from "next";
import {
  AI_TRAINING_CRAWLERS,
  COSTLY_CRAWLERS,
  SEO_TOOL_CRAWLERS,
} from "@/lib/crawlers";

/**
 * Search engines and AI search bots crawl everything public; AI training,
 * SEO-tool and a few costly crawlers are disallowed site-wide (see
 * lib/crawlers). govroll runs on free tiers, and crawlers sweeping its ~43k
 * bill pages are what has pushed it past them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: [
          ...AI_TRAINING_CRAWLERS,
          ...SEO_TOOL_CRAWLERS,
          ...COSTLY_CRAWLERS,
        ],
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
