import { beforeEach, describe, expect, it, vi } from "vitest";
import { SITEMAP_CACHE_CONTROL, SITEMAP_PAGE_SIZE } from "@/lib/sitemap-xml";

const billFindMany = vi.fn();
const repFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bill: { findMany: billFindMany },
    representative: { findMany: repFindMany },
  },
}));

const { GET } = await import("./route");

function get(name: string) {
  return GET(new Request(`https://www.govroll.com/sitemaps/${name}`), {
    params: Promise.resolve({ name }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /sitemaps/[name]", () => {
  it("serves static pages + representatives as pages.xml", async () => {
    repFindMany.mockResolvedValue([
      { bioguideId: "P000197", slug: "nancy-pelosi" },
      { bioguideId: "X000001", slug: null },
    ]);
    const res = await get("pages.xml");
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(SITEMAP_CACHE_CONTROL);
    expect(xml).toContain("<loc>https://www.govroll.com</loc>");
    expect(xml).toContain("<loc>https://www.govroll.com/bills</loc>");
    expect(xml).toContain(
      "<loc>https://www.govroll.com/representatives/nancy-pelosi</loc>",
    );
    expect(xml).toContain(
      "<loc>https://www.govroll.com/representatives/X000001</loc>",
    );
  });

  it("pages one Congress's bills with canonical slugged URLs", async () => {
    billFindMany.mockResolvedValue([
      {
        billId: "house_bill-248-119",
        title: "Baby Changing on Board Act",
        currentStatusDate: new Date("2026-09-01T00:00:00Z"),
      },
      {
        billId: "garbage",
        title: "Unparseable",
        currentStatusDate: new Date("2026-09-01T00:00:00Z"),
      },
    ]);
    const res = await get("bills-119-2.xml");
    const xml = await res.text();

    expect(billFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { congressNumber: 119 },
        skip: SITEMAP_PAGE_SIZE,
        take: SITEMAP_PAGE_SIZE,
      }),
    );
    expect(xml).toContain(
      "<url><loc>https://www.govroll.com/bills/119/hr/248-baby-changing-on-board-act</loc><lastmod>2026-09-01T00:00:00.000Z</lastmod></url>",
    );
    // Unparseable billIds would all collapse to /bills — skipped.
    expect(xml.match(/<url>/g)).toHaveLength(1);
  });

  it("maps bills-unknown to bills with no congressNumber", async () => {
    billFindMany.mockResolvedValue([]);
    const res = await get("bills-unknown-1.xml");
    expect(billFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { congressNumber: null } }),
    );
    // Empty page → 404 rather than an empty urlset.
    expect(res.status).toBe(404);
  });

  it("404s unknown names without touching the DB", async () => {
    const res = await get("bills-119.xml");
    expect(res.status).toBe(404);
    expect(billFindMany).not.toHaveBeenCalled();
  });

  it("returns an uncacheable 503 when the DB fails", async () => {
    billFindMany.mockRejectedValue(new Error("db down"));
    const res = await get("bills-119-1.xml");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
