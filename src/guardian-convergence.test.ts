import { describe, expect, it } from "vitest";
import { advanceGuardianFindingLineage } from "./guardian-convergence.js";
import {
  sanitizeReviewPhase,
  type PersistedGuardianFinding,
  type PersistedGuardianReviewRound,
} from "./run-state.js";

function roundWithArchitectFindings(
  findings: Array<
    Omit<
      PersistedGuardianFinding,
      "reachableTrigger" | "introducedByReviewedDiff"
    > &
      Partial<
        Pick<
          PersistedGuardianFinding,
          "reachableTrigger" | "introducedByReviewedDiff"
        >
      >
  >,
): PersistedGuardianReviewRound {
  return {
    round: 1,
    reviewedHeadSha: "before",
    headSha: "after",
    architect: {
      source: "INVOKED",
      outcome: "FIX-BEFORE-SHIP",
      findings: findings.map((finding) => ({
        ...finding,
        reachableTrigger:
          finding.reachableTrigger ??
          "A normal pipeline retry reaches the faulty state.",
        introducedByReviewedDiff:
          finding.introducedByReviewedDiff ?? true,
      })),
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
  it("P-03 preserves identity while authority evidence follows the current finding", () => {
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
          reachableTrigger: "A retry reaches the renamed control flow.",
          introducedByReviewedDiff: false,
        },
        {
          id: "A-12",
          title: "Renamed fingerprint match",
          class: " integrity ",
          clearCondition: "  Commit   the durable evidence ",
          disposition: "RESOLVED",
          reachableTrigger: null,
          introducedByReviewedDiff: true,
        },
        {
          id: "A-20",
          title: "New finding",
          class: "PRODUCT",
          clearCondition: "Deliver the missing outcome",
          disposition: "OPEN",
          reachableTrigger: "A fresh run omits the required outcome.",
          introducedByReviewedDiff: true,
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
        reachableTrigger: "A retry reaches the renamed control flow.",
        introducedByReviewedDiff: false,
      },
      {
        stableId: "A-10",
        currentId: "A-12",
        title: "Renamed fingerprint match",
        class: " integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "RESOLVED",
        reachableTrigger: null,
        introducedByReviewedDiff: true,
      },
      {
        stableId: "A-20",
        currentId: "A-20",
        title: "New finding",
        class: "PRODUCT",
        clearCondition: "Deliver the missing outcome",
        disposition: "OPEN",
        reachableTrigger: "A fresh run omits the required outcome.",
        introducedByReviewedDiff: true,
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
      ])?.[0]?.stableId,
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
        reachableTrigger: "A retry reaches the first fingerprint twin.",
        introducedByReviewedDiff: false,
      },
      {
        id: "A-08",
        title: "Second fingerprint twin",
        class: " integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "OPEN",
        reachableTrigger: "A retry reaches the second fingerprint twin.",
        introducedByReviewedDiff: true,
      },
    ]);

    expect(advanced).toBeDefined();
    const entries = advanced!;
    expect(entries.map((finding) => finding.stableId)).toEqual([
      "A-01",
      "A-08",
    ]);
    expect(new Set(entries.map((finding) => finding.stableId)).size).toBe(2);

    const phase = {
      rounds: [
        ...prior,
        {
          ...roundWithArchitectFindings(entries),
          round: 2,
          architect: {
            source: "INVOKED" as const,
            outcome: "FIX-BEFORE-SHIP" as const,
            findings: entries,
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

    expect(advanced?.map((finding) => finding.stableId)).toEqual([
      "A-09",
      "A-01",
    ]);
  });

  it("B-03 QA-01 gives a contested identity to the stableId claimant when no fingerprint matches", () => {
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
    // Both IDs name the same prior identity, one through its stableId and one
    // through its currentId, and neither fingerprint matches the prior entry.
    // The identity goes to the claimant whose ID equals the prior stableId;
    // the other claimant gets a new stable identity and keeps its
    // guardian-provided ID as currentId (ADR 0057 decision 1 amendment).
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-05",
        title: "Current-ID claimant",
        class: "PRODUCT",
        clearCondition: "Keep the current alias",
        disposition: "REPEATED",
        reachableTrigger: "A retry reaches the current alias.",
        introducedByReviewedDiff: true,
      },
      {
        id: "A-01",
        title: "Stable-ID claimant",
        class: "INTEGRITY",
        clearCondition: "Keep the stable alias",
        disposition: "OPEN",
        reachableTrigger: "A retry reaches the stable alias.",
        introducedByReviewedDiff: false,
      },
    ]);
    expect(advanced).toEqual([
      {
        stableId: "A-05",
        currentId: "A-05",
        title: "Current-ID claimant",
        class: "PRODUCT",
        clearCondition: "Keep the current alias",
        disposition: "REPEATED",
        reachableTrigger: "A retry reaches the current alias.",
        introducedByReviewedDiff: true,
      },
      {
        stableId: "A-01",
        currentId: "A-01",
        title: "Stable-ID claimant",
        class: "INTEGRITY",
        clearCondition: "Keep the stable alias",
        disposition: "OPEN",
        reachableTrigger: "A retry reaches the stable alias.",
        introducedByReviewedDiff: false,
      },
    ]);

    const phase = {
      rounds: [
        ...prior,
        {
          round: 2,
          reviewedHeadSha: "after",
          headSha: "after-2",
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

  it("B-03 QA-01 gives a contested identity to the fingerprint-matching claimant", () => {
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
    // The currentId claimant's normalized class + clear-condition fingerprint
    // matches the prior entry, so it takes the stable identity even though the
    // other claimant's ID equals the prior stableId. The losing stableId
    // claimant cannot reuse its own ID as the new stable identity — that ID is
    // the claimed one — so it gets a deterministic fresh identity while its
    // guardian-provided ID stays visible as currentId.
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-01",
        title: "Stable-ID claimant, fingerprint changed",
        class: "PRODUCT",
        clearCondition: "Something else entirely",
        disposition: "OPEN",
      },
      {
        id: "A-05",
        title: "Current-ID claimant, fingerprint intact",
        class: " Integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "REPEATED",
      },
    ]);
    expect(
      advanced.map((finding) => [finding.stableId, finding.currentId]),
    ).toEqual([
      ["A-01-2", "A-01"],
      ["A-01", "A-05"],
    ]);
    expect(new Set(advanced.map((finding) => finding.stableId)).size).toBe(2);
  });
});
