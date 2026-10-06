import type { CongressAction } from "./congress-api";

/**
 * Derive an accurate bill status from congress.gov actions.
 *
 * Since bill ingest moved from GovTrack to Congress.gov, `fetch-bills.ts`
 * hardcodes every new row to `introduced` and never advances it — so this is
 * the ONLY place a bill's `currentStatus` gets corrected toward reality. The
 * congress.gov action log is the source of truth; this function reads it and
 * returns a corrected status string, or `null` when the stored status already
 * looks right.
 *
 * It must therefore be able to reach every terminal state the rest of the app
 * understands (see momentum.ts `statusFloor` and bill-helpers.ts
 * `getStatusPosition` for the vocabulary):
 *   - enacted_signed — became law
 *   - prov_kill_veto — vetoed by the President
 *   - fail_originating_{house,senate} — voted down in the origin chamber
 *   - passed_simpleres / passed_concurrentres — resolutions adopted
 *   - pass_over_* / passed_bill — bicameral progress
 *
 * Extracted from src/scripts/fetch-bill-actions.ts so both the manual script
 * and the cron route share the same logic.
 */
export function reconcileStatus(
  govtrackStatus: string,
  billType: string,
  actions: CongressAction[],
): string | null {
  // Enacted bills are authoritative — once a row says enacted_*, congress.gov
  // can only confirm it, never walk it back.
  if (govtrackStatus.startsWith("enacted_")) return null;

  // Sort actions newest-first (congress.gov usually returns them this way,
  // but let's be safe).
  const sorted = [...actions].sort(
    (a, b) =>
      new Date(b.actionDate).getTime() - new Date(a.actionDate).getTime(),
  );

  const originIsHouse = billType.startsWith("house");
  const originChamber = originIsHouse ? "House" : "Senate";
  const otherChamber = originIsHouse ? "Senate" : "House";
  const isSimpleRes =
    billType === "house_resolution" || billType === "senate_resolution";
  const isConcurrentRes =
    billType === "house_concurrent_resolution" ||
    billType === "senate_concurrent_resolution";

  // Find key milestone actions.
  const passedOrigin = sorted.find((a) => passageChamber(a) === originChamber);
  const passedOther = sorted.find((a) => passageChamber(a) === otherChamber);
  const failedOrigin = sorted.find((a) => failureChamber(a) === originChamber);
  const becameLaw = sorted.find((a) =>
    /became (?:public|private) law|signed by president/i.test(a.text),
  );
  const vetoed = sorted.find(
    (a) =>
      a.type === "Veto" ||
      /\bvetoed by (?:the )?president\b|\bveto message received\b/i.test(
        a.text,
      ),
  );
  const sentBack = sorted.find(
    (a) =>
      /message on (house|senate) action received/i.test(a.text) &&
      /amendment/i.test(a.text),
  );
  const latestAction = sorted[0];

  // 1. Became law — the one terminal success. The old code returned null here
  //    ("GovTrack's enacted status is fine"), which was correct when GovTrack
  //    owned the status but is now a bug: nothing else ever writes enacted_*,
  //    so signed-into-law bills sat at introduced/passed_bill forever.
  if (becameLaw) return "enacted_signed";

  // 2. Vetoed (and not overridden into law above). Leave more-specific veto
  //    outcomes the old pipeline already recorded (pocket veto, failed
  //    override) untouched — we only know "a veto happened", not how it ended.
  if (
    vetoed &&
    !govtrackStatus.startsWith("vetoed_") &&
    govtrackStatus !== "prov_kill_veto"
  ) {
    return "prov_kill_veto";
  }

  // 3. Voted down in the origin chamber, with no subsequent passage there.
  //    The `!passedOrigin` guard means a measure that failed an early vote
  //    but later passed on reconsideration is treated as passed, not failed.
  if (failedOrigin && !passedOrigin) {
    return originIsHouse ? "fail_originating_house" : "fail_originating_senate";
  }

  // 4. Simple resolutions act only in their origin chamber, so adoption there
  //    is the terminal state — they never go to the other chamber or the
  //    President. Handle before the bicameral logic below so an adopted
  //    H.Res./S.Res. isn't mislabeled pass_over_*.
  if (isSimpleRes && passedOrigin) {
    return govtrackStatus === "passed_simpleres" ? null : "passed_simpleres";
  }

  // GovTrack says passed_bill but there's evidence the bill was sent back
  // with amendments and the receiving chamber is still deliberating.
  if (govtrackStatus === "passed_bill" && sentBack) {
    const sentBackDate = new Date(sentBack.actionDate).getTime();
    const secondPassDate = passedOther
      ? new Date(passedOther.actionDate).getTime()
      : 0;

    if (sentBackDate >= secondPassDate) {
      // Bill sent back after the other chamber passed it with amendments.
      // Determine which chamber sent it back.
      if (/house action/i.test(sentBack.text)) {
        return "pass_back_house";
      }
      if (/senate action/i.test(sentBack.text)) {
        return "pass_back_senate";
      }
    }
  }

  // GovTrack says passed_bill but latest actions show ongoing deliberation
  // in one chamber (cloture motions, motions to table, etc.).
  if (govtrackStatus === "passed_bill" && latestAction) {
    const latestDate = new Date(latestAction.actionDate).getTime();
    const govtrackPassDate = passedOther
      ? new Date(passedOther.actionDate).getTime()
      : 0;

    if (latestDate > govtrackPassDate && latestAction.chamber) {
      const isDeliberation =
        /considered|cloture|motion to table|motion to refer|motion to concur/i.test(
          latestAction.text,
        );
      if (isDeliberation) {
        if (latestAction.chamber === "House") return "pass_back_house";
        if (latestAction.chamber === "Senate") return "pass_back_senate";
      }
    }
  }

  // GovTrack says introduced or reported but congress.gov shows the bill
  // passed a chamber. This is the most common staleness case (Farm Bill).
  if (govtrackStatus === "introduced" || govtrackStatus === "reported") {
    if (passedOrigin && passedOther) {
      return isConcurrentRes ? "passed_concurrentres" : "passed_bill";
    }
    if (passedOrigin) {
      return originIsHouse ? "pass_over_house" : "pass_over_senate";
    }
  }

  // GovTrack says the bill cleared its origin chamber but congress.gov shows
  // the second chamber has also passed it. Lift to the both-chambers status.
  if (
    (govtrackStatus === "pass_over_house" ||
      govtrackStatus === "pass_over_senate") &&
    passedOrigin &&
    passedOther
  ) {
    return isConcurrentRes ? "passed_concurrentres" : "passed_bill";
  }

  return null; // Stored status looks fine.
}

