import axios from "axios";
import { parseStringPromise } from "xml2js";
import { withRetry } from "./congress-api";

/**
 * Roll-call votes straight from the chambers' own publications:
 *
 *   House  — clerk.house.gov/evs/{year}/roll{NNN}.xml (one file per roll call,
 *            numbered from 1 each session; voters carry bioguide ids).
 *   Senate — senate.gov LIS: a per-session vote menu (number + date per vote)
 *            and one XML per vote (voters carry LIS ids, mapped to bioguide via
 *            the Senate's own member roster).
 *
 * Replaced GovTrack's /vote + /vote_voter API in Oct 2026, when govtrack.us
 * went behind a Cloudflare bot challenge that 403s every server-side client.
 * GovTrack built its vote data from these same files, so the parsing and the
 * category vocabulary below are ported from the open-source parser it uses
 * (github.com/unitedstates/congress, congress/tasks/vote_info.py) — that keeps
 * new rows consistent with the GovTrack-era rows already in the database.
 *
 * Errors go through withRetry + axios so the cron's transient classifier
 * (isTransientCongressError) treats a 5xx/429/network drop as backpressure.
 */

const USER_AGENT = "Govroll/1.0 (+https://govroll.com; civic transparency)";

const http = axios.create({
  timeout: 15_000,
  responseType: "text",
  // clerk.house.gov 406s requests that ask for application/xml only.
  headers: { "User-Agent": USER_AGENT, Accept: "text/xml, application/xml" },
});

export type VoteChamber = "house" | "senate";

/** One member's position on a roll call, keyed by whatever id the source uses. */
export interface ParsedVoter {
  /** Bioguide id (House) or null when only a LIS id is known (Senate). */
  bioguideId: string | null;
  lisId: string | null;
  lastName: string;
  state: string;
  /** Raw value: "Yea" | "Nay" | "Aye" | "No" | "Present" | "Not Voting". */
  vote: string;
}

export interface ParsedRollCall {
  chamber: VoteChamber;
  congress: number;
  year: number;
  rollCallNumber: number;
  /**
   * US Eastern wall-clock time stored in UTC fields (19:05 ET → 19:05Z). That
   * is the convention every existing RepresentativeVote.votedAt row follows
   * (GovTrack's `created` was zone-less ET, parsed as UTC), so new rows sort
   * and window consistently with old ones.
   */
  votedAt: Date;
  /** GovTrack vocabulary, underscored: "passage", "passage_suspension", … */
  category: string;
  /** Canonical Bill.billId ("house_bill-1234-119") or null for non-bill votes. */
  billId: string | null;
  voters: ParsedVoter[];
}

// ── Vote categories ─────────────────────────────────────────────────────────

/**
 * Port of get_vote_category() from unitedstates/congress vote_info.py. Order
 * matters (first match wins). Categories are underscored to match the
 * GovTrack-era rows ("passage-suspension" → "passage_suspension").
 */
