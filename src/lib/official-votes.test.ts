/**
 * Pins the parsing of the chambers' roll-call XML and the GovTrack-compatible
 * category vocabulary. New rows must be indistinguishable from the
 * GovTrack-era rows already stored: alignment math (votes.ts) only counts
 * passage-category votes, and vote grouping keys on the category label.
 */
import { describe, expect, it } from "vitest";

import {
  congressForYear,
  houseLegisNumToBillId,
  parseHouseRollCall,
  parseSenateRollCall,
  parseSenateVoteMenu,
  voteCategory,
} from "./official-votes";

describe("voteCategory", () => {
  it.each([
    ["On Passage", "passage"],
    ["On Motion to Suspend the Rules and Pass", "passage_suspension"],
    [
      "On Motion to Suspend the Rules and Pass, as Amended",
      "passage_suspension",
    ],
    ["On Agreeing to the Resolution", "passage"],
    ["On Agreeing to the Amendment", "amendment"],
    ["On Ordering the Previous Question", "procedural"],
    ["On Motion to Recommit", "recommit"],
    ["On Overriding the Veto", "veto_override"],
    ["Call of the House", "quorum"],
    ["On the Cloture Motion", "cloture"],
    ["On Cloture on the Motion to Proceed", "cloture"],
    ["On the Nomination", "nomination"],
    ["On the Motion to Table", "procedural"],
    ["On Passage of the Bill", "passage"],
    ["", "unknown"],
  ])("%j → %s", (question, category) => {
    expect(voteCategory(question)).toBe(category);
  });
});

describe("houseLegisNumToBillId", () => {
  it.each([
    ["H R 1234", "house_bill-1234-119"],
    ["H RES 1075", "house_resolution-1075-119"],
    ["H J RES 210", "house_joint_resolution-210-119"],
    ["H CON RES 93", "house_concurrent_resolution-93-119"],
    ["S 2403", "senate_bill-2403-119"],
    ["S J RES 5", "senate_joint_resolution-5-119"],
  ])("%j → %s", (legisNum, billId) => {
    expect(houseLegisNumToBillId(legisNum, 119)).toBe(billId);
  });

  it.each(["QUORUM", "MOTION", "ADJOURN", "JOURNAL", ""])(
    "%j is not a bill",
    (legisNum) => {
      expect(houseLegisNumToBillId(legisNum, 119)).toBeNull();
    },
  );
});

describe("congressForYear", () => {
  it("maps calendar years to congress + session", () => {
    expect(congressForYear(2025)).toEqual({ congress: 119, session: 1 });
    expect(congressForYear(2026)).toEqual({ congress: 119, session: 2 });
    expect(congressForYear(2027)).toEqual({ congress: 120, session: 1 });
  });
});

describe("parseHouseRollCall", () => {
  const roll = `<?xml version="1.0" encoding="utf-8"?>
<rollcall-vote><vote-metadata>
  <congress>119</congress><rollcall-num>314</rollcall-num>
  <legis-num>S 2403</legis-num>
  <vote-question>On Motion to Suspend the Rules and Pass</vote-question>
  <action-date>16-Sep-2026</action-date>
  <action-time time-etz="19:05">7:05 PM</action-time>
  <vote-desc></vote-desc>
</vote-metadata><vote-data>
  <recorded-vote><legislator name-id="A000370" unaccented-name="Adams" state="NC">Adams</legislator><vote>Yea</vote></recorded-vote>
  <recorded-vote><legislator name-id="A000055" unaccented-name="Aderholt" state="AL">Aderholt</legislator><vote>Not Voting</vote></recorded-vote>
</vote-data></rollcall-vote>`;

  it("parses a live-format roll call", async () => {
    const rc = await parseHouseRollCall(roll);
    expect(rc).toMatchObject({
      chamber: "house",
      congress: 119,
      year: 2026,
      rollCallNumber: 314,
      category: "passage_suspension",
      billId: "senate_bill-2403-119",
    });
    // ET wall clock in UTC fields — the GovTrack-era votedAt convention.
    expect(rc!.votedAt.toISOString()).toBe("2026-09-16T19:05:00.000Z");
    expect(rc!.voters).toEqual([
      {
        bioguideId: "A000370",
        lisId: null,
        lastName: "Adams",
        state: "NC",
        vote: "Yea",
      },
      {
        bioguideId: "A000055",
        lisId: null,
        lastName: "Aderholt",
        state: "AL",
        vote: "Not Voting",
      },
    ]);
  });

  it("returns null for the Clerk's not-yet-published placeholder", async () => {
    expect(
      await parseHouseRollCall(
        '<xml>Error sanitizing file "roll315.xml". Please try again.</xml>',
      ),
    ).toBeNull();
  });

  it("categorizes impeachment by the vote description", async () => {
    const rc = await parseHouseRollCall(
      roll
        .replace(
          "<vote-desc></vote-desc>",
          "<vote-desc>Impeaching Someone</vote-desc>",
        )
        .replace(
          "On Motion to Suspend the Rules and Pass",
          "On Agreeing to the Resolution",
        ),
    );
    expect(rc!.category).toBe("impeachment");
  });
});

