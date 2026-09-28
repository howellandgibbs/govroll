import { prisma } from "@/lib/prisma";
import { billHref } from "@/lib/bills/url";
import {
  SITE_URL,
  SITEMAP_PAGE_SIZE,
  parseBillSitemapName,
  renderUrlSet,
  sitemapUnavailable,
  xmlResponse,
  type SitemapEntry,
} from "@/lib/sitemap-xml";

/**
 * GET /sitemaps/pages.xml         — static pages + representatives
 * GET /sitemaps/bills-119-1.xml   — page 1 of the 119th Congress's bills
 *
 * Children of the /sitemap.xml index. See lib/sitemap-xml for why this isn't
 * ISR.
 */
export const dynamic = "force-dynamic";

const STATIC_PATHS = [
  "",
  "/bills",
  "/about",
  "/about/how-congress-votes",
  "/contact",
  "/privacy",
  "/terms",
  "/support",
  "/made-possible-by",
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  if (name === "pages.xml") {
    try {
      const reps = await prisma.representative.findMany({
        select: { bioguideId: true, slug: true },
        orderBy: { id: "asc" },
      });
      const entries: SitemapEntry[] = [
        ...STATIC_PATHS.map((path) => ({ loc: `${SITE_URL}${path}` })),
        ...reps.map((rep) => ({
          loc: `${SITE_URL}/representatives/${rep.slug || rep.bioguideId}`,
        })),
      ];
      return xmlResponse(renderUrlSet(entries));
    } catch (err) {
      console.error(
        "[sitemap] pages query failed:",
        err instanceof Error ? err.message : err,
      );
      return sitemapUnavailable();
    }
  }

  const parsed = parseBillSitemapName(name);
  if (!parsed) return new Response("Not found", { status: 404 });

  try {
    const bills = await prisma.bill.findMany({
      where: { congressNumber: parsed.congress },
      select: { billId: true, title: true, currentStatusDate: true },
      orderBy: { id: "asc" },
      skip: (parsed.page - 1) * SITEMAP_PAGE_SIZE,
      take: SITEMAP_PAGE_SIZE,
    });
    if (bills.length === 0) return new Response("Not found", { status: 404 });

    const entries: SitemapEntry[] = [];
    for (const bill of bills) {
      const href = billHref(bill);
      // billHref falls back to "/bills" for an unparseable billId.
      if (href === "/bills") continue;
      entries.push({
        loc: `${SITE_URL}${href}`,
        lastmod: bill.currentStatusDate,
      });
    }
    return xmlResponse(renderUrlSet(entries));
  } catch (err) {
    console.error(
      `[sitemap] ${name} query failed:`,
      err instanceof Error ? err.message : err,
    );
    return sitemapUnavailable();
  }
}
