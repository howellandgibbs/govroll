import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { fetchBillsPage } from "@/lib/queries/bills";
import {
  DEFAULT_BILLS_FILTERS,
  buildBillsSearchParams,
  toBillsQueryInput,
  type BillsFilterState,
} from "@/lib/queries/bills-client";
import {
  GET as searchGET,
  type GlobalSearchResponse,
} from "@/app/api/search/route";
import { GET as billsGET } from "@/app/api/bills/route";
import type { BillsQueryResult } from "@/lib/queries/bills";
import { getCurrentCongress } from "@/lib/momentum";
import { getTestPrisma } from "./db";

let seq = 0;
// Relative to today so "this Congress" vs "past Congresses" holds in 2027+.
const CURRENT = getCurrentCongress();

/**
 * Bill with a human title and a neutral official title, so full-text and
 * trigram matches come from the name under test, not the boilerplate.
 */
async function seedNamedBill(o: {
  name: string;
  tier: string;
  status?: string;
  officialTitle?: string;
  congress?: number;
  billType?: string;
  number?: number;
  summary?: string;
  policyArea?: string;
  introducedDate?: string;
  latestActionDate?: string;
  momentumScore?: number;
}) {
  seq += 1;
  const congress = o.congress ?? CURRENT;
  const billType = o.billType ?? "house_bill";
  const number = o.number ?? 1000 + seq;
  const introduced = new Date(o.introducedDate ?? "2025-06-01");
  return getTestPrisma().bill.create({
    data: {
      billId: `${billType}-${number}-${congress}`,
      title:
        o.officialTitle ??
        `To amend title ${seq} of the code, and for other purposes.`,
      displayTitle: o.name,
      shortText: o.summary ?? null,
      date: introduced,
      billType,
      currentChamber: "house",
      currentStatus: o.status ?? "introduced",
      currentStatusDate: introduced,
      introducedDate: introduced,
      latestActionDate: new Date(o.latestActionDate ?? "2025-06-02"),
      link: `https://www.congress.gov/bill/${congress}th-congress/house-bill/${number}`,
      congressNumber: congress,
      momentumTier: o.tier,
      momentumScore: o.momentumScore ?? 10,
      policyArea: o.policyArea ?? null,
    },
  });
}

function bills(search: string, overrides: Partial<BillsFilterState> = {}) {
  return fetchBillsPage(
    toBillsQueryInput({ ...DEFAULT_BILLS_FILTERS, search, ...overrides }, 1),
  );
}

async function headerSearch(q: string): Promise<GlobalSearchResponse> {
  const url = new URL("http://localhost/api/search");
  url.searchParams.set("q", q);
  const res = await searchGET(new NextRequest(url));
  expect(res.status).toBe(200);
  return res.json();
}

/** /api/bills exactly as BillListClient calls it. */
async function pageSearch(
  filters: BillsFilterState,
  page = 1,
): Promise<BillsQueryResult> {
  const params = buildBillsSearchParams(filters, page);
  const res = await billsGET(
    new NextRequest(`http://localhost/api/bills?${params}`),
  );
  expect(res.status).toBe(200);
  return res.json();
}

const names = (r: { bills: { displayTitle: string | null }[] }) =>
  r.bills.map((b) => b.displayTitle);