describe("parseSenateRollCall", () => {
  const vote = (
    doc: string,
    amendment = "",
  ) => `<?xml version="1.0"?><roll_call_vote>
  <congress>119</congress><session>2</session><vote_number>254</vote_number>
  <vote_date>September 30, 2026,  12:51 PM</vote_date>
  <question>On Cloture on the Motion to Proceed
  </question>
  <vote_title>Motion to Invoke Cloture</vote_title>
  <document>${doc}</document>
  <amendment>${amendment}</amendment>
  <members>
    <member><last_name>Alsobrooks</last_name><state>MD</state><vote_cast>Nay</vote_cast><lis_member_id>S428</lis_member_id></member>
    <member><last_name>Banks</last_name><state>IN</state><vote_cast>Present, Giving Live Pair</vote_cast><lis_member_id>S441</lis_member_id></member>
  </members></roll_call_vote>`;

  it("parses a bill vote with LIS-keyed members", async () => {
    const rc = await parseSenateRollCall(
      vote(
        "<document_congress>119</document_congress><document_type>H.R.</document_type><document_number>9340</document_number>",
      ),
    );
    expect(rc).toMatchObject({
      chamber: "senate",
      rollCallNumber: 254,
      category: "cloture",
      billId: "house_bill-9340-119",
    });
    expect(rc.votedAt.toISOString()).toBe("2026-09-30T12:51:00.000Z");
    expect(rc.voters.map((v) => [v.lisId, v.vote])).toEqual([
      ["S428", "Nay"],
      ["S441", "Present"],
    ]);
  });

  it("links an amendment vote to the bill it amends", async () => {
    const rc = await parseSenateRollCall(
      vote(
        "<document_type/><document_number/>",
        "<amendment_number>S.Amdt. 12</amendment_number><amendment_to_document_number>S. 4668</amendment_to_document_number>",
      ),
    );
    expect(rc.billId).toBe("senate_bill-4668-119");
  });

  it("leaves nominations unlinked", async () => {
    const rc = await parseSenateRollCall(
      vote(
        "<document_type>PN</document_type><document_number>1129</document_number>",
      ),
    );
    expect(rc.billId).toBeNull();
  });
});

describe("parseSenateVoteMenu", () => {
  it("dates each vote using the menu's session year", async () => {
    const menu = await parseSenateVoteMenu(`<vote_summary>
      <congress_year>2026</congress_year>
      <votes>
        <vote><vote_number>00256</vote_number><vote_date>30-Sep</vote_date></vote>
        <vote><vote_number>00001</vote_number><vote_date>05-Jan</vote_date></vote>
      </votes></vote_summary>`);
    expect(menu).toEqual([
      { voteNumber: 256, date: "2026-09-30" },
      { voteNumber: 1, date: "2026-01-05" },
    ]);
  });
});
