import { describe, expect, it } from "vitest";
import {
  SITEMAP_CACHE_CONTROL,
  billSitemapName,
  parseBillSitemapName,
  renderSitemapIndex,
  renderUrlSet,
  xmlEscape,
  xmlResponse,
} from "./sitemap-xml";

describe("xmlEscape", () => {
  it("escapes the five XML special characters", () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("renderUrlSet", () => {
  it("renders loc + ISO lastmod and omits lastmod when absent", () => {
    const xml = renderUrlSet([
      {
        loc: "https://www.govroll.com/bills/119/hr/1-a&b",
        lastmod: new Date("2026-09-01T12:00:00Z"),
      },
      { loc: "https://www.govroll.com/about" },
    ]);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain(
      "<url><loc>https://www.govroll.com/bills/119/hr/1-a&amp;b</loc><lastmod>2026-09-01T12:00:00.000Z</lastmod></url>",
    );
    expect(xml).toContain(
      "<url><loc>https://www.govroll.com/about</loc></url>",
    );
    expect(xml).not.toContain("changefreq");
    expect(xml).not.toContain("priority");
  });
});

describe("renderSitemapIndex", () => {
  it("wraps entries in <sitemap> elements", () => {
    const xml = renderSitemapIndex([
      { loc: "https://www.govroll.com/sitemaps/pages.xml" },
    ]);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain(
      "<sitemap><loc>https://www.govroll.com/sitemaps/pages.xml</loc></sitemap>",
    );
  });
});

describe("xmlResponse", () => {
  it("is CDN-cacheable XML", () => {
    const res = xmlResponse("<x/>");
    expect(res.headers.get("Content-Type")).toBe(
      "application/xml; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toBe(SITEMAP_CACHE_CONTROL);
    expect(SITEMAP_CACHE_CONTROL).toMatch(/s-maxage=\d+/);
  });
});

describe("bill sitemap names", () => {
  it("round-trips congress + page", () => {
    expect(billSitemapName(119, 2)).toBe("bills-119-2.xml");
    expect(parseBillSitemapName("bills-119-2.xml")).toEqual({
      congress: 119,
      page: 2,
    });
    expect(billSitemapName(null, 1)).toBe("bills-unknown-1.xml");
    expect(parseBillSitemapName("bills-unknown-1.xml")).toEqual({
      congress: null,
      page: 1,
    });
  });

  it.each([
    "bills-119.xml",
    "bills-119-0.xml",
    "bills-abc-1.xml",
    "bills-119-1.xml.gz",
    "../bills-119-1.xml",
    "pages.xml",
  ])("rejects %s", (name) => {
    expect(parseBillSitemapName(name)).toBeNull();
  });
});
