// @vitest-environment jsdom
/**
 * Component-level tests for `<ReaderHeaderMeta>`. The header is the
 * reader's orientation layer, so regressions here are user-visible
 * even for people who never open the outline — the pill label
 * misrepresenting a bill's status is the class of bug that eroded
 * trust in the pre-fix version.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The version picker uses Next.js navigation hooks that throw outside
// a Next request context. Provide minimal mocks — switching versions
// isn't the focus of these tests, the header's structure is.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/bills/118/s/3706-victims-voices-act/read",
}));

import {
  ReaderHeaderMeta,
  congressOrdinal,
  displayNumberFor,
} from "./reader-header-meta";
import type {
  ReaderBillMeta,
  ReaderVersionMeta,
  ReaderVersionListEntry,
} from "./reader-types";

afterEach(() => {
  cleanup();
});

function makeBill(overrides: Partial<ReaderBillMeta> = {}): ReaderBillMeta {
  return {
    id: 1,
    billId: "senate_bill-3706-118",
    title: "Victims' VOICES Act",
    headline: "Victims' VOICES Act",
    billType: "senate_bill",
    currentStatus: "enacted_signed",
    sponsor: "Sen. Cornyn, John [R-TX]",
    displayNumber: "S. 3706",
    congressLabel: "118th",
    detailHref: "/bills/118/s/3706-victims-voices-act",
    ...overrides,
  };
}

function makeVersion(
  overrides: Partial<ReaderVersionMeta> = {},
): ReaderVersionMeta {
  return {
    id: 10,
    versionCode: "enr",
    versionType: "Enrolled Bill",
    versionDate: new Date("2024-07-30T00:00:00Z"),
    isSubstantive: true,
    ...overrides,
  };
}

describe("displayNumberFor", () => {
  it("renders Senate bill with S. prefix", () => {
    expect(displayNumberFor("senate_bill", 3706)).toBe("S. 3706");
  });
  it("renders House bill with H.R. prefix", () => {
    expect(displayNumberFor("house_bill", 1234)).toBe("H.R. 1234");
  });
  it("falls back on unknown types rather than crashing", () => {
    expect(displayNumberFor("unknown_type", 9)).toMatch(/9/);
  });
});

describe("congressOrdinal", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"], // teens stay -th even though 1 → 1st
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [101, "101st"],
    [111, "111th"],
    [118, "118th"],
    [119, "119th"],
  ])("formats %i as %s", (n, expected) => {
    expect(congressOrdinal(n)).toBe(expected);
  });
});

describe("<ReaderHeaderMeta> — visible meta for an enacted bill", () => {
  it("renders the bill number, title, status pill, and sponsor", () => {
    render(
      <ReaderHeaderMeta
        bill={makeBill()}
        version={makeVersion()}
        availableVersions={[]}
        sectionCount={2}
        readingMinutes={1}
        expandCollapseSlot={null}
      />,
    );

    expect(screen.getByText("S. 3706")).toBeInTheDocument();
    expect(screen.getByText("118th Congress")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Victims' VOICES Act" }),
    ).toBeInTheDocument();
    // Enacted headline, not the version label — this was the pre-fix
    // "ENROLLED BILL" regression for a bill that's actually Public Law.
    expect(screen.getByText("Signed into law")).toBeInTheDocument();
    // Sponsor block shows the human-readable identity.
    expect(screen.getByText(/Sen\. John Cornyn/)).toBeInTheDocument();
    expect(screen.getByText(/R-TX/)).toBeInTheDocument();
    // Section count + reading time rendered.
    expect(screen.getByText(/2 sections · 1 min read/)).toBeInTheDocument();
  });

  it("labels the version line with version type + date (no 'Reading the enrolled bill …' phrasing)", () => {
    render(
      <ReaderHeaderMeta
        bill={makeBill()}
        version={makeVersion()}
        availableVersions={[]}
        sectionCount={2}
        readingMinutes={1}
        expandCollapseSlot={null}
      />,
    );
    // The date label is present…
    expect(screen.getByText(/Jul 30, 2024/)).toBeInTheDocument();
    // …and the old ambiguous solo-badge-plus-date pattern is gone: we
    // never render an unlabeled date that could be read as the bill's
    // own date.
    expect(screen.queryByText(/^Apr \d+, 20/)).not.toBeInTheDocument();
  });

  it("uses an in-progress pill tone for an introduced bill", () => {
    render(
      <ReaderHeaderMeta
        bill={makeBill({
          currentStatus: "introduced",
          billType: "house_bill",
          displayNumber: "H.R. 1234",
        })}
        version={makeVersion({ versionType: "Introduced in House" })}
        availableVersions={[]}
        sectionCount={5}
        readingMinutes={3}
        expandCollapseSlot={null}
      />,
    );
    // "Introduced in the House" is the canonical headline for a
    // just-introduced House bill — the pill must reflect that, not
    // whatever the version metadata happens to say.
    expect(screen.getByText(/Introduced in the House/)).toBeInTheDocument();
  });

  it("renders the version picker when multiple substantive versions exist", () => {
    const versions: ReaderVersionListEntry[] = [
      {
        versionCode: "is",
        versionType: "Introduced in Senate",
        versionDate: new Date("2024-01-31T00:00:00Z"),
      },
      {
        versionCode: "es",
        versionType: "Engrossed in Senate",
        versionDate: new Date("2024-06-14T00:00:00Z"),
      },
      {
        versionCode: "enr",
        versionType: "Enrolled Bill",
        versionDate: new Date("2024-07-30T00:00:00Z"),
      },
    ];
    render(
      <ReaderHeaderMeta
        bill={makeBill()}
        version={makeVersion()}
        availableVersions={versions}
        sectionCount={2}
        readingMinutes={1}
        expandCollapseSlot={null}
      />,
    );
    const picker = screen.getByLabelText(
      "Bill text version",
    ) as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    expect(picker.value).toBe("enr");
    expect(picker.options).toHaveLength(3);
  });

  it("degrades to a static version label when only one version exists", () => {
    render(
      <ReaderHeaderMeta
        bill={makeBill()}
        version={makeVersion()}
        availableVersions={[
          {
            versionCode: "enr",
            versionType: "Enrolled Bill",
            versionDate: new Date("2024-07-30T00:00:00Z"),
          },
        ]}
        sectionCount={2}
        readingMinutes={1}
        expandCollapseSlot={null}
      />,
    );
    expect(
      screen.queryByLabelText("Bill text version"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Version:/)).toBeInTheDocument();
  });
});
