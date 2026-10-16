import { describe, it, expect } from "vitest";
import {
  billHref,
  billIdentifierFor,
  billReadHref,
  parseBillIdentifier,
  parseBillPath,
  slugifyTitle,
  congressGovBillTextUrl,
  congressGovBillUrl,
} from "@/lib/bills/url";

describe("slugifyTitle", () => {
  it("lowercases, strips punctuation, and hyphenates", () => {
    expect(slugifyTitle("Victims' VOICES Act")).toBe("victims-voices-act");
  });

  it("strips diacritics", () => {
    expect(slugifyTitle("Café Reform Act")).toBe("cafe-reform-act");
  });

  it("trims hyphens at start and end", () => {
    expect(slugifyTitle("—Hello, World—")).toBe("hello-world");
  });

  it("truncates long titles at a hyphen boundary", () => {
    const long = "A".repeat(80) + " " + "B".repeat(80);
    const slug = slugifyTitle(long);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it("returns empty string for punctuation-only input", () => {
    expect(slugifyTitle("!!!")).toBe("");
  });
});

describe("parseBillIdentifier", () => {
  it("parses senate_bill-3706-118", () => {
    expect(parseBillIdentifier("senate_bill-3706-118")).toEqual({
      billType: "senate_bill",
      number: 3706,
      congress: 118,
    });
  });

  it("parses multi-underscore types", () => {
    expect(parseBillIdentifier("senate_joint_resolution-60-119")).toEqual({
      billType: "senate_joint_resolution",
      number: 60,
      congress: 119,
    });
    expect(parseBillIdentifier("house_concurrent_resolution-12-118")).toEqual({
      billType: "house_concurrent_resolution",
      number: 12,
      congress: 118,
    });
  });

  it("rejects unknown bill types", () => {
    expect(parseBillIdentifier("foo_bar-1-118")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseBillIdentifier("")).toBeNull();
    expect(parseBillIdentifier("senate_bill")).toBeNull();
    expect(parseBillIdentifier("senate_bill-abc-118")).toBeNull();
    expect(parseBillIdentifier("senate_bill-3706-xyz")).toBeNull();
  });
});

describe("billIdentifierFor", () => {
  it("composes the DB key from chamber code + number + congress", () => {
    expect(billIdentifierFor("s", 3706, 118)).toBe("senate_bill-3706-118");
    expect(billIdentifierFor("hr", 1, 119)).toBe("house_bill-1-119");
    expect(billIdentifierFor("sjres", 60, 119)).toBe(
      "senate_joint_resolution-60-119",
    );
  });

  it("returns null for unknown chamber codes", () => {
    expect(billIdentifierFor("xyz", 1, 118)).toBeNull();
  });
});

describe("billHref", () => {
  it("builds canonical URL with slug from billId text + title", () => {
    expect(
      billHref({
        billId: "senate_bill-3706-118",
        title: "Victims' VOICES Act",
      }),
    ).toBe("/bills/118/s/3706-victims-voices-act");
  });

  it("covers all chamber types", () => {
    const table: Array<[string, string]> = [
      ["house_bill-1-119", "/bills/119/hr/1-test"],
      ["senate_bill-2-119", "/bills/119/s/2-test"],
      ["house_joint_resolution-3-119", "/bills/119/hjres/3-test"],
      ["senate_joint_resolution-4-119", "/bills/119/sjres/4-test"],
      ["house_concurrent_resolution-5-119", "/bills/119/hconres/5-test"],
      ["senate_concurrent_resolution-6-119", "/bills/119/sconres/6-test"],
      ["house_resolution-7-119", "/bills/119/hres/7-test"],
      ["senate_resolution-8-119", "/bills/119/sres/8-test"],
    ];
    for (const [billId, expected] of table) {
      expect(billHref({ billId, title: "Test" })).toBe(expected);
    }
  });

  it("omits slug when title slugifies to empty", () => {
    expect(billHref({ billId: "senate_bill-3706-118", title: "!!!" })).toBe(
      "/bills/118/s/3706",
    );
  });

  it("falls back to /bills for an unparseable billId", () => {
    expect(billHref({ billId: "garbage", title: "Anything" })).toBe("/bills");
  });
});

describe("billReadHref", () => {
  it("appends /read to the canonical URL", () => {
    expect(
      billReadHref({
        billId: "senate_bill-3706-118",
        title: "Victims' VOICES Act",
      }),
    ).toBe("/bills/118/s/3706-victims-voices-act/read");
  });
});

describe("parseBillPath", () => {
  it("accepts canonical form with slug", () => {
    expect(parseBillPath(["118", "s", "3706-victims-voices-act"])).toEqual({
      congress: 118,
      chamberCode: "s",
      number: 3706,
      providedSlug: "victims-voices-act",
      canonical: true,
    });
  });

  it("accepts canonical form without slug", () => {
    expect(parseBillPath(["118", "s", "3706"])).toEqual({
      congress: 118,
      chamberCode: "s",
      number: 3706,
      providedSlug: null,
      canonical: true,
    });
  });

  it("flags Congress.gov word form as non-canonical", () => {
    expect(parseBillPath(["118th-congress", "senate-bill", "3706"])).toEqual({
      congress: 118,
      chamberCode: "s",
      number: 3706,
      providedSlug: null,
      canonical: false,
    });
  });

  it("flags uppercase chamber as non-canonical", () => {
    expect(parseBillPath(["118", "S", "3706"])).toEqual({
      congress: 118,
      chamberCode: "s",
      number: 3706,
      providedSlug: null,
      canonical: false,
    });
  });

  it("recognizes every chamber-word form", () => {
    const table: Array<[string, string]> = [
      ["house-bill", "hr"],
      ["senate-bill", "s"],
      ["house-joint-resolution", "hjres"],
      ["senate-joint-resolution", "sjres"],
      ["house-concurrent-resolution", "hconres"],
      ["senate-concurrent-resolution", "sconres"],
      ["house-resolution", "hres"],
      ["senate-resolution", "sres"],
    ];
    for (const [word, code] of table) {
      const parsed = parseBillPath(["118", word, "1"]);
      expect(parsed).not.toBeNull();
      expect(parsed!.chamberCode).toBe(code);
      expect(parsed!.canonical).toBe(false);
    }
  });

  it("rejects unknown chambers", () => {
    expect(parseBillPath(["118", "xxx", "1"])).toBeNull();
  });

  it("rejects non-numeric congress", () => {
    expect(parseBillPath(["abc", "s", "1"])).toBeNull();
  });

  it("rejects non-numeric bill number", () => {
    expect(parseBillPath(["118", "s", "abc"])).toBeNull();
  });

  it("rejects malformed congress word form", () => {
    expect(parseBillPath(["congress-118", "s", "1"])).toBeNull();
  });
});

describe("congressGovBillUrl", () => {
  it("builds the Congress.gov overview path from a billId", () => {
    expect(congressGovBillUrl({ billId: "house_resolution-1156-119" })).toBe(
      "https://www.congress.gov/bill/119th-congress/house-resolution/1156",
    );
    expect(congressGovBillUrl({ billId: "senate_bill-3706-118" })).toBe(
      "https://www.congress.gov/bill/118th-congress/senate-bill/3706",
    );
  });

  it("uses the right ordinal for every Congress", () => {
    // Bills go back to the 93rd Congress (1973); "101th" etc. was wrong.
    expect(congressGovBillUrl({ billId: "house_bill-1-101" })).toContain(
      "/101st-congress/",
    );
    expect(congressGovBillUrl({ billId: "house_bill-1-102" })).toContain(
      "/102nd-congress/",
    );
    expect(congressGovBillUrl({ billId: "house_bill-1-93" })).toContain(
      "/93rd-congress/",
    );
    expect(congressGovBillUrl({ billId: "house_bill-1-111" })).toContain(
      "/111th-congress/",
    );
  });

  it("returns null for an unparseable billId", () => {
    expect(congressGovBillUrl({ billId: "nonsense" })).toBeNull();
  });
});

describe("congressGovBillTextUrl", () => {
  it("appends /text to the overview URL", () => {
    expect(congressGovBillTextUrl({ billId: "house_bill-9340-119" })).toBe(
      "https://www.congress.gov/bill/119th-congress/house-bill/9340/text",
    );
  });
});
