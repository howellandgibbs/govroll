import { prisma } from "@/lib/prisma";
import {
  SITE_URL,
  SITEMAP_PAGE_SIZE,
  billSitemapName,
  renderSitemapIndex,
  sitemapUnavailable,
  xmlResponse,
  type SitemapEntry,
} from "@/lib/sitemap-xml";

/**
 * GET /sitemap.xml — sitemap index: one child for the static pages and
 * representatives, then the bills split per Congress (newest first) in pages
 * of SITEMAP_PAGE_SIZE. See lib/sitemap-xml for why this isn't ISR.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const groups = await prisma.bill.groupBy({
      by: ["congressNumber"],
      _count: { _all: true },
      _max: { currentStatusDate: true },
    });

    groups.sort((a, b) => (b.congressNumber ?? -1) - (a.congressNumber ?? -1));

    const entries: SitemapEntry[] = [{ loc: `${SITE_URL}/sitemaps/pages.xml` }];
    for (const g of groups) {
      const pages = Math.ceil(g._count._all / SITEMAP_PAGE_SIZE);
      for (let page = 1; page <= pages; page++) {
        entries.push({
          loc: `${SITE_URL}/sitemaps/${billSitemapName(g.congressNumber, page)}`,
          lastmod: g._max.currentStatusDate,
        });
      }
    }

    return xmlResponse(renderSitemapIndex(entries));
  } catch (err) {
    console.error(
      "[sitemap] index query failed:",
      err instanceof Error ? err.message : err,
    );
    return sitemapUnavailable();
  }
}