/**
 * Which chamber actually PASSED/adopted the measure in this action, or null
 * if the action isn't a real passage.
 *
 * Congress.gov emits a computed summary row for the passage event itself,
 * prefixed "Passed/agreed to in House:" / "Passed/agreed to in Senate:". Its
 * `chamber` field is null (the row comes from the Library of Congress source
 * system, not a chamber clerk), so the chamber is read out of the text. We
 * also accept the chamber-clerk phrasings — "Passed Senate…", "On passage
 * Passed…", House suspension passage, and the resolution-adoption forms — and
 * fall back to the action's `chamber` field for those.
 *
 * Deliberately EXCLUDES the procedural "Agreed to" noise the old
 * `/passed|agreed/` test swept up: motions to proceed / table / recommit /
 * reconsider, ordering the previous question, committee-of-the-whole rise,
 * and amendment/title agreements — none of which mean the measure passed.
 * Matching those promoted mid-debate bills to pass_over_* with no demotion
 * path, which is the staleness this detector exists to prevent.
 */
function passageChamber(a: CongressAction): "House" | "Senate" | null {
  if (a.type !== "Floor") return null;
  const text = a.text;

  // Canonical computed passage marker — chamber is embedded in the text.
  const marker = /\bPassed\/agreed to in (House|Senate)\b/i.exec(text);
  if (marker) return normChamber(marker[1]);

  // Standalone chamber-clerk passage. Anchored to the start of the text: a
  // real passage row opens "Passed Senate…", whereas "Rule H. Res. 1300
  // passed House." is a mid-sentence cross-reference to a RULE resolution
  // clearing the floor, not the measure itself — anchoring excludes it.
  const passed = /^Passed (?:the )?(House|Senate)\b/i.exec(text);
  if (passed) return normChamber(passed[1]);

  // Self-executing adoption ("H. Res. 375 is considered passed House as
  // amended.") — the measure is deemed passed under the terms of a rule.
  const deemed = /\bconsidered passed (?:the )?(House|Senate)\b/i.exec(text);
  if (deemed) return normChamber(deemed[1]);

  // Senate-style resolution-adoption clerk row.
  const resAgreed = /^Resolution agreed to in (House|Senate)\b/i.exec(text);
  if (resAgreed) return normChamber(resAgreed[1]);

  // Roll-call passage, suspension passage, one-step ("read the third time,
  // and passed") passage, and resolution adoption that carry the chamber on
  // the action itself.
  if (
    a.chamber &&
    (/\bOn passage\b[\s\S]*\bPassed\b/i.test(text) ||
      /\bmotion to suspend the rules and (?:pass|agree)[\s\S]*\bAgreed to\b/i.test(
        text,
      ) ||
      /\bread the third time, and passed\b/i.test(text) ||
      /\bOn agreeing to the resolution\b[\s\S]*\bAgreed to\b/i.test(text) ||
      /\bSubmitted in the (?:House|Senate), considered, and agreed to\b/i.test(
        text,
      ))
  ) {
    return normChamber(a.chamber);
  }

  return null;
}