const CATEGORY_RULES: [RegExp, string][] = [
  [/^$/, "unknown"],
  // common
  [/^On Overriding the Veto/i, "veto_override"],
  [/^On Presidential Veto/i, "veto_override"],
  [
    /Objections of the President (To The Contrary )?Not ?Withstanding/i,
    "veto_override",
  ],
  [/^On Passage/i, "passage"],
  [/^On the Resolution of Ratification.*/i, "treaty"],
  [/^On (Agreeing to )?the (Joint |Concurrent )?Resolution/i, "passage"],
  [/^On (Agreeing to )?the Conference Report/i, "passage"],
  [/^On (Agreeing to )?the (En Bloc )?Amendments?/i, "amendment"],
  // senate only
  [/cloture/i, "cloture"],
  [/^On the Nomination/i, "nomination"],
  [/^Guilty or Not Guilty/i, "conviction"],
  [/^On (?:the )?Motion to Recommit/i, "recommit"],
  [/^On the Motion to Concur/i, "passage"],
  [/^On the Motion to Recede and Concur with Further Amendment/i, "passage"],
  // house only
  [
    /^(On Motion (to|that the House) )?(Concur in|Concurring|Concurring in|On Concurring|On Concurring in|Agree to|On Agreeing to) (the )?Senate (Amendment|amdt|Adt)s?/i,
    "passage",
  ],
  [
    /^(On Motion to )?Suspend (the )?Rules and (Agree|Concur|Pass)/i,
    "passage_suspension",
  ],
  [/^Call of the House$/i, "quorum"],
  [/^Call by States$/i, "quorum"],
  [/^Election of the Speaker$/i, "leadership"],
  // procedural — must stay last
  [/^On Ordering the Previous Question/i, "procedural"],
  [/^On Approving the Journal/i, "procedural"],
  [
    /^Will the House Now Consider the Resolution|On (Question of )?Consideration of the Resolution/i,
    "procedural",
  ],
  [/^On (the )?Motion to Adjourn/i, "procedural"],
  [/Authoriz(e|ing) Conferees/i, "procedural"],
  [/On the Point of Order|Sustaining the Ruling of the Chair/i, "procedural"],
  [/^On .*Motion /i, "procedural"],
  [/^On the Decision of the Chair/i, "procedural"],
  [/^Whether the Amendment is Germane/i, "procedural"],
  [/^Table Appeal of the Ruling of the Chair/i, "procedural"],
];

export function voteCategory(question: string): string {
  const q = question.trim();
  for (const [re, category] of CATEGORY_RULES) {
    if (re.test(q)) return category;
  }
  return "unknown";
}

// ── Bill references ─────────────────────────────────────────────────────────

/** House legis-num prefixes ("H R 1234") → canonical Bill.billType. */
const HOUSE_BILL_TYPES: Record<string, string> = {
  "H R": "house_bill",
  "H RES": "house_resolution",
  "H J RES": "house_joint_resolution",
  "H CON RES": "house_concurrent_resolution",
  S: "senate_bill",
  "S RES": "senate_resolution",
  "S J RES": "senate_joint_resolution",
  "S CON RES": "senate_concurrent_resolution",
};

/** Senate document types ("H.R.") → canonical Bill.billType. */
const SENATE_BILL_TYPES: Record<string, string> = {
  "H.R.": "house_bill",
  "H.Res.": "house_resolution",
  "H.J.Res.": "house_joint_resolution",
  "H.Con.Res.": "house_concurrent_resolution",
  "S.": "senate_bill",
  "S.Res.": "senate_resolution",
  "S.J.Res.": "senate_joint_resolution",
  "S.Con.Res.": "senate_concurrent_resolution",
};

function canonicalBillId(
  billType: string | undefined,
  number: number,
  congress: number,
): string | null {
  if (!billType || !Number.isInteger(number) || number <= 0) return null;
  return `${billType}-${number}-${congress}`;
}

/** "H R 1234" → house_bill-1234-{congress}; "QUORUM", "MOTION", "" → null. */
export function houseLegisNumToBillId(
  legisNum: string,
  congress: number,
): string | null {
  const m = legisNum.trim().match(/^(.*\S)\s+(\d+)$/);
  if (!m) return null;
  return canonicalBillId(HOUSE_BILL_TYPES[m[1]], Number(m[2]), congress);
}

// ── XML helpers ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function text(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "object" && typeof node._ === "string") {
    return node._.trim();
  }
  return "";
}

function list<T>(node: T | T[] | undefined | ""): T[] {
  if (node == null || node === "") return [];
  return Array.isArray(node) ? node : [node];
}

function parseXml(xml: string): Promise<any> {
  return parseStringPromise(xml, { explicitArray: false });
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function monthIndex(name: string): number | undefined {
  return MONTHS[name.slice(0, 3).toLowerCase()];
}

/** ET wall clock → Date with those fields in UTC (see ParsedRollCall.votedAt). */
function etWallClock(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month, day, hour, minute));
}

