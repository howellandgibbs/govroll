import { describe, it, expect } from "vitest";
import { reconcileStatus } from "./reconcile-bill-status";
import type { CongressAction } from "./congress-api";

// Compact builder for congress.gov action rows. Dates only need to be
// distinct/orderable for the few date-comparison branches.
function action(
  text: string,
  opts: {
    type?: string | null;
    chamber?: string | null;
    date?: string;
  } = {},
): CongressAction {
  return {
    text,
    type: opts.type ?? "Floor",
    chamber: opts.chamber ?? null,
    actionDate: opts.date ?? "2026-01-01",
  };
}

const INTRODUCED = action("Introduced in House", {
  type: "IntroReferral",
  chamber: null,
});

describe("reconcileStatus — enacted", () => {
  it("introduced bill that became public law → enacted_signed", () => {
    const actions = [
      action("Became Public Law No: 119-91.", {
        type: "President",
        date: "2026-05-19",
      }),
      action("Signed by President.", { type: "President", date: "2026-05-19" }),
      action("Presented to President.", {
        chamber: "House",
        date: "2026-05-12",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "enacted_signed",
    );
  });

  it("passed_bill that was signed → enacted_signed (no separate law row)", () => {
    const actions = [
      action("Signed by President.", { type: "President", date: "2026-04-13" }),
      action("Passed/agreed to in Senate: Passed Senate.", {
        chamber: null,
        date: "2026-03-01",
      }),
    ];
    expect(reconcileStatus("passed_bill", "senate_bill", actions)).toBe(
      "enacted_signed",
    );
  });

  it("private law → enacted_signed", () => {
    const actions = [
      action("Became Private Law No: 111-1.", {
        type: "President",
        date: "2010-05-01",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "enacted_signed",
    );
  });

  it("already enacted_signed → null (authoritative, never walked back)", () => {
    const actions = [
      action("Became Public Law No: 119-91.", { type: "President" }),
    ];
    expect(reconcileStatus("enacted_signed", "house_bill", actions)).toBeNull();
  });
});

describe("reconcileStatus — failed in origin chamber", () => {
  it("House bill voted down in the House → fail_originating_house", () => {
    const actions = [
      action(
        "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).",
        { chamber: null, date: "2026-01-13" },
      ),
      action(
        "On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).",
        {
          chamber: "House",
          date: "2026-01-13",
        },
      ),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "fail_originating_house",
    );
  });

  it("corrects a bill mislabeled pass_over_house that actually failed in the House", () => {
    // The real house_bill-1329-119 case: loose /passed|agreed/ once promoted
    // it to pass_over_house; it had in fact failed on the floor.
    const actions = [
      action(
        "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).",
        { chamber: null, date: "2026-05-21" },
      ),
      action(
        "On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).",
        {
          chamber: "House",
          date: "2026-05-21",
        },
      ),
    ];
    expect(reconcileStatus("pass_over_house", "house_bill", actions)).toBe(
      "fail_originating_house",
    );
  });

  it("Senate joint resolution failed in the Senate → fail_originating_senate", () => {
    const actions = [
      action(
        "Failed of passage in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 654.",
        { chamber: "Senate", date: "2025-12-18" },
      ),
    ];
    expect(
      reconcileStatus("introduced", "senate_joint_resolution", actions),
    ).toBe("fail_originating_senate");
  });

  it("a failed recommit motion does NOT count as a bill failure", () => {
    const actions = [
      action(
        "On motion to recommit Failed by the Yeas and Nays: 209 - 213 (Roll no. 18).",
        { chamber: "House" },
      ),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBeNull();
  });

  it("failed an early vote but later passed → treated as passed, not failed", () => {
    const actions = [
      action("Passed/agreed to in House: On passage Passed by recorded vote.", {
        chamber: null,
        date: "2026-02-01",
      }),
      action(
        "On passage Failed by the Yeas and Nays: 200 - 220 (Roll no. 5).",
        {
          chamber: "House",
          date: "2026-01-10",
        },
      ),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "pass_over_house",
    );
  });

  it("a failed suspension vote is provisional, NOT a hard origin failure", () => {
    // The real house_joint_resolution-139 case — fell short of 2/3 under
    // suspension, but can still return under a rule (prov_kill_suspensionfailed).
    const actions = [
      action(
        "Failed of passage/not agreed to in House On motion to suspend the rules and pass the resolution Failed by the Yeas and Nays: (2/3 required): 211 - 207 (Roll no. 95).",
        { chamber: null },
      ),
      INTRODUCED,
    ];
    expect(
      reconcileStatus("introduced", "house_joint_resolution", actions),
    ).toBeNull();
  });

  it("a 'Rule … passed House' cross-reference does not mask a real floor defeat", () => {
    // house_bill-1329-119: the rule resolution clearing the floor must not be
    // read as the bill passing and so suppress the genuine failure.
    const actions = [
      action(
        "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).",
        { chamber: null, date: "2026-05-21" },
      ),
      action(
        "On passage Failed by the Yeas and Nays: 204 - 216 (Roll no. 188).",
        {
          chamber: "House",
          date: "2026-05-21",
        },
      ),
      action("Rule H. Res. 1300 passed House.", {
        chamber: "House",
        date: "2026-05-20",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("pass_over_house", "house_bill", actions)).toBe(
      "fail_originating_house",
    );
  });
});

describe("reconcileStatus — vetoed", () => {
  it("passed_bill then vetoed → prov_kill_veto", () => {
    const actions = [
      action("Vetoed by President.", { type: "President", date: "2026-05-01" }),
      action("Passed/agreed to in Senate: Passed Senate.", {
        chamber: null,
        date: "2026-03-01",
      }),
    ];
    expect(reconcileStatus("passed_bill", "senate_bill", actions)).toBe(
      "prov_kill_veto",
    );
  });

  it("leaves a more-specific veto outcome (failed override) untouched", () => {
    const actions = [action("Veto message received.", { type: "President" })];
    expect(
      reconcileStatus(
        "vetoed_override_fail_originating_house",
        "house_bill",
        actions,
      ),
    ).toBeNull();
  });
});

describe("reconcileStatus — simple resolutions are terminal in origin", () => {
  it("adopted H.Res. → passed_simpleres, not pass_over_house", () => {
    const actions = [
      action("On agreeing to the resolution Agreed to without objection.", {
        chamber: "House",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_resolution", actions)).toBe(
      "passed_simpleres",
    );
  });

  it("corrects an S.Res. mislabeled pass_over_senate → passed_simpleres", () => {
    const actions = [
      action(
        "Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous Consent.",
        { chamber: "Senate" },
      ),
    ];
    expect(
      reconcileStatus("pass_over_senate", "senate_resolution", actions),
    ).toBe("passed_simpleres");
  });

  it("self-executing adoption ('considered passed House') → passed_simpleres", () => {
    // house_resolution-375-119 — deemed passed under the terms of a rule, with
    // no separate roll-call row.
    const actions = [
      action(
        "Pursuant to the provisions of H. Res. 1014, H. Res. 375 is considered passed House as amended.",
        { chamber: "House" },
      ),
      INTRODUCED,
    ];
    expect(
      reconcileStatus("pass_over_house", "house_resolution", actions),
    ).toBe("passed_simpleres");
  });

  it("already passed_simpleres → null", () => {
    const actions = [
      action("Passed/agreed to in Senate: Resolution agreed to.", {
        chamber: null,
      }),
    ];
    expect(
      reconcileStatus("passed_simpleres", "senate_resolution", actions),
    ).toBeNull();
  });
});

describe("reconcileStatus — concurrent resolutions", () => {
  it("passed both chambers → passed_concurrentres", () => {
    const actions = [
      action("Passed/agreed to in Senate: Agreed to in Senate.", {
        chamber: null,
        date: "2026-03-01",
      }),
      action("On agreeing to the resolution Agreed to without objection.", {
        chamber: "House",
        date: "2026-02-01",
      }),
      INTRODUCED,
    ];
    expect(
      reconcileStatus("introduced", "house_concurrent_resolution", actions),
    ).toBe("passed_concurrentres");
  });

  it("passed only the origin chamber → pass_over_house", () => {
    const actions = [
      action("On agreeing to the resolution Agreed to without objection.", {
        chamber: "House",
      }),
      INTRODUCED,
    ];
    expect(
      reconcileStatus("introduced", "house_concurrent_resolution", actions),
    ).toBe("pass_over_house");
  });

  it("pass_over_house concurrent res that cleared the Senate → passed_concurrentres", () => {
    const actions = [
      action("Passed/agreed to in Senate: Agreed to in Senate.", {
        chamber: null,
      }),
      action("Passed/agreed to in House: Agreed to in House.", {
        chamber: null,
      }),
    ];
    expect(
      reconcileStatus(
        "pass_over_house",
        "house_concurrent_resolution",
        actions,
      ),
    ).toBe("passed_concurrentres");
  });
});

describe("reconcileStatus — procedural noise is NOT passage", () => {
  const noise = [
    "Motion to proceed to consideration of measure agreed to in Senate.",
    "On ordering the previous question Agreed to without objection.",
    "On motion that the committee rise Agreed to by voice vote.",
    "Motion to reconsider laid on the table Agreed to without objection.",
    "The title of the measure was amended. Agreed to without objection.",
    "On agreeing to the Smith amendment Agreed to by voice vote.",
    "Rule H. Res. 1300 passed House.",
  ];
  for (const text of noise) {
    it(`"${text.slice(0, 40)}…" → null`, () => {
      const actions = [action(text, { chamber: "House" }), INTRODUCED];
      expect(reconcileStatus("introduced", "house_bill", actions)).toBeNull();
    });
  }
});

describe("reconcileStatus — real bicameral passage", () => {
  it("introduced bill that passed both chambers → passed_bill", () => {
    const actions = [
      action("Passed/agreed to in Senate: Passed Senate without amendment.", {
        chamber: null,
        date: "2026-03-01",
      }),
      action("Passed/agreed to in House: On passage Passed by recorded vote.", {
        chamber: null,
        date: "2026-02-01",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "passed_bill",
    );
  });

  it("introduced bill that passed only its origin → pass_over_house", () => {
    const actions = [
      action(
        "On motion to suspend the rules and pass the bill Agreed to by voice vote.",
        { chamber: "House" },
      ),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBe(
      "pass_over_house",
    );
  });

  it("pass_over_senate bill that cleared the House → passed_bill", () => {
    const actions = [
      action("Passed/agreed to in House: Passed House.", { chamber: null }),
      action("Passed/agreed to in Senate: Passed Senate.", { chamber: null }),
    ];
    expect(reconcileStatus("pass_over_senate", "senate_bill", actions)).toBe(
      "passed_bill",
    );
  });

  it("introduced bill with no floor passage → null", () => {
    const actions = [
      action("Reported by the Committee on Natural Resources.", {
        type: "Committee",
        chamber: "House",
      }),
      INTRODUCED,
    ];
    expect(reconcileStatus("introduced", "house_bill", actions)).toBeNull();
  });
});
