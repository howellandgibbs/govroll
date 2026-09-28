import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentCongress } from "@/lib/momentum";

const afterMock = vi.fn();
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/scripts/fetch-bill-text", () => ({
  fetchBillTextFunction: vi.fn(),
}));

const { isFromEndedCongress, maybeFetchBillTextInBackground } =
  await import("./on-demand-bill-text");

const current = getCurrentCongress();
const HOUR = 3_600_000;

beforeEach(() => {
  vi.clearAllMocks();
});

function bill(overrides: {
  congress: number;
  hasFullText?: boolean;
  attemptedMsAgo?: number | null;
}) {
  const { congress, hasFullText = false, attemptedMsAgo = null } = overrides;
  return {
    id: 1,
    billId: `house_bill-574-${congress}`,
    hasFullText,
    textFetchAttemptedAt:
      attemptedMsAgo === null ? null : new Date(Date.now() - attemptedMsAgo),
  };
}

describe("isFromEndedCongress", () => {
  it("is true only for a Congress before the current one", () => {
    expect(isFromEndedCongress(`senate_bill-1-${current - 1}`)).toBe(true);
    expect(isFromEndedCongress("house_bill-574-104")).toBe(true);
    expect(isFromEndedCongress(`house_bill-1-${current}`)).toBe(false);
    expect(isFromEndedCongress("not-a-bill-id")).toBe(false);
  });
});

describe("maybeFetchBillTextInBackground", () => {
  it("does nothing when the bill already has text", () => {
    maybeFetchBillTextInBackground(
      bill({ congress: current, hasFullText: true }),
    );
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("never re-fetches an ended Congress's bill from a page view", () => {
    // Attempted long ago — the old 1h cooldown would have allowed a retry.
    maybeFetchBillTextInBackground(
      bill({ congress: 104, attemptedMsAgo: 30 * 24 * HOUR }),
    );
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("allows one first attempt for a never-tried archive bill", () => {
    maybeFetchBillTextInBackground(bill({ congress: 104 }));
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the 1h cooldown for current-Congress bills", () => {
    maybeFetchBillTextInBackground(
      bill({ congress: current, attemptedMsAgo: 10 * 60_000 }),
    );
    expect(afterMock).not.toHaveBeenCalled();

    maybeFetchBillTextInBackground(
      bill({ congress: current, attemptedMsAgo: 2 * HOUR }),
    );
    expect(afterMock).toHaveBeenCalledTimes(1);
  });
});
