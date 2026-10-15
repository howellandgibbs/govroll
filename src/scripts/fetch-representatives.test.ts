import { describe, expect, it } from "vitest";
import { normalizeDistrict } from "./fetch-representatives";

describe("normalizeDistrict", () => {
  it('returns "At Large" for at-large single-district states (district 0)', () => {
    // The roster source returns 0 for the solo reps of SD, VT, WY, AK, DE, ND.
    // The old `role.district ? ... : null` check coerced this to null and
    // broke district-based lookups — that's how 6 reps ended up uninhabitable.
    expect(normalizeDistrict(0, "representative")).toBe("At Large");
  });

  it("preserves a regular numeric district", () => {
    expect(normalizeDistrict(14, "representative")).toBe("14");
    expect(normalizeDistrict("23", "representative")).toBe("23");
  });

  it("returns null for senators (they have no district)", () => {
    expect(normalizeDistrict(null, "senator")).toBeNull();
    expect(normalizeDistrict(0, "senator")).toBeNull();
  });

  it("returns null for representatives with a genuinely null district (territorial delegates)", () => {
    // DC, VI, AS, GU, MP, PR delegates correctly have no district number.
    expect(normalizeDistrict(null, "representative")).toBeNull();
  });

  it('treats an empty or "0" string like the numeric zero', () => {
    expect(normalizeDistrict("", "representative")).toBe("At Large");
    expect(normalizeDistrict("0", "representative")).toBe("At Large");
  });
});
