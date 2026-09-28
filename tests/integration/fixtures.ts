import { getTestPrisma } from "./db";

/**
 * Minimal, composable seed helpers. Tests pick what they need — no global
 * fixture state. Keep the helpers narrow so intent stays obvious at the
 * call site.
 */

let billSeq = 0;
let repSeq = 0;

export async function seedBill(
  overrides: Partial<{
    billId: string;
    title: string;
    currentStatus: string;
    currentStatusDate: Date;
    introducedDate: Date;
    billType: string;
    link: string;
    congressNumber: number;
    momentumTier: string;
    momentumScore: number;
    sponsor: string;
    fullText: string;
    lastMetadataRefreshAt: Date;
    lastActionRefreshAt: Date;
    textFetchAttemptedAt: Date;
    latestActionText: string;
    latestActionDate: Date;
    currentChamber: string;
  }> = {},
) {
  billSeq += 1;
  const base = {
    billId: `hr-${billSeq}-119`,
    title: `Test Bill ${billSeq}`,
    date: new Date("2026-01-01"),
    billType: "hr",
    currentChamber: "house",
    currentStatus: "introduced",
    currentStatusDate: new Date("2026-01-01"),
    introducedDate: new Date("2026-01-01"),
    link: `https://www.govtrack.us/congress/bills/119/hr${billSeq}`,
    congressNumber: 119,
    ...overrides,
  };
  return getTestPrisma().bill.create({ data: base });
}

export async function seedRepresentative(
  overrides: Partial<{
    bioguideId: string;
    firstName: string;
    lastName: string;
    state: string;
    district: string;
    party: string;
    chamber: string;
    slug: string;
  }> = {},
) {
  repSeq += 1;
  const base = {
    bioguideId: overrides.bioguideId ?? `B${String(repSeq).padStart(6, "0")}`,
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? `Rep${repSeq}`,
    state: overrides.state ?? "CA",
    district: overrides.district ?? "1",
    party: overrides.party ?? "Democrat",
    chamber: overrides.chamber ?? "house",
    slug:
      overrides.slug ??
      `test-rep${repSeq}-${overrides.state?.toLowerCase() ?? "ca"}`,
  };
  return getTestPrisma().representative.create({ data: base });
}
