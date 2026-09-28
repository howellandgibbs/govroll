import { beforeEach, describe, expect, it, vi } from "vitest";
import { SITEMAP_CACHE_CONTROL, SITEMAP_PAGE_SIZE } from "@/lib/sitemap-xml";

const groupBy = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { bill: { groupBy } },
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /sitemap.xml", () => {
  it("indexes pages.xml, then each Congress newest-first, paged", async () => {
    groupBy.mockResolvedValue([
      {
        congressNumber: 104,
        _count: { _all: 982 },
        _max: { currentStatusDate: new Date("1996-10-04T00:00:00Z") },
      },
      {
        congressNumber: 119,
        _count: { _all: SITEMAP_PAGE_SIZE + 1 },
        _max: { currentStatusDate: new Date("2026-09-27T00:00:00Z") },
      },
      {
        congressNumber: null,
        _count: { _all: 3 },
        _max: { currentStatusDate: null },
      },
    ]);

    const res = await GET();
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(SITEMAP_CACHE_CONTROL);
    expect(xml).toContain("<sitemapindex");
    expect(locs).toEqual([
      "https://www.govroll.com/sitemaps/pages.xml",
      "https://www.govroll.com/sitemaps/bills-119-1.xml",
      "https://www.govroll.com/sitemaps/bills-119-2.xml",
      "https://www.govroll.com/sitemaps/bills-104-1.xml",
      "https://www.govroll.com/sitemaps/bills-unknown-1.xml",
    ]);
    expect(xml).toContain(
      "<loc>https://www.govroll.com/sitemaps/bills-119-1.xml</loc><lastmod>2026-09-27T00:00:00.000Z</lastmod>",
    );
  });

  it("returns an uncacheable 503 when the DB fails", async () => {
    groupBy.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
