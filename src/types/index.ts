// Shared types used across client and server

export type MomentumTier =
  | "DEAD"
  | "DORMANT"
  | "STALLED"
  | "ACTIVE"
  | "ADVANCING"
  | "ENACTED";

export type DeathReason =
  | "CONGRESS_ENDED"
  | "FAILED_VOTE"
  | "VETOED"
  | "LONG_SILENCE";

/**
 * Where a bill sits in best-match keyword results: bills titled exactly
 * what was typed, then live bills (the tiers the default feed shows),
 * then everything stalled, dormant or dead.
 */
export type BillSearchGroup = "name" | "live" | "inactive";

export interface BillSummary {
  id: number;
  billId: string;
  title: string;
  date: string;
  billType: string;
  currentChamber: string | null;
  currentStatus: string;
  currentStatusDate: string | null;
  introducedDate: string | null;
  link: string;
  shortText: string | null;
  sponsor: string | null;
  policyArea: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  momentumTier: MomentumTier | null;
  momentumScore: number | null;
  daysSinceLastAction: number | null;
  deathReason: DeathReason | null;
  popularTitle: string | null;
  shortTitle: string | null;
  displayTitle: string | null;
  publicVoteCount?: number;
  commentCount?: number;
  /** Set only on best-match keyword search results. */
  searchGroup?: BillSearchGroup;
}

export interface BillDetail extends BillSummary {
  fullText: string | null;
}

export interface ParsedCitationSummary {
  shortLabel: string;
  number: number;
  congress: number | null;
}

export interface BillListResponse {
  total: number;
  page: number;
  pageSize: number;
  bills: BillSummary[];
  hiddenByMomentum: number;
  /** Bill citation the user typed (e.g. "HR 1234"). Null if input isn't a citation. */
  citation: ParsedCitationSummary | null;
  /** Direct match for the typed citation. Null if citation didn't resolve. */
  exactMatch: BillSummary | null;
}

export interface RepresentativeInfo {
  id: number;
  bioguideId: string;
  slug: string | null;
  firstName: string;
  lastName: string;
  state: string;
  district: string | null;
  party: string;
  chamber: string;
  imageUrl: string | null;
  link: string | null;
  phone: string | null;
  /** End of current term (Jan 3 of an odd year). Drives the next-election
   * countdown. Date when read straight from the DB (server components),
   * ISO string when it crosses an API boundary. */
  termEnd?: string | Date | null;
}

export interface RepVoteHistoryEntry {
  vote: string;
  rollCallNumber: number | null;
  chamber: string | null;
  votedAt: string | null;
}

export interface RepCosponsorship {
  sponsoredAt: string | null;
  isOriginal: boolean;
  withdrawnAt: string | null;
}

export interface RepresentativeWithVote extends RepresentativeInfo {
  name: string;
  vote: string;
  /** Raw GovTrack vote category: "passage", "passage_suspension",
   * "veto_override", "amendment", "procedural", "cloture", "nomination",
   * or null. Used by the UI to label non-passage votes with context. */
  voteCategory: string | null;
  voteDate: string | null;
  voteHistory: RepVoteHistoryEntry[] | null;
  cosponsorship: RepCosponsorship | null;
}

export type ChamberName = "house" | "senate";

export type ChamberPassageStatus =
  | "passed_with_rollcall"
  | "passed_without_rollcall"
  | "rejected"
  | "pending";

export type ChamberRejectionReason = "passage" | "cloture" | "suspension";

export interface ChamberPassageInfo {
  chamber: ChamberName;
  status: ChamberPassageStatus;
  passageRollCallCount: number;
  proceduralRollCallCount: number;
  /** Only set when status === "rejected". */
  rejectionReason?: ChamberRejectionReason;
}

export interface VersionInfo {
  id: number;
  versionCode: string;
  versionType: string;
  versionDate: string;
}

export interface RollCallVote {
  rollCallNumber: number | null;
  chamber: string | null;
  votedAt: string | null;
  /** Raw GovTrack vote category ("passage", "cloture", "passage_suspension",
   * "amendment", …) or null. The card needs it to apply the right pass/fail
   * threshold — a 55-45 cloture fails (needs 60) but looks like a simple
   * majority. See {@link rollCallOutcome} in src/lib/votes.ts. */
  category: string | null;
  votes: { vote: string; count: number }[];
}

export interface VoteAggregation {
  publicVotes: { voteType: string; count: number }[];
  congressionalVotes: { vote: string; count: number }[];
  rollCalls: RollCallVote[];
  latestVersion: VersionInfo | null;
}

export interface UserVoteStatus {
  vote: {
    voteType: VoteType;
    textVersionId: number | null;
    votedAt: string;
  } | null;
  isStale: boolean;
  staleInfo: {
    votedOnVersion: {
      versionCode: string;
      versionType: string;
      versionDate: string;
    } | null;
    currentVersion: {
      versionCode: string;
      versionType: string;
      versionDate: string;
    };
    changeSummary: string | null;
  } | null;
  voteHistory: {
    voteType: string;
    createdAt: string;
    versionCode: string | null;
    versionType: string | null;
  }[];
}

export interface CommentData {
  id: number;
  content: string;
  userId: string | null;
  username: string;
  billId: number;
  parentCommentId: number | null;
  date: string;
  voteCount: number;
  replies: CommentData[];
  bill?: { id: number; billId: string; title: string };
}

export type VoteType = "For" | "Against" | "Abstain";

export interface RepVoteRecord {
  billId: number;
  billSlug: string;
  title: string;
  /** Bill introduction date — kept for back-compat. UI should prefer
   *  `votedAt` when displaying the row's date. */
  date: string;
  repVote: string;
  link: string;
  category?: string | null;
  billStatus?: string;
  /** Roll-call number on the chamber. The same bill produces multiple
   *  roll calls (motion to proceed, cloture, amendments, final passage). */
  rollCallNumber: number | null;
  chamber: string | null;
  /** ISO timestamp of the actual vote, distinct from bill introduction. */
  votedAt: string | null;
}

export interface RepVotingStats {
  totalVotes: number;
  missedVotes: number;
  missedVotePct: number;
  yeaCount: number;
  nayCount: number;
}

export interface RepresentativeDetailResponse {
  representative: RepresentativeInfo;
  votingRecord: RepVoteRecord[];
  keyVotes: RepVoteRecord[];
  sponsoredBillsCount: number;
  userVotes: Record<number, string> | null;
  stats: RepVotingStats;
}
