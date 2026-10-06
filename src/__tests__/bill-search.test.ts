import { describe, it, expect } from "vitest";
import {
  MIN_SEARCH_LENGTH,
  classifySearch,
  hasNameIntent,
} from "@/lib/bill-search";
import {
  DEFAULT_BILLS_FILTERS,
  buildBillsSearchParams,
  toBillsQueryInput,
} from "@/lib/queries/bills-client";

describe("classifySearch", () => {
  it("ignores input shorter than the minimum", () => {
    expect(MIN_SEARCH_LENGTH).toBe(2);
    expect(classifySearch("")).toEqual({ kind: "none" });
    expect(classifySearch(" a ")).toEqual({ kind: "none" });
  });

  it("routes citations to exact lookup", () => {
    const result = classifySearch("H.R. 6096");
    expect(result.kind).toBe("citation");
    if (result.kind === "citation") {
      expect(result.citation.billType).toBe("house_bill");
      expect(result.citation.number).toBe(6096);
    }
  });

  it("treats everything else as a trimmed keyword search", () => {
    expect(classifySearch("  NEST act ")).toEqual({
      kind: "keyword",
      text: "NEST act",
      nameIntent: true,
    });
    expect(classifySearch("housing")).toEqual({
      kind: "keyword",
      text: "housing",
      nameIntent: false,
    });
  });
});

describe("hasNameIntent", () => {
  it.each([
    "NEST act",
    "the NEST Act",
    "S.A.F.E. Act",
    "kids online safety",
    "laken riley",
    "one big beautiful bill",
  ])("reads %s as a bill name", (query) => {
    expect(hasNameIntent(query)).toBe(true);
  });

  // Single topic words collide with acronym bills (HOUSING Act, CARE Act,
  // DEFENSE Act); pinning those would bury active bills on the topic.
  it.each(["housing", "care", "defense", "nest", "the housing"])(
    "reads %s as a topic",
    (query) => {
      expect(hasNameIntent(query)).toBe(false);
    },
  );
});

describe("bills filter plumbing", () => {
  it("resolves topic labels to CRS policy areas for server callers", () => {
    const input = toBillsQueryInput(
      { ...DEFAULT_BILLS_FILTERS, topic: "Environment" },
      1,
    );
    expect(input.topic).toBe(
      "Environmental Protection,Public Lands and Natural Resources,Water Resources Development",
    );
    expect(input.page).toBe(1);
    expect(input.limit).toBe(20);
  });

  it("matches what the client sends to /api/bills", () => {
    const filters = {
      ...DEFAULT_BILLS_FILTERS,
      search: "NEST act",
      topic: "Defense",
    };
    const params = buildBillsSearchParams(filters, 2);
    const input = toBillsQueryInput(filters, 2);
    expect(params.get("topic")).toBe(input.topic);
    expect(params.get("search")).toBe(input.search);
    expect(params.get("sortBy")).toBe(input.sortBy);
    expect(params.get("momentum")).toBe(input.momentum);
    expect(Number(params.get("page"))).toBe(input.page);
    expect(Number(params.get("limit"))).toBe(input.limit);
  });

  it("passes unknown topic labels through as no filter", () => {
    expect(
      toBillsQueryInput({ ...DEFAULT_BILLS_FILTERS, topic: "Nope" }, 1).topic,
    ).toBe("");
  });
});