/**
 * Which chamber the measure FAILED in (a real defeat of the measure itself),
 * or null. Mirrors {@link passageChamber}: prefers the computed "Failed of
 * passage/not agreed to in House/Senate" marker (chamber in the text), then
 * the attributed roll-call forms — "On passage Failed", "On agreeing to the
 * resolution Failed", and a successful motion to table the measure.
 *
 * Excludes procedural defeats that DON'T kill the bill — most importantly
 * "On motion to recommit Failed" (a failed recommit clears the way for
 * passage) and motions to table amendments or appeals rather than the measure.
 */
function failureChamber(a: CongressAction): "House" | "Senate" | null {
  if (a.type !== "Floor") return null;
  const text = a.text;

  // A failed motion to suspend the rules is a PROVISIONAL kill
  // (prov_kill_suspensionfailed) — the measure fell short of the two-thirds
  // fast-track majority but can still be taken up under a normal rule.
  // Congress.gov tags it with the same "Failed of passage/not agreed to in …"
  // marker as a hard floor defeat, so exclude it here rather than mislabel a
  // recoverable bill fail_originating_*.
  if (/suspend the rules/i.test(text)) return null;

  const marker =
    /\bFailed of (?:passage|adoption)(?:\/not agreed to)? in (House|Senate)\b/i.exec(
      text,
    );
  if (marker) return normChamber(marker[1]);

  if (
    a.chamber &&
    (/\bOn passage\b[\s\S]*\bFailed\b/i.test(text) ||
      /\bOn agreeing to the resolution\b[\s\S]*\bFailed\b/i.test(text) ||
      /\bmotion to table the measure\b[\s\S]*\bAgreed to\b/i.test(text))
  ) {
    return normChamber(a.chamber);
  }

  return null;
}

function normChamber(token: string): "House" | "Senate" {
  return /house/i.test(token) ? "House" : "Senate";
}
