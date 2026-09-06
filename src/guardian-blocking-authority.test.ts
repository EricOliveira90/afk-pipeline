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
  it.each([
    {
      name: "reachable and attributed",
      finding: {},
      expected: true,
    },
    {
      name: "null trigger",
      finding: { reachableTrigger: null },
      expected: false,
    },
    {
      name: "blank trigger",
      finding: { reachableTrigger: "   " },
      expected: false,
    },
    {
      name: "not attributed",
      finding: { introducedByReviewedDiff: false },
      expected: false,
    },
    {
      name: "resolved",
      finding: { disposition: "RESOLVED" as const },
      expected: false,
    },
  ])("B-01 round-1 authority: $name", ({ finding, expected }) => {
    expect(
      guardianFindingMayBlock({ ...architectFinding, ...finding }),
    ).toBe(expected);
  });

  it.each([
    {
      name: "attributed INTEGRITY",
      finding: { class: "INTEGRITY" },
      expected: true,
    },
    {
      name: "attributed DATA_LOSS",
      finding: { class: "DATA_LOSS" },
      expected: true,
    },
    {
      name: "other class",
      finding: { class: "SECURITY_GAP" },
      expected: false,
    },
    {
      name: "null trigger",
      finding: { class: "INTEGRITY", reachableTrigger: null },
      expected: false,
    },
    {
      name: "blank trigger",
      finding: { class: "DATA_LOSS", reachableTrigger: " " },
      expected: false,
    },
    {
      name: "not attributed",
      finding: {
        class: "INTEGRITY",
        introducedByReviewedDiff: false,
      },
      expected: false,
    },
    {
      name: "resolved",
      finding: {
        class: "DATA_LOSS",
        disposition: "RESOLVED" as const,
      },
      expected: false,
    },
  ])("B-02 later-new authority: $name", ({ finding, expected }) => {
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 2,
        hasPriorLineage: false,
        ...finding,
      }),
    ).toBe(expected);
  });

  it.each([
    {
      name: "reachable uncleared finding",
      finding: {},
      expected: true,
    },
    {
      name: "unattributed non-exception class",
      finding: {
        class: "PRODUCT",
        introducedByReviewedDiff: false,
      },
      expected: true,
    },
    {
      name: "null trigger",
      finding: { reachableTrigger: null },
      expected: false,
    },
    {
      name: "blank trigger",
      finding: { reachableTrigger: " " },
      expected: false,
    },
    {
      name: "resolved",
      finding: { disposition: "RESOLVED" as const },
      expected: false,
    },
  ])("B-03 prior-lineage authority: $name", ({ finding, expected }) => {
    expect(
      guardianFindingMayBlock({
        ...architectFinding,
        round: 3,
        hasPriorLineage: true,
        ...finding,
      }),
    ).toBe(expected);
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
