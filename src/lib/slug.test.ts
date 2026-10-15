import { describe, expect, it } from "vitest";

import { congressGovMemberUrl } from "./slug";

describe("congressGovMemberUrl", () => {
  it("matches Congress.gov's first-last/bioguide profile path", () => {
    expect(congressGovMemberUrl("S000033", "Bernard", "Sanders")).toBe(
      "https://www.congress.gov/member/bernard-sanders/S000033",
    );
    expect(congressGovMemberUrl("C001080", "Judy", "Chu")).toBe(
      "https://www.congress.gov/member/judy-chu/C001080",
    );
  });

  it("folds accents and spaces into the slug", () => {
    expect(
      congressGovMemberUrl("H001103", "Pablo José", "Hernández Rivera"),
    ).toBe(
      "https://www.congress.gov/member/pablo-jose-hernandez-rivera/H001103",
    );
  });
});
