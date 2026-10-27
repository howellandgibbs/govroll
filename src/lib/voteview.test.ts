/**
 * Pins the Voteview fallback for Senate roll calls. Its rows must be
 * indistinguishable from the senate.gov-sourced ones (same bill links,
 * categories and vote vocabulary); the fixtures below are trimmed from the
 * live files.
 */
import { describe, expect, it } from "vitest";

import {
  parseVoteviewRollCall,
  parseVoteviewSenateIndex,
  voteviewBillId,
} from "./voteview";

describe("voteviewBillId", () => {
  it.each([
    ["HR9340", "house_bill-9340-119"],
    ["HRES1075", "house_resolution-1075-119"],
    ["HJRES140", "house_joint_resolution-140-119"],
    ["HCONRES89", "house_concurrent_resolution-89-119"],
    ["S2403", "senate_bill-2403-119"],
    ["SRES690", "senate_resolution-690-119"],
    ["SJRES123", "senate_joint_resolution-123-119"],
    ["SCONRES33", "senate_concurrent_resolution-33-119"],
  ])("%j → %s", (billNumber, billId) => {
    expect(voteviewBillId(billNumber, 119)).toBe(billId);
  });

  it.each(["PN1129", "TREATY5", ""])("%j is not a bill", (billNumber) => {
    expect(voteviewBillId(billNumber, 119)).toBeNull();
  });
});

describe("parseVoteviewSenateIndex", () => {
  const header =
    "congress,chamber,rollnumber,date,session,clerk_rollnumber,majority_requirement,yea_count,nay_count,bill_number,vote_result,vote_desc,vote_question,dtl_desc";
  const csv = [
    header,
    '119,Senate,659,2025-12-18,1,659,1/2,51,47,HR4,Passed,"A bill to rescind, for ""other"" purposes.",On Passage of the Bill,',
    '119,Senate,913,2026-09-30,2,254,3/5,57,43,HR9340,Cloture on the Motion to Proceed Rejected,"A bill to amend the Public Utility Regulatory Policies Act of 1978, and for other purposes.",On Cloture on the Motion to Proceed,',
    '119,Senate,915,2026-09-30,2,256,1/2,47,41,PN1129,Nomination Confirmed,"Keith Sonderling, of Florida, to be Secretary of Labor",On the Nomination,',
    "",
  ].join("\r\n");

  it("lists one session's votes with Voteview ids and bill links", () => {
    expect(parseVoteviewSenateIndex(csv, 2)).toEqual([
      {
        voteNumber: 254,
        date: "2026-09-30",
        id: "RS1190913",
        billId: "house_bill-9340-119",
      },
      { voteNumber: 256, date: "2026-09-30", id: "RS1190915", billId: null },
    ]);
    expect(parseVoteviewSenateIndex(csv, 1)).toEqual([
      {
        voteNumber: 659,
        date: "2025-12-18",
        id: "RS1190659",
        billId: "house_bill-4-119",
      },
    ]);
  });

  it("refuses an index whose columns it doesn't recognize", () => {
    // Reading a renamed column as "no votes" would store nothing, silently.
    expect(() =>
      parseVoteviewSenateIndex(
        csv.replace("clerk_rollnumber", "senate_vote"),
        2,
      ),
    ).toThrow(/missing clerk_rollnumber/);
  });
});

describe("parseVoteviewRollCall", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    apitype: "Web 2019-10",
    rollcalls: [
      {
        id: "RS1190524",
        chamber: "Senate",
        congress: 119,
        rollnumber: 524,
        clerk_rollnumber: 182,
        date: "2026-06-22",
        bill_number: "HR6644",
        question: "On the Motion",
        vote_question_text:
          "On the Motion (Motion to Concur in the House Amendment to the Senate Amendment to H.R. 6644)",
        vote_title: "Motion to Concur in the House Amendment",
        votes: [
          {
            bioguide_id: "A000382",
            lis_member_id: "S428",
            last_name: "Alsobrooks",
            state_abbrev: "MD",
            cast_str: "Yea",
            vote: "Yea",
          },
          {
            bioguide_id: "B001243",
            lis_member_id: "S396",
            last_name: "Blackburn",
            state_abbrev: "TN",
            cast_str: "Not Voting",
            vote: "Abs",
          },
          {
            bioguide_id: "B001267",
            lis_member_id: "S330",
            last_name: "Bennet",
            state_abbrev: "CO",
            cast_str: "Paired Yea",
            vote: "Abs",
          },
        ],
        ...overrides,
      },
    ],
  });

  it("parses a roll call into the senate.gov shape", () => {
    const rc = parseVoteviewRollCall(body());
    expect(rc).toMatchObject({
      chamber: "senate",
      congress: 119,
      year: 2026,
      rollCallNumber: 182,
      billId: "house_bill-6644-119",
      // From the full question text: a motion to concur is final passage,
      // which the short form ("On the Motion") can't show.
      category: "passage",
    });
    // Voteview has no time of day: midnight of the ET date.
    expect(rc.votedAt.toISOString()).toBe("2026-06-22T00:00:00.000Z");
    expect(rc.voters).toEqual([
      {
        bioguideId: "A000382",
        lisId: "S428",
        lastName: "Alsobrooks",
        state: "MD",
        vote: "Yea",
      },
      {
        bioguideId: "B001243",
        lisId: "S396",
        lastName: "Blackburn",
        state: "TN",
        vote: "Not Voting",
      },
      // An announced/paired position isn't a recorded vote.
      {
        bioguideId: "B001267",
        lisId: "S330",
        lastName: "Bennet",
        state: "CO",
        vote: "Not Voting",
      },
    ]);
  });

  it("leaves nominations and motions to proceed to legislative session unlinked", () => {
    expect(
      parseVoteviewRollCall(body({ bill_number: "PN1129" })).billId,
    ).toBeNull();
    expect(
      parseVoteviewRollCall(
        body({ vote_title: "Motion to Proceed to Legislative Session" }),
      ).billId,
    ).toBeNull();
  });

  it("throws on Voteview's error answer for an unknown id", () => {
    expect(() =>
      parseVoteviewRollCall({
        errormessage: "Invalid Rollcall ID specified.",
        errormeta: ["RS1199999"],
      }),
    ).toThrow(/Invalid Rollcall ID/);
  });
});
