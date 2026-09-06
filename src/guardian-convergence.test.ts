import { describe, expect, it } from "vitest";
import { advanceGuardianFindingLineage } from "./guardian-convergence.js";
import {
  sanitizeReviewPhase,
  type PersistedGuardianReviewRound,
} from "./run-state.js";

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

  it("B-03 QA-05 keeps colliding fingerprints on distinct stable IDs so the round stays durable", () => {
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "The one prior finding",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "OPEN",
        },
      ]),
    ];
    // Two current findings, distinct IDs, identical normalized fingerprint:
    // only one may claim the single prior stable identity.
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-07",
        title: "First fingerprint twin",
        class: "INTEGRITY",
        clearCondition: "Commit the durable evidence",
        disposition: "REPEATED",
      },
      {
        id: "A-08",
        title: "Second fingerprint twin",
        class: " integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "OPEN",
      },
    ]);

    expect(advanced.map((finding) => finding.stableId)).toEqual([
      "A-01",
      "A-08",
    ]);
    expect(new Set(advanced.map((finding) => finding.stableId)).size).toBe(2);

    const phase = {
      rounds: [
        ...prior,
        {
          ...roundWithArchitectFindings(advanced),
          round: 2,
          architect: {
            source: "INVOKED" as const,
            outcome: "FIX-BEFORE-SHIP" as const,
            findings: advanced,
            findingsOriginRound: 2,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 2,
          },
        },
      ],
    };
    expect(sanitizeReviewPhase(phase)?.rounds).toHaveLength(2);
  });

  it("B-03 QA-05 lets an ID match claim the identity a fingerprint twin also wants", () => {
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-05",
          title: "The one prior finding",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "OPEN",
        },
      ]),
    ];
    // The fingerprint twin comes first in the round, but the ID match wins:
    // ID-first precedence must not depend on the order findings arrive in.
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-09",
        title: "Fingerprint twin, listed first",
        class: "INTEGRITY",
        clearCondition: "Commit the durable evidence",
        disposition: "OPEN",
      },
      {
        id: "A-05",
        title: "ID match, listed second",
        class: "PRODUCT",
        clearCondition: "Something else entirely",
        disposition: "REPEATED",
      },
    ]);

    expect(advanced.map((finding) => finding.stableId)).toEqual([
      "A-09",
      "A-01",
    ]);
  });

  it("B-03 QA-07 folds two known aliases of one prior identity into one entry", () => {
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-05",
          title: "The one prior finding",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "OPEN",
        },
      ]),
    ];
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-05",
        title: "Current-ID claimant",
        class: "PRODUCT",
        clearCondition: "Keep the current alias",
        disposition: "REPEATED",
      },
      {
        id: "A-01",
        title: "Stable-ID claimant",
        class: "INTEGRITY",
        clearCondition: "Keep the stable alias",
        disposition: "OPEN",
      },
    ]);

    // The stable-ID claimant keeps the identity; the current-ID claimant is
    // the same finding under its other alias, so it folds into that entry
    // rather than minting a forbidden new stable identity.
    expect(advanced).toEqual([
      {
        stableId: "A-01",
        currentId: "A-01",
        title: "Stable-ID claimant",
        class: "INTEGRITY",
        clearCondition: "Keep the stable alias",
        disposition: "OPEN",
      },
    ]);

    const phase = {
      rounds: [
        ...prior,
        {
          ...roundWithArchitectFindings(advanced),
          round: 2,
          architect: {
            source: "INVOKED" as const,
            outcome: "FIX-BEFORE-SHIP" as const,
            findings: advanced,
            findingsOriginRound: 2,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 2,
          },
        },
      ],
    };
    expect(sanitizeReviewPhase(phase)?.rounds).toHaveLength(2);
  });
});
