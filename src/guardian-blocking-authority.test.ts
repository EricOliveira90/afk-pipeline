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

describe("guardianFindingMayBlock", () => {
  it("B-01 requires a reachable trigger and reviewed-diff attribution in round 1", () => {
    expect(guardianFindingMayBlock(architectFinding)).toBe(true);
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        reachableTrigger: null,
      }),
    ).toBe(false);
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        reachableTrigger: "   ",
      }),
    ).toBe(false);
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        introducedByReviewedDiff: false,
      }),
    ).toBe(false);
  });

  it("B-02 allows only attributed later-new INTEGRITY and DATA_LOSS findings", () => {
    for (const findingClass of ["INTEGRITY", "DATA_LOSS"]) {
      expect(
        guardianFindingMayBlock({
          ...architectFinding,
          round: 2,
          class: findingClass,
        }),
      ).toBe(true);
    }
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 2,
        class: "SECURITY_GAP",
      }),
    ).toBe(false);
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 2,
        class: "INTEGRITY",
        introducedByReviewedDiff: false,
      }),
    ).toBe(false);
  });

  it("B-03 lets reachable uncleared prior lineage continue blocking", () => {
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 3,
        hasPriorLineage: true,
        class: "PRODUCT",
        introducedByReviewedDiff: false,
      }),
    ).toBe(true);
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 3,
        hasPriorLineage: true,
        disposition: "RESOLVED",
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
