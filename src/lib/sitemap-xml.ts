/**
 * Sitemap rendering for the `/sitemap.xml` index and its `/sitemaps/*.xml`
 * children.
 *
 * These are plain dynamic Route Handlers cached by Vercel's CDN via
 * Cache-Control — deliberately not the `sitemap.ts` metadata convention,
 * which Next caches as an ISR route. The old single ISR sitemap was ~9 MB,
 * cost ~90 ISR write units per regeneration against the Hobby plan's 200k
 * monthly budget, froze on 2026-09-12 (never regenerated again), and was
 * headed for the protocol's 50,000-URL cap.
 */

export const SITE_URL = "https://www.govroll.com";

/**
 * URLs per child sitemap. Keeps each response well under both the 50,000-URL
 * protocol cap and Vercel's ~4.5 MB function response limit (~150 bytes per
 * `<url>` entry → ~1.5 MB).
 */
export const SITEMAP_PAGE_SIZE = 10_000;

/** A day at the CDN, then served stale while it refreshes in the background. */
export const SITEMAP_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

export interface SitemapEntry {
  loc: string;
  lastmod?: Date | null;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderEntries(tag: "url" | "sitemap", entries: SitemapEntry[]) {
  return entries
    .map((e) => {
      const lastmod = e.lastmod
        ? `<lastmod>${e.lastmod.toISOString()}</lastmod>`
        : "";
      return `<${tag}><loc>${xmlEscape(e.loc)}</loc>${lastmod}</${tag}>`;
    })
    .join("\n");
}

/**
 * `<urlset>` of page URLs. Only `loc` + `lastmod`: Google ignores
 * `changefreq` and `priority`, and dropping them keeps pages small.
 */
export function renderUrlSet(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    renderEntries("url", entries),
    "</urlset>",
  ].join("\n");
}

/** `<sitemapindex>` pointing at child sitemaps. */
export function renderSitemapIndex(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    renderEntries("sitemap", entries),
    "</sitemapindex>",
  ].join("\n");
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": SITEMAP_CACHE_CONTROL,
    },
  });
}

/** Never let the CDN hold on to a failure. */
export function sitemapUnavailable(): Response {
  return new Response("Sitemap temporarily unavailable", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "3600" },
  });
}

/**
 * Child sitemap for page `page` (1-based) of a Congress's bills, e.g.
 * `bills-119-2.xml`. Bills with no congressNumber land in `bills-unknown-*`.
 */
export function billSitemapName(congress: number | null, page: number) {
  return `bills-${congress ?? "unknown"}-${page}.xml`;
}

export function parseBillSitemapName(
  name: string,
): { congress: number | null; page: number } | null {
  const m = /^bills-(\d{1,3}|unknown)-([1-9]\d{0,2})\.xml$/.exec(name);
  if (!m) return null;
  return {
    congress: m[1] === "unknown" ? null : Number(m[1]),
    page: Number(m[2]),
  };
}
