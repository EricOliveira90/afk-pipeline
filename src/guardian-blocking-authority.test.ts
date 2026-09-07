import { describe, expect, it } from "vitest";
import { guardianFindingMayBlock } from "./guardian-blocking-authority.js";

const architectFinding = {
  guardian: "architect" as const,
  round: 1,
  hasPriorLineage: false,
  class: "COUPLING",
  disposition: "OPEN" as const,
  reachableTrigger: "A retry reads the partially written ledger.",
  introducedByReviewedDiff: true,
};

const authorityMatrix = ([1, 2] as const).flatMap((round) =>
  [false, true].flatMap((hasPriorLineage) =>
    ([null, "A retry reads the partially written ledger."] as const).flatMap(
      (reachableTrigger) =>
        [false, true].flatMap((introducedByReviewedDiff) =>
          (["INTEGRITY", "DATA_LOSS", "SECURITY_GAP"] as const).flatMap(
            (findingClass) =>
              (["OPEN", "RESOLVED"] as const).map((disposition) => {
                const behavior =
                  round === 1
                    ? "B-01"
                    : hasPriorLineage
                      ? "B-03"
                      : "B-02";
                const hasReachableUnclearedFinding =
                  reachableTrigger !== null && disposition !== "RESOLVED";
                const expected =
                  hasReachableUnclearedFinding &&
                  (round === 1
                    ? introducedByReviewedDiff
                    : hasPriorLineage ||
                      (introducedByReviewedDiff &&
                        (findingClass === "INTEGRITY" ||
                          findingClass === "DATA_LOSS")));

                return {
                  name: [
                    behavior,
                    `round=${round}`,
                    `prior=${hasPriorLineage}`,
                    `reachable=${reachableTrigger !== null}`,
                    `attributed=${introducedByReviewedDiff}`,
                    `class=${findingClass}`,
                    `disposition=${disposition}`,
                  ].join(" "),
                  input: {
                    ...architectFinding,
                    round,
                    hasPriorLineage,
                    class: findingClass,
                    disposition,
                    reachableTrigger,
                    introducedByReviewedDiff,
                  },
                  expected,
                };
              }),
          ),
        ),
    ),
  ),
);

describe("guardianFindingMayBlock", () => {
  it.each(authorityMatrix)("$name", ({ input, expected }) => {
    expect(guardianFindingMayBlock(input)).toBe(expected);
  });

  it("B-01 rejects a blank reachable trigger", () => {
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        reachableTrigger: "   ",
      }),
    ).toBe(false);
  });

  it("P-01 keeps reachable structural classes eligible to block", () => {
    for (const findingClass of [
      "COUPLING",
      "BROKEN_ABSTRACTION",
      "SECURITY_GAP",
      "MISSING_ERROR_HANDLING",
    ]) {
      expect(
        guardianFindingMayBlock({
          ...architectFinding,
          class: findingClass,
        }),
      ).toBe(true);
    }
  });

  it("P-02 leaves PM v1 finding authority unchanged without new evidence", () => {
    expect(
      guardianFindingMayBlock({
        guardian: "pm",
        round: 4,
        hasPriorLineage: false,
        class: "PRODUCT",
        disposition: "OPEN",
        reachableTrigger: null,
        introducedByReviewedDiff: null,
      }),
    ).toBe(true);
  });
});
