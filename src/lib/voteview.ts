import axios from "axios";
import { isTransientCongressError, withRetry } from "./congress-api";
import {
  canonicalBillId,
  congressForYear,
  senateVoteCategory,
  type ParsedRollCall,
  type SenateMenuEntry,
} from "./official-votes";

/**
 * Senate roll calls from Voteview (voteview.com, UCLA Political Science) —
 * where fetch-votes reads the Senate when senate.gov won't answer, as its
 * Akamai WAF hasn't for any server-side client since 2026-10-23.
 *
 * Voteview republishes every roll call from the chambers' own records,
 * typically overnight (the 2026-09-30 votes were in its files by 07:00 UTC the
 * next day). Checked 2026-10-26 against the 98 Senate roll calls of 2026 then
 * stored from senate.gov/GovTrack: bill links, dates, and every senator's
 * position identical. Two reads cover a day:
 *
 *   - the per-Congress index, static/data/out/rollcalls/S{congress}_rollcalls.csv
 *     (~330 KB, Voteview's documented bulk data): its own sequence number, the
 *     session and the Senate's vote number within it (clerk_rollnumber), the
 *     date, and the bill ("HR9340"; "PN1129" for a nomination);
 *   - one roll call, api/download?rollcall_id=RS{congress}{seq} (the call
 *     Voteview's own R client, Rvoteview, makes): each senator's bioguide id
 *     and cast, in senate.gov's vocabulary.
 *
 * The one thing it lacks is the time of day, so votedAt is midnight of the
 * vote's ET date.
 */

const USER_AGENT = "Govroll/1.0 (+https://govroll.com; civic transparency)";

const http = axios.create({
  baseURL: "https://voteview.com",
  timeout: 15_000,
  headers: { "User-Agent": USER_AGENT },
});

/** GET, retrying only transient failures (see official-votes.ts). */
function get<T>(url: string, responseType: "text" | "json") {
  return withRetry(
    () => http.get<T>(url, { responseType }),
    2,
    1000,
    isTransientCongressError,
  );
}

/** A Senate vote menu entry, plus what's needed to fetch it from Voteview. */
export interface VoteviewMenuEntry extends SenateMenuEntry {
  /** Voteview's roll-call id: "RS1190915" = Senate, 119th, its vote #915. */
  id: string;
  /** Canonical Bill.billId; null for nominations and other non-bill votes. */
  billId: string | null;
}

/** Voteview bill-number prefixes ("HJRES") → canonical Bill.billType. */
const BILL_TYPES: Record<string, string> = {
  HR: "house_bill",
  HRES: "house_resolution",
  HJRES: "house_joint_resolution",
  HCONRES: "house_concurrent_resolution",
  S: "senate_bill",
  SRES: "senate_resolution",
  SJRES: "senate_joint_resolution",
  SCONRES: "senate_concurrent_resolution",
};

/**
 * "HR9340" → house_bill-9340-{congress}; a nomination ("PN1129") or blank →
 * null. For an amendment vote Voteview names the bill being amended — the same
 * link senate.gov's own files give.
 */
export function voteviewBillId(
  billNumber: string,
  congress: number,
): string | null {
  const m = billNumber.trim().match(/^([A-Z]+)(\d+)$/);
  return m ? canonicalBillId(BILL_TYPES[m[1]], Number(m[2]), congress) : null;
}

// ── Index ───────────────────────────────────────────────────────────────────

/** RFC 4180 text → its header row, and one record per row keyed by it. */
function parseCsv(text: string): {
  header: string[];
  records: Record<string, string>[];
} {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') field += text[++i];
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length > 0) rows.push([...row, field]);

  const [header = [], ...body] = rows;
  const records = body
    .filter((r) => r.length > 1 || r[0])
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
  return { header, records };
}

const INDEX_COLUMNS = [
  "congress",
  "chamber",
  "rollnumber",
  "date",
  "session",
  "clerk_rollnumber",
  "bill_number",
];