/** Senate session for a calendar year: 2025 → 119th, session 1. */
export function congressForYear(year: number): {
  congress: number;
  session: number;
} {
  return {
    congress: Math.floor((year - 1789) / 2) + 1,
    session: year % 2 === 1 ? 1 : 2,
  };
}

// ── House ───────────────────────────────────────────────────────────────────

/**
 * Parse one Clerk roll-call file. Returns null when the body isn't a roll
 * call — the Clerk answers a not-yet-published roll number with a 200 and a
 * one-line error document, not a 404.
 */
export async function parseHouseRollCall(
  xml: string,
): Promise<ParsedRollCall | null> {
  let doc: any;
  try {
    doc = await parseXml(xml);
  } catch {
    return null;
  }
  const root = doc?.["rollcall-vote"];
  if (!root) return null;
  const meta = root["vote-metadata"] ?? {};

  const congress = Number(text(meta.congress));
  const rollCallNumber = Number(text(meta["rollcall-num"]));
  // action-date "16-Sep-2026"; action-time carries 24h ET in @time-etz.
  const [d, mon, y] = text(meta["action-date"]).split("-");
  const month = monthIndex(mon ?? "");
  const [hh, mm] = (meta["action-time"]?.$?.["time-etz"] ?? "0:0").split(":");
  if (!congress || !rollCallNumber || month === undefined) {
    throw new Error(
      `Unrecognized House roll-call XML (congress=${congress}, roll=${rollCallNumber})`,
    );
  }
  const year = Number(y);

  const category = text(meta["vote-desc"]).startsWith("Impeaching ")
    ? "impeachment"
    : voteCategory(text(meta["vote-question"]));

  const voters: ParsedVoter[] = list(root["vote-data"]?.["recorded-vote"]).map(
    (rv: any) => ({
      bioguideId: rv?.legislator?.$?.["name-id"] || null,
      lisId: null,
      lastName: text(rv?.legislator?.$?.["unaccented-name"] ?? rv?.legislator),
      state: rv?.legislator?.$?.state ?? "",
      vote: text(rv?.vote),
    }),
  );

  return {
    chamber: "house",
    congress,
    year,
    rollCallNumber,
    votedAt: etWallClock(year, month, Number(d), Number(hh), Number(mm)),
    category,
    billId: houseLegisNumToBillId(text(meta["legis-num"]), congress),
    voters,
  };
}

