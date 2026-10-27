import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import dayjs from "dayjs";
import { GET } from "@/app/api/cron/fetch-votes/route";
import { congressForYear } from "@/lib/official-votes";
import { server } from "../msw-server";
import { getTestPrisma } from "../db";
import { seedBill, seedRepresentative } from "../fixtures";
import { invokeCron } from "../invoke";

/**
 * fetch-votes reads the chambers' own XML: the House Clerk's per-roll-call
 * files and senate.gov's per-session vote menu + per-vote files + member
 * roster — or, when senate.gov refuses, Voteview's roll-call index CSV and
 * per-vote JSON. These helpers render minimal versions of each format (shapes
 * taken from the live files) and serve them through MSW.
 */

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** An ET calendar date `daysAgo` days back, as "YYYY-MM-DD". */
function etDay(daysAgo: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dayjs().subtract(daysAgo, "day").toDate());
}

function parts(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
}

type HouseVoter = { bioguideId: string; state?: string; vote: string };

function houseRollXml(rc: {
  roll: number;
  day: string;
  time?: string; // 24h ET "HH:MM"
  legisNum: string;
  question: string;
  desc?: string;
  voters: HouseVoter[];
}): string {
  const { y, m, d } = parts(rc.day);
  const voters = rc.voters
    .map(
      (v) => `
    <recorded-vote>
      <legislator name-id="${v.bioguideId}" sort-field="X" unaccented-name="X" party="D" state="${v.state ?? "CA"}" role="legislator">X</legislator>
      <vote>${v.vote}</vote>
    </recorded-vote>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<rollcall-vote>
  <vote-metadata>
    <congress>119</congress>
    <session>2nd</session>
    <chamber>U.S. House of Representatives</chamber>
    <rollcall-num>${rc.roll}</rollcall-num>
    <legis-num>${rc.legisNum}</legis-num>
    <vote-question>${rc.question}</vote-question>
    <vote-type>YEA-AND-NAY</vote-type>
    <vote-result>Passed</vote-result>
    <action-date>${d}-${MONTHS[m - 1]}-${y}</action-date>
    <action-time time-etz="${rc.time ?? "14:30"}">2:30 PM</action-time>
    <vote-desc>${rc.desc ?? ""}</vote-desc>
  </vote-metadata>
  <vote-data>${voters}
  </vote-data>
</rollcall-vote>`;
}

type SenateMember = { lis: string; last: string; state: string; vote: string };

function senateVoteXml(rc: {
  n: number;
  day: string;
  question: string;
  title?: string;
  docType?: string;
  docNumber?: number;
  amendmentNumber?: string;
  amendmentTo?: string;
  members: SenateMember[];
}): string {
  const { y, m, d } = parts(rc.day);
  const members = rc.members
    .map(
      (mem) => `
    <member>
      <last_name>${mem.last}</last_name>
      <state>${mem.state}</state>
      <vote_cast>${mem.vote}</vote_cast>
      <lis_member_id>${mem.lis}</lis_member_id>
    </member>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote>
  <congress>119</congress>
  <session>2</session>
  <vote_number>${rc.n}</vote_number>
  <vote_date>${LONG_MONTHS[m - 1]} ${d}, ${y},  12:51 PM</vote_date>
  <question>${rc.question}</question>
  <vote_title>${rc.title ?? ""}</vote_title>
  <document>
    <document_congress>119</document_congress>
    <document_type>${rc.docType ?? ""}</document_type>
    <document_number>${rc.docNumber ?? ""}</document_number>
  </document>
  <amendment>
    <amendment_number>${rc.amendmentNumber ?? ""}</amendment_number>
    <amendment_to_document_number>${rc.amendmentTo ?? ""}</amendment_to_document_number>
  </amendment>
  <members>${members}
  </members>
</roll_call_vote>`;
}

function senateMenuXml(year: number, votes: { n: number; day: string }[]) {
  const items = votes
    .map(({ n, day }) => {
      const { m, d } = parts(day);
      return `<vote><vote_number>${String(n).padStart(5, "0")}</vote_number><vote_date>${String(d).padStart(2, "0")}-${MONTHS[m - 1]}</vote_date></vote>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><vote_summary><congress>119</congress><session>2</session><congress_year>${year}</congress_year><votes>${items}</votes></vote_summary>`;
}

function rosterXml(senators: { lis: string; bioguide: string }[]) {
  const items = senators
    .map(
      (s) =>
        `<senator lis_member_id="${s.lis}"><bioguideId>${s.bioguide}</bioguideId></senator>`,
    )
    .join("");
  return `<senators>${items}</senators>`;
}

/**
 * Serve House roll calls by number for the year they fall in. Any other roll
 * number or year answers like the live Clerk does for an unpublished roll: a
 * 200 with a one-line error document. Returns the roll numbers requested.
 */
function mockHouse(rolls: Parameters<typeof houseRollXml>[0][]): number[] {
  const requested: number[] = [];
  server.use(
    http.get("https://clerk.house.gov/evs/:year/:file", ({ params }) => {
      const n = Number(String(params.file).replace(/\D/g, ""));
      requested.push(n);
      const rc = rolls.find(
        (r) => r.roll === n && r.day.startsWith(String(params.year)),
      );
      return rc
        ? HttpResponse.text(houseRollXml(rc))
        : HttpResponse.text(
            `<xml>Error sanitizing file "${params.file}". Please try again.</xml>`,
          );
    }),
  );
  return requested;
}

function mockSenate(
  votes: Parameters<typeof senateVoteXml>[0][],
  roster: { lis: string; bioguide: string }[],
) {
  server.use(
    http.get(
      "https://www.senate.gov/legislative/LIS/roll_call_lists/:file",
      () => {
        const year = votes[0] ? parts(votes[0].day).y : 2026;
        return HttpResponse.text(
          senateMenuXml(
            year,
            votes.map((v) => ({ n: v.n, day: v.day })),
          ),
        );
      },
    ),
    http.get(
      "https://www.senate.gov/legislative/LIS/roll_call_votes/:dir/:file",
      ({ params }) => {
        const n = Number(
          String(params.file).split("_").pop()!.replace(/\D/g, ""),
        );
        const v = votes.find((x) => x.n === n);
        return v
          ? HttpResponse.text(senateVoteXml(v))
          : HttpResponse.text("", { status: 404 });
      },
    ),
    http.get(
      "https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml",
      () => HttpResponse.text(rosterXml(roster)),
    ),
  );
}

type VoteviewVote = {
  /** The Senate's vote number in its session (Voteview's clerk_rollnumber). */
  n: number;
  /** Voteview's own per-Congress sequence number. */
  seq: number;
  day: string;
  billNumber: string;
  questionText: string;
  members: { bioguide: string; last: string; state: string; cast: string }[];
};

function voteviewIndexCsv(votes: VoteviewVote[]): string {
  const rows = votes.map((v) => {
    const { congress, session } = congressForYear(parts(v.day).y);
    return `${congress},Senate,${v.seq},${v.day},${session},${v.n},1/2,1,0,${v.billNumber},Agreed to,"A bill, with commas",On the Motion,`;
  });
  return [
    "congress,chamber,rollnumber,date,session,clerk_rollnumber,majority_requirement,yea_count,nay_count,bill_number,vote_result,vote_desc,vote_question,dtl_desc",
    ...rows,
    "",
  ].join("\n");
}

function voteviewRollCallJson(v: VoteviewVote) {
  const { congress } = congressForYear(parts(v.day).y);
  return {
    apitype: "Web 2019-10",
    rollcalls: [
      {
        id: `RS${congress}${String(v.seq).padStart(4, "0")}`,
        chamber: "Senate",
        congress,
        rollnumber: v.seq,
        clerk_rollnumber: v.n,
        date: v.day,
        bill_number: v.billNumber,
        question: "On the Motion",
        vote_question_text: v.questionText,
        vote_title: "",
        votes: v.members.map((m) => ({
          bioguide_id: m.bioguide,
          lis_member_id: "S999",
          last_name: m.last,
          state_abbrev: m.state,
          cast_str: m.cast,
          vote: m.cast,
        })),
      },
    ],
  };
}

/** Serve Voteview's Senate index and per-vote JSON. Returns the ids fetched. */
function mockVoteview(votes: VoteviewVote[]): string[] {
  const fetched: string[] = [];
  server.use(
    http.get("https://voteview.com/static/data/out/rollcalls/:file", () =>
      HttpResponse.text(voteviewIndexCsv(votes)),
    ),
    http.get("https://voteview.com/api/download", ({ request }) => {
      const id = new URL(request.url).searchParams.get("rollcall_id") ?? "";
      fetched.push(id);
      const v = votes.find((x) => id.endsWith(String(x.seq).padStart(4, "0")));
      return HttpResponse.json(
        v
          ? voteviewRollCallJson(v)
          : { errormessage: "Invalid Rollcall ID specified." },
      );
    }),
  );
  return fetched;
}

/** senate.gov's answer to every server-side client since 2026-10-23. Returns
 *  a counter of the requests it refused. */
function refuseSenateGov(): { count: number } {
  const refused = { count: 0 };
  server.use(
    http.get("https://www.senate.gov/*", () => {
      refused.count++;
      return new HttpResponse("Access Denied", { status: 403 });
    }),
  );
  return refused;
}

async function cursorKeys(): Promise<string[]> {
  const rows = await getTestPrisma().ingestCursor.findMany({
    orderBy: { key: "asc" },
  });
  return rows.map((r) => r.key);
}

describe("GET /api/cron/fetch-votes", () => {
  it("rejects missing auth", async () => {
    const res = await invokeCron(GET, { auth: null });
    expect(res.status).toBe(401);
  });

  it("returns ok with no votes published and advances both chambers' cursors", async () => {
    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    expect(await getTestPrisma().representativeVote.count()).toBe(0);
    expect(await cursorKeys()).toEqual([
      "fetch-votes-house",
      "fetch-votes-senate",
    ]);
  });

  it("stores House votes for known members on bill-linked roll calls", async () => {
    const day = etDay(1);
    const [a, b] = await Promise.all([
      seedRepresentative({ bioguideId: "A000370", chamber: "representative" }),
      seedRepresentative({ bioguideId: "B000001", chamber: "representative" }),
    ]);
    const bill = await seedBill({
      billId: "senate_bill-2403-119",
      billType: "senate_bill",
    });

    mockHouse([
      {
        roll: 1,
        day,
        legisNum: "QUORUM",
        question: "Call of the House",
        voters: [{ bioguideId: a.bioguideId, vote: "Present" }],
      },
      {
        roll: 2,
        day,
        time: "19:05",
        legisNum: "S 2403",
        question: "On Motion to Suspend the Rules and Pass",
        voters: [
          { bioguideId: a.bioguideId, vote: "Yea" },
          { bioguideId: b.bioguideId, vote: "Nay" },
          { bioguideId: "Z999999", vote: "Yea" }, // not in our roster
        ],
      },
    ]);

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);

    const votes = await getTestPrisma().representativeVote.findMany({
      orderBy: { representativeId: "asc" },
    });
    // The quorum call has no bill; the unknown member is skipped.
    expect(votes).toHaveLength(2);
    expect(votes.map((v) => v.vote)).toEqual(["Yea", "Nay"]);
    for (const v of votes) {
      expect(v.billId).toBe(bill.id);
      expect(v.rollCallNumber).toBe(2);
      expect(v.chamber).toBe("house");
      expect(v.category).toBe("passage_suspension");
      // ET wall clock stored in UTC fields, matching GovTrack-era rows.
      expect(v.votedAt?.toISOString()).toBe(`${day}T19:05:00.000Z`);
    }
  });

  it("maps Senate LIS ids to members and links amendment votes to the amended bill", async () => {
    const day = etDay(1);
    const schumer = await seedRepresentative({
      bioguideId: "S000148",
      lastName: "Schumer",
      state: "NY",
      chamber: "senator",
    });
    // Not on the live roster (e.g. resigned): matched by last name + state.
    const departed = await seedRepresentative({
      bioguideId: "D000001",
      lastName: "Departed",
      state: "OH",
      chamber: "senator",
    });
    const bill = await seedBill({
      billId: "house_bill-9340-119",
      billType: "house_bill",
    });

    const members: SenateMember[] = [
      { lis: "S270", last: "Schumer", state: "NY", vote: "Nay" },
      { lis: "S999", last: "Departed", state: "OH", vote: "Yea" },
    ];
    mockSenate(
      [
        {
          n: 254,
          day,
          question: "On Cloture on the Motion to Proceed",
          docType: "H.R.",
          docNumber: 9340,
          members,
        },
        {
          n: 255,
          day,
          question: "On the Amendment",
          amendmentNumber: "S.Amdt. 12",
          amendmentTo: "H.R. 9340",
          members,
        },
        {
          n: 256,
          day,
          question: "On the Nomination",
          docType: "PN",
          docNumber: 1129,
          members,
        },
      ],
      [{ lis: "S270", bioguide: "S000148" }],
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);

    const votes = await getTestPrisma().representativeVote.findMany({
      orderBy: [{ rollCallNumber: "asc" }, { representativeId: "asc" }],
    });
    // Two bill-linked roll calls × two senators; the nomination is skipped.
    expect(
      votes.map((v) => [v.rollCallNumber, v.representativeId, v.category]),
    ).toEqual([
      [254, schumer.id, "cloture"],
      [254, departed.id, "cloture"],
      [255, schumer.id, "amendment"],
      [255, departed.id, "amendment"],
    ]);
    expect(new Set(votes.map((v) => v.billId))).toEqual(new Set([bill.id]));
    expect(new Set(votes.map((v) => v.chamber))).toEqual(new Set(["senate"]));
  });

  it("reads the Senate from Voteview when senate.gov refuses, without fetching non-bill votes", async () => {
    const day = etDay(1);
    const { congress } = congressForYear(parts(day).y);
    const schumer = await seedRepresentative({
      bioguideId: "S000148",
      lastName: "Schumer",
      state: "NY",
      chamber: "senator",
    });
    const bill = await seedBill({
      billId: `house_bill-6644-${congress}`,
      billType: "house_bill",
    });
    const refused = refuseSenateGov();
    const member = {
      bioguide: schumer.bioguideId,
      last: "Schumer",
      state: "NY",
      cast: "Nay",
    };
    const fetched = mockVoteview([
      {
        n: 182,
        seq: 524,
        day,
        billNumber: "HR6644",
        questionText:
          "On the Motion (Motion to Concur in the House Amendment to the Senate Amendment to H.R. 6644)",
        members: [member],
      },
      {
        n: 183,
        seq: 525,
        day,
        billNumber: "PN1129",
        questionText: "On the Nomination PN1129",
        members: [member],
      },
    ]);

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);

    // One refused request moves the run over: no retries, no per-vote tries.
    expect(refused.count).toBe(1);
    // The index already says the nomination has no bill, so it isn't fetched.
    expect(fetched).toEqual([`RS${congress}0524`]);
    const votes = await getTestPrisma().representativeVote.findMany();
    expect(votes).toHaveLength(1);
    expect(votes[0]).toMatchObject({
      representativeId: schumer.id,
      billId: bill.id,
      vote: "Nay",
      rollCallNumber: 182,
      chamber: "senate",
      category: "passage",
    });
    // Voteview has the date but not the time of day.
    expect(votes[0].votedAt?.toISOString()).toBe(`${day}T00:00:00.000Z`);
    expect(await cursorKeys()).toEqual([
      "fetch-votes-house",
      "fetch-votes-senate",
    ]);
  });

  it("keeps ingesting the House while the Senate is unreachable at both sources", async () => {
    const day = etDay(1);
    const rep = await seedRepresentative({
      bioguideId: "H000321",
      chamber: "representative",
    });
    await seedBill({ billId: "house_bill-321-119" });
    mockHouse([
      {
        roll: 1,
        day,
        legisNum: "H R 321",
        question: "On Passage",
        voters: [{ bioguideId: rep.bioguideId, vote: "Yea" }],
      },
    ]);
    refuseSenateGov();
    server.use(
      http.get(
        "https://voteview.com/*",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );

    const res = await invokeCron(GET);
    // A block at both sources is sustained, not backpressure: the run fails
    // and alerts (as GovTrack's bot challenge should have)…
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    // …but only the Senate stops. The House votes land and its cursor moves.
    expect(await getTestPrisma().representativeVote.count()).toBe(1);
    expect(await cursorKeys()).toEqual(["fetch-votes-house"]);
  });

  it("creates a bill it hasn't ingested yet through fetch-bills, then stores the votes", async () => {
    const day = etDay(1);
    const rep = await seedRepresentative({
      bioguideId: "H000123",
      chamber: "representative",
    });

    mockHouse([
      {
        roll: 1,
        day,
        legisNum: "H RES 1075",
        question: "On Agreeing to the Resolution",
        voters: [{ bioguideId: rep.bioguideId, vote: "Aye" }],
      },
    ]);
    server.use(
      http.get("https://api.congress.gov/v3/bill/119/hres/1075", () =>
        HttpResponse.json({ bill: { introducedDate: "2026-02-20" } }),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);

    const bill = await getTestPrisma().bill.findUnique({
      where: { billId: "house_resolution-1075-119" },
    });
    expect(bill?.congressNumber).toBe(119);
    const votes = await getTestPrisma().representativeVote.findMany();
    expect(votes).toHaveLength(1);
    expect(votes[0].billId).toBe(bill?.id);
    expect(votes[0].category).toBe("passage");
  });

  it("does not clobber existing bill metadata (that belongs to fetch-bills)", async () => {
    const day = etDay(1);
    const rep = await seedRepresentative({
      bioguideId: "H000999",
      chamber: "representative",
    });
    const preexisting = await seedBill({
      billId: "house_bill-5555-119",
      title: "Authoritative Title From Fetch-Bills",
      currentStatus: "enacted",
    });
    mockHouse([
      {
        roll: 1,
        day,
        legisNum: "H R 5555",
        question: "On Passage",
        voters: [{ bioguideId: rep.bioguideId, vote: "Yea" }],
      },
    ]);

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const bill = await getTestPrisma().bill.findUnique({
      where: { id: preexisting.id },
    });
    expect(bill?.title).toBe("Authoritative Title From Fetch-Bills");
    expect(bill?.currentStatus).toBe("enacted");
    expect(await getTestPrisma().representativeVote.count()).toBe(1);
  });

  it("is idempotent — running twice yields the same rows", async () => {
    const day = etDay(1);
    const rep = await seedRepresentative({
      bioguideId: "H000042",
      chamber: "representative",
    });
    await seedBill({ billId: "house_bill-1-119" });
    const setup = () =>
      mockHouse([
        {
          roll: 1,
          day,
          legisNum: "H R 1",
          question: "On Passage",
          voters: [{ bioguideId: rep.bioguideId, vote: "Yea" }],
        },
      ]);

    setup();
    expect((await invokeCron(GET)).status).toBe(200);
    server.resetHandlers();
    setup();
    expect((await invokeCron(GET)).status).toBe(200);

    expect(await getTestPrisma().representativeVote.count()).toBe(1);
  });

  it("resumes the House walk just past the newest roll call already stored", async () => {
    const rep = await seedRepresentative({
      bioguideId: "H000007",
      chamber: "representative",
    });
    const bill = await seedBill({ billId: "house_bill-7-119" });
    const earlier = etDay(10);
    await getTestPrisma().representativeVote.create({
      data: {
        representativeId: rep.id,
        billId: bill.id,
        vote: "Yea",
        rollCallNumber: 7,
        chamber: "house",
        votedAt: new Date(`${earlier}T15:00:00Z`),
        category: "passage",
      },
    });

    const requested = mockHouse([]);
    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    // Same session year (skip the check across a New Year boundary).
    if (earlier.slice(0, 4) === etDay(0).slice(0, 4)) {
      expect(requested[0]).toBe(8);
    }
  });

  it("resumes from the stale pre-split cursor and advances each chamber's (outage recovery)", async () => {
    const db = getTestPrisma();
    // The shared cursor the chambers split from is 5 days stale, beyond the
    // 2-day self-heal overlap. A Senate vote cast 4 days ago must still be
    // picked up.
    await db.ingestCursor.create({
      data: {
        key: "fetch-votes",
        cursor: dayjs().subtract(5, "day").toDate(),
      },
    });
    const sen = await seedRepresentative({
      bioguideId: "S000005",
      lastName: "Stale",
      state: "WA",
      chamber: "senator",
    });
    await seedBill({ billId: "senate_bill-55-119", billType: "senate_bill" });
    mockSenate(
      [
        {
          n: 40,
          day: etDay(4),
          question: "On Passage of the Bill",
          docType: "S.",
          docNumber: 55,
          members: [{ lis: "S500", last: "Stale", state: "WA", vote: "Yea" }],
        },
      ],
      [{ lis: "S500", bioguide: sen.bioguideId }],
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    expect(await db.representativeVote.count()).toBe(1);

    for (const key of ["fetch-votes-house", "fetch-votes-senate"]) {
      const row = await db.ingestCursor.findUnique({ where: { key } });
      expect(row!.cursor.getTime()).toBeGreaterThan(
        dayjs().subtract(1, "day").valueOf(),
      );
    }
  });

  it("stops quietly on a transient upstream outage, leaving that chamber's cursor for the watchdog", async () => {
    // 5xx / timeouts are non-paging: 200 with upstreamPaused, and the House
    // cursor does NOT advance, so ingest-health pages if it stays stuck for
    // 12h. The Senate, a different source, carries on.
    server.use(
      http.get(
        "https://clerk.house.gov/evs/:year/:file",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.upstreamPaused).toBe(true);
    expect(await cursorKeys()).toEqual(["fetch-votes-senate"]);
  });

  it("still returns 500 on a non-transient failure (systemic failure is not laundered into ok)", async () => {
    // A 403 from the Clerk (no fallback source) is a sustained block, not
    // backpressure, so it must fail the run and alert.
    server.use(
      http.get(
        "https://clerk.house.gov/evs/:year/:file",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );

    const res = await invokeCron(GET);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it("accepts ?since=YYYY-MM-DD and rejects a malformed value", async () => {
    const bad = await invokeCron(GET, { search: { since: "06-2026" } });
    expect(bad.status).toBe(400);

    const good = await invokeCron(GET, { search: { since: etDay(1) } });
    expect(good.status).toBe(200);
  });
});