/** The Senate votes of one session from a Voteview roll-call index. */
export function parseVoteviewSenateIndex(
  csv: string,
  session: number,
): VoteviewMenuEntry[] {
  const { header, records } = parseCsv(csv);
  const missing = INDEX_COLUMNS.filter((c) => !header.includes(c));
  // A renamed column would otherwise read as "no votes" — green runs that
  // silently store nothing.
  if (missing.length > 0) {
    throw new Error(
      `Unrecognized Voteview roll-call index (missing ${missing.join(", ")})`,
    );
  }
  return records.flatMap((r) => {
    const congress = Number(r.congress);
    const seq = Number(r.rollnumber);
    const voteNumber = Number(r.clerk_rollnumber);
    if (
      r.chamber !== "Senate" ||
      Number(r.session) !== session ||
      !congress ||
      !seq ||
      !voteNumber ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date)
    ) {
      return [];
    }
    return [
      {
        voteNumber,
        date: r.date,
        id: `RS${congress}${String(seq).padStart(4, "0")}`,
        billId: voteviewBillId(r.bill_number, congress),
      },
    ];
  });
}

/** Every Senate roll call of `year`'s session, from Voteview's index. */
export async function fetchVoteviewSenateMenu(
  year: number,
): Promise<VoteviewMenuEntry[]> {
  const { congress, session } = congressForYear(year);
  try {
    const res = await get<string>(
      `/static/data/out/rollcalls/S${congress}_rollcalls.csv`,
      "text",
    );
    return parseVoteviewSenateIndex(res.data, session);
  } catch (error) {
    // A new Congress has no index until its first Senate vote. Mid-Congress a
    // missing file means it moved — fail rather than report "no votes".
    if (
      session === 1 &&
      axios.isAxiosError(error) &&
      error.response?.status === 404
    ) {
      return [];
    }
    throw error;
  }
}

// ── Roll calls ──────────────────────────────────────────────────────────────

/** senate.gov's vote_cast values. Voteview also codes announced and paired
 *  positions, which the Senate's own record lists as not voting. */
const CASTS = new Set([
  "Yea",
  "Nay",
  "Present",
  "Not Voting",
  "Guilty",
  "Not Guilty",
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Parse an api/download response holding one Senate roll call. */
export function parseVoteviewRollCall(body: any): ParsedRollCall {
  const rc = body?.rollcalls?.[0];
  const congress = Number(rc?.congress);
  const rollCallNumber = Number(rc?.clerk_rollnumber);
  const date = String(rc?.date ?? "");
  if (
    rc?.chamber !== "Senate" ||
    !congress ||
    !rollCallNumber ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Array.isArray(rc.votes)
  ) {
    throw new Error(
      `Unrecognized Voteview roll call (${body?.errormessage ?? `congress=${congress}, vote=${rollCallNumber}`})`,
    );
  }
  const title = String(rc.vote_title ?? "");

  return {
    chamber: "senate",
    congress,
    year: Number(date.slice(0, 4)),
    rollCallNumber,
    // Date only: midnight, ET wall clock in UTC fields (see ParsedRollCall).
    votedAt: new Date(`${date}T00:00:00Z`),
    // Voteview carries senate.gov's full and short question texts.
    category: senateVoteCategory(
      String(rc.vote_question_text || rc.question || ""),
    ),
    // As parseSenateRollCall: a motion to proceed to legislative session sits
    // on a nomination's document and stays unlinked.
    billId: title.includes("Legislative Session")
      ? null
      : voteviewBillId(String(rc.bill_number ?? ""), congress),
    voters: rc.votes.map((v: any) => ({
      bioguideId: v?.bioguide_id || null,
      lisId: v?.lis_member_id || null,
      lastName: String(v?.last_name ?? ""),
      state: String(v?.state_abbrev ?? ""),
      vote: CASTS.has(v?.cast_str) ? v.cast_str : "Not Voting",
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchVoteviewSenateRollCall(
  entry: VoteviewMenuEntry,
): Promise<ParsedRollCall> {
  const res = await get<unknown>(
    `/api/download?rollcall_id=${entry.id}`,
    "json",
  );
  const rc = parseVoteviewRollCall(res.data);
  if (rc.rollCallNumber !== entry.voteNumber) {
    throw new Error(
      `Voteview ${entry.id} is Senate vote ${rc.rollCallNumber}, expected ${entry.voteNumber}`,
    );
  }
  return rc;
}