/** Fetch roll call `n` of `year`; null when the Clerk hasn't published it. */
export async function fetchHouseRollCall(
  year: number,
  n: number,
): Promise<ParsedRollCall | null> {
  const url = `https://clerk.house.gov/evs/${year}/roll${String(n).padStart(3, "0")}.xml`;
  try {
    const res = await withRetry(() => http.get<string>(url));
    return parseHouseRollCall(res.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    throw error;
  }
}

// ── Senate ──────────────────────────────────────────────────────────────────

export interface SenateMenuEntry {
  voteNumber: number;
  /** ET calendar date, "YYYY-MM-DD". */
  date: string;
}

/** Parse the per-session vote menu (vote_menu_{congress}_{session}.xml). */
export async function parseSenateVoteMenu(
  xml: string,
): Promise<SenateMenuEntry[]> {
  const doc = await parseXml(xml);
  const summary = doc?.vote_summary;
  const year = Number(text(summary?.congress_year));
  if (!summary || !year) throw new Error("Unrecognized Senate vote menu XML");
  return list(summary.votes?.vote).flatMap((v: any) => {
    // vote_date is "30-Sep" — the year comes from the menu header.
    const [day, mon] = text(v?.vote_date).split("-");
    const month = monthIndex(mon ?? "");
    const voteNumber = Number(text(v?.vote_number));
    if (month === undefined || !voteNumber) return [];
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
    return [{ voteNumber, date }];
  });
}

export async function fetchSenateVoteMenu(
  year: number,
): Promise<SenateMenuEntry[]> {
  const { congress, session } = congressForYear(year);
  const url = `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
  try {
    const res = await withRetry(() => http.get<string>(url));
    return parseSenateVoteMenu(res.data);
  } catch (error) {
    // A session with no votes yet (early January) has no menu.
    if (axios.isAxiosError(error) && error.response?.status === 404) return [];
    throw error;
  }
}

/** Parse one Senate roll-call file (vote_{congress}_{session}_{NNNNN}.xml). */
export async function parseSenateRollCall(
  xml: string,
): Promise<ParsedRollCall> {
  const doc = await parseXml(xml);
  const root = doc?.roll_call_vote;
  const congress = Number(text(root?.congress));
  const rollCallNumber = Number(text(root?.vote_number));
  // "September 30, 2026,  09:29 PM"
  const m = text(root?.vote_date).match(
    /^([A-Za-z]+)\s+(\d+),\s*(\d{4}),\s*(\d+):(\d+)\s*([AP]M)/,
  );
  const month = m ? monthIndex(m[1]) : undefined;
  if (!root || !congress || !rollCallNumber || !m || month === undefined) {
    throw new Error(
      `Unrecognized Senate roll-call XML (congress=${congress}, vote=${rollCallNumber})`,
    );
  }
  const year = Number(m[3]);
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0);

  // Upstream classifies on the vote_question element, falling back to the
  // longer question text; current files carry the short form in <question>.
  const question =
    text(root.vote_question) ||
    text(root.question) ||
    text(root.vote_question_text);
  const title = text(root.vote_title);

  // Bill linkage, as upstream: the document when it's a bill; otherwise the
  // bill an amendment amends. "Motion to Proceed to Legislative Session"
  // votes are attached to a nomination's document and deliberately unlinked.
  let billId: string | null = null;
  const docType = text(root.document?.document_type);
  if (docType && !title.includes("Legislative Session")) {
    billId = canonicalBillId(
      SENATE_BILL_TYPES[docType],
      Number(text(root.document?.document_number)),
      Number(text(root.document?.document_congress)) || congress,
    );
  }
  if (!billId && text(root.amendment?.amendment_number)) {
    const [type, num] = text(
      root.amendment?.amendment_to_document_number,
    ).split(" ");
    billId = canonicalBillId(SENATE_BILL_TYPES[type], Number(num), congress);
  }

  const voters: ParsedVoter[] = list(root.members?.member).map((mem: any) => {
    const cast = text(mem?.vote_cast);
    return {
      bioguideId: null,
      lisId: text(mem?.lis_member_id) || null,
      lastName: text(mem?.last_name),
      state: text(mem?.state),
      // Upstream folds the live-pair variant into Present.
      vote: cast === "Present, Giving Live Pair" ? "Present" : cast,
    };
  });

  return {
    chamber: "senate",
    congress,
    year,
    rollCallNumber,
    votedAt: etWallClock(year, month, Number(m[2]), hour, Number(m[5])),
    category: voteCategory(question),
    billId,
    voters,
  };
}

export async function fetchSenateRollCall(
  year: number,
  voteNumber: number,
): Promise<ParsedRollCall> {
  const { congress, session } = congressForYear(year);
  const padded = String(voteNumber).padStart(5, "0");
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const res = await withRetry(() => http.get<string>(url));
  return parseSenateRollCall(res.data);
}

/** LIS member id ("S428") → bioguide id, for every sitting senator. */
export async function parseSenateMemberRoster(
  xml: string,
): Promise<Map<string, string>> {
  const doc = await parseXml(xml);
  const map = new Map<string, string>();
  for (const s of list(doc?.senators?.senator) as any[]) {
    const lis = s?.$?.lis_member_id;
    const bioguide = text(s?.bioguideId);
    if (lis && bioguide) map.set(lis, bioguide);
  }
  return map;
}

export async function fetchSenateMemberRoster(): Promise<Map<string, string>> {
  const res = await withRetry(() =>
    http.get<string>(
      "https://www.senate.gov/legislative/LIS_MEMBER/cvc_member_data.xml",
    ),
  );
  return parseSenateMemberRoster(res.data);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