describe("bill keyword search", () => {
  it("finds a dormant bill by name and puts it first, over the live-only default", async () => {
    await seedNamedBill({ name: "GHOST Act", tier: "ACTIVE" });
    await seedNamedBill({ name: "FIRST Act", tier: "ADVANCING" });
    await seedNamedBill({
      name: "NEST Act",
      tier: "DEAD",
      congress: CURRENT - 1,
    });
    await seedNamedBill({ name: "NEST Act", tier: "DORMANT" });

    // The client always sends momentum=live; search must ignore it.
    const result = await pageSearch({
      ...DEFAULT_BILLS_FILTERS,
      search: "the NEST act",
    });

    expect(names(result)).toEqual(["NEST Act", "NEST Act"]);
    expect(result.bills.map((b) => b.momentumTier)).toEqual([
      "DORMANT",
      "DEAD",
    ]);
    expect(result.bills.map((b) => b.searchGroup)).toEqual(["name", "name"]);
    expect(result.groupCounts).toEqual({
      name: 2,
      live: 0,
      inactive: 0,
      past: 0,
    });
    expect(result.total).toBe(2);
    expect(result.hiddenByMomentum).toBe(0);
  });

  it("doesn't let short 'X Act' titles fuzzy-match on the shared 'act'", async () => {
    await seedNamedBill({ name: "GHOST Act", tier: "ACTIVE" });
    await seedNamedBill({ name: "BEST Act", tier: "ACTIVE" });
    const result = await bills("NEST act");
    expect(result.bills).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("orders topic searches by this Congress's live bills, then its inactive ones, then past Congresses, without pinning same-named acronym bills", async () => {
    await seedNamedBill({
      name: "HOUSING Act",
      tier: "DEAD",
      congress: CURRENT - 1,
    });
    await seedNamedBill({
      name: "Rural Housing Preservation Act",
      tier: "DORMANT",
    });
    await seedNamedBill({
      name: "Housing Voucher Act",
      tier: "ENACTED",
      congress: CURRENT - 2,
    });
    await seedNamedBill({
      name: "Affordable Housing Supply Act",
      tier: "ACTIVE",
    });

    const result = await bills("housing");

    expect(names(result)).toEqual([
      "Affordable Housing Supply Act",
      "Rural Housing Preservation Act",
      "HOUSING Act",
      "Housing Voucher Act",
    ]);
    expect(result.bills.map((b) => b.searchGroup)).toEqual([
      "live",
      "inactive",
      "past",
      "past",
    ]);
    expect(result.groupCounts).toEqual({
      name: 0,
      live: 1,
      inactive: 1,
      past: 2,
    });
  });

  it("lists a past Congress's laws before its bills that died", async () => {
    await seedNamedBill({
      name: "Housing Grants Act",
      tier: "DEAD",
      congress: CURRENT - 1,
    });
    await seedNamedBill({
      name: "Housing Finance Reform Act",
      tier: "ENACTED",
      status: "enacted_signed",
      congress: CURRENT - 1,
    });

    const result = await bills("housing");
    expect(names(result)).toEqual([
      "Housing Finance Reform Act",
      "Housing Grants Act",
    ]);
  });

  it("puts titles containing the query above matches that only share its stem", async () => {
    // "housing" and "House" both stem to "hous". Three title hits would
    // outrank the housing bill's one on relevance alone.
    await seedNamedBill({
      name: "House Rules: permitting House photographs on the House floor",
      tier: "ENACTED",
      status: "passed_simpleres",
    });
    await seedNamedBill({ name: "Housing Choice Voucher Act", tier: "ACTIVE" });

    const result = await bills("housing");
    expect(names(result)).toEqual([
      "Housing Choice Voucher Act",
      "House Rules: permitting House photographs on the House floor",
    ]);
  });

  it("ranks a bill about the topic above one that only mentions it", async () => {
    await seedNamedBill({
      name: "Further Continuing Appropriations Act",
      tier: "ACTIVE",
      // Title mentions housing too, so only relevance separates the two.
      officialTitle:
        "Making further continuing appropriations, including for housing programs.",
      // A long omnibus summary that mentions housing in passing: more raw
      // hits than the housing bill's one title hit, far lower density.
      summary: Array.from({ length: 150 }, (_, i) =>
        i % 10 === 0
          ? "This section funds housing grants for eligible states."
          : "This section funds other programs for eligible agencies nationwide.",
      ).join(" "),
    });
    await seedNamedBill({
      name: "Housing Supply Expansion Act",
      tier: "ACTIVE",
    });

    const result = await bills("housing");
    expect(names(result)).toEqual([
      "Housing Supply Expansion Act",
      "Further Continuing Appropriations Act",
    ]);
  });

  it("keeps the user's filters on a search", async () => {
    await seedNamedBill({
      name: "Clean Water Safety Act",
      tier: "ACTIVE",
      policyArea: "Water Resources Development",
    });
    await seedNamedBill({
      name: "Bridge Safety Act",
      tier: "ACTIVE",
      policyArea: "Transportation and Public Works",
    });

    const result = await bills("safety", { topic: "Environment" });
    expect(names(result)).toEqual(["Clean Water Safety Act"]);
  });

  it("honors latest and newest as chronological sorts across every tier", async () => {
    await seedNamedBill({
      name: "Port Safety Act",
      tier: "DEAD",
      introducedDate: "2025-01-10",
      latestActionDate: "2026-03-01",
    });
    await seedNamedBill({
      name: "Rail Safety Act",
      tier: "ACTIVE",
      introducedDate: "2025-05-10",
      latestActionDate: "2025-06-01",
    });
    await seedNamedBill({
      name: "Mine Safety Act",
      tier: "DORMANT",
      introducedDate: "2025-03-10",
      latestActionDate: "2025-09-01",
    });

    const latest = await bills("safety", { sortBy: "latest" });
    expect(names(latest)).toEqual([
      "Port Safety Act",
      "Mine Safety Act",
      "Rail Safety Act",
    ]);
    expect(latest.groupCounts).toBeNull();
    expect(latest.bills.every((b) => b.searchGroup === undefined)).toBe(true);
    expect(latest.total).toBe(3);

    const newest = await bills("safety", { sortBy: "newest" });
    expect(names(newest)).toEqual([
      "Rail Safety Act",
      "Mine Safety Act",
      "Port Safety Act",
    ]);
  });

  it("pages through tied results without repeats or gaps", async () => {
    for (let i = 0; i < 25; i++) {
      await seedNamedBill({ name: "Water Safety Act", tier: "DORMANT" });
    }
    const seen = new Set<number>();
    for (let page = 1; page <= 3; page++) {
      const result = await pageSearch(
        { ...DEFAULT_BILLS_FILTERS, search: "water safety act" },
        page,
      );
      for (const b of result.bills) {
        expect(seen.has(b.id)).toBe(false);
        seen.add(b.id);
      }
    }
    expect(seen.size).toBe(25);
  });
});

describe("header search parity", () => {
  it("shows the first five rows of the /bills results, including inactive bills", async () => {
    const tiers = ["ACTIVE", "DEAD", "DORMANT", "ENACTED", "STALLED"];
    for (let i = 0; i < 8; i++) {
      await seedNamedBill({
        name: `Highway Safety Improvement Act ${i}`,
        tier: tiers[i % tiers.length],
        congress: CURRENT - (i % 3),
      });
    }

    const header = await headerSearch("highway safety");
    const page = await pageSearch({
      ...DEFAULT_BILLS_FILTERS,
      search: "highway safety",
    });

    expect(header.bills).toHaveLength(5);
    expect(header.bills.map((b) => b.id)).toEqual(
      page.bills.slice(0, 5).map((b) => b.id),
    );
    expect(page.total).toBe(8);
  });

  it("returns only the cited bill for a citation, not the trending feed", async () => {
    await seedNamedBill({ name: "NEST Act", tier: "DORMANT", number: 6096 });
    await seedNamedBill({
      name: "Trending Act",
      tier: "ACTIVE",
      momentumScore: 99,
    });

    const header = await headerSearch("HR 6096");
    expect(header.bills).toEqual([]);
    expect(header.exactBill?.billId).toBe(`house_bill-6096-${CURRENT}`);
    expect(header.citation).toMatchObject({ shortLabel: "H.R.", number: 6096 });
  });
});

describe("bill browsing", () => {
  it("applies a topic label from the URL on the server path", async () => {
    await seedNamedBill({
      name: "Wetlands Act",
      tier: "ACTIVE",
      policyArea: "Environmental Protection",
    });
    const result = await bills("", { topic: "Environment" });
    expect(names(result)).toEqual(["Wetlands Act"]);
  });

  it("reports hidden inactive bills even when no live bill matches", async () => {
    await seedNamedBill({
      name: "Old Wetlands Act",
      tier: "DEAD",
      policyArea: "Environmental Protection",
    });
    const result = await bills("", { topic: "Environment" });
    expect(result.total).toBe(0);
    expect(result.hiddenByMomentum).toBe(1);
    expect(result.groupCounts).toBeNull();
  });
});
