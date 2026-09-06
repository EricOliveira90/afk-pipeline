import { describe, expect, it } from "vitest";
import { advanceGuardianFindingLineage } from "./guardian-convergence.js";
import type { PersistedGuardianReviewRound } from "./run-state.js";

function roundWithArchitectFindings(
  findings: PersistedGuardianReviewRound["architect"]["findings"],
): PersistedGuardianReviewRound {
  return {
    round: 1,
    reviewedHeadSha: "before",
    headSha: "after",
    architect: {
      source: "INVOKED",
      outcome: "FIX-BEFORE-SHIP",
      findings,
      findingsOriginRound: 1,
    },
    pm: {
      source: "INVOKED",
      outcome: "SHIP",
      findings: [],
      findingsOriginRound: 1,
    },
  };
}

describe("advanceGuardianFindingLineage", () => {
  it("B-03 gives ID matches precedence, then fingerprint matches, then new identities", () => {
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-02",
          title: "Prior ID finding",
          class: "OLD_CLASS",
          clearCondition: "Old clear condition",
          disposition: "OPEN",
        },
        {
          stableId: "A-10",
          currentId: "A-11",
          title: "Fingerprint finding",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "OPEN",
        },
      ]),
    ];

    expect(
      advanceGuardianFindingLineage(prior, "architect", [
        {
          id: "A-02",
          title: "ID match with changed content",
          class: "NEW_CLASS",
          clearCondition: "A different condition",
          disposition: "REPEATED",
        },
        {
          id: "A-12",
          title: "Renamed fingerprint match",
          class: " integrity ",
          clearCondition: "  Commit   the durable evidence ",
          disposition: "RESOLVED",
        },
        {
          id: "A-20",
          title: "New finding",
          class: "PRODUCT",
          clearCondition: "Deliver the missing outcome",
          disposition: "OPEN",
        },
      ]),
    ).toEqual([
      {
        stableId: "A-01",
        currentId: "A-02",
        title: "ID match with changed content",
        class: "NEW_CLASS",
        clearCondition: "A different condition",
        disposition: "REPEATED",
      },
      {
        stableId: "A-10",
        currentId: "A-12",
        title: "Renamed fingerprint match",
        class: " integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "RESOLVED",
      },
      {
        stableId: "A-20",
        currentId: "A-20",
        title: "New finding",
        class: "PRODUCT",
        clearCondition: "Deliver the missing outcome",
        disposition: "OPEN",
      },
    ]);
  });

  it("retains a stable identity when a later current ID names the stable ID", () => {
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-09",
          title: "Renamed",
          class: "INTEGRITY",
          clearCondition: "Fix it",
          disposition: "OPEN",
        },
      ]),
    ];
    expect(
      advanceGuardianFindingLineage(prior, "architect", [
        {
          id: "A-01",
          title: "Back to stable ID",
          class: "OTHER",
          clearCondition: "Changed",
          disposition: "REOPENED",
        },
      ])[0]?.stableId,
    ).toBe("A-01");
  });
});
