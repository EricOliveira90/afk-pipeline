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
  // #247 narrowed ADR 0057 decision 1: an ID match resolves identity only while
  // the normalized class + clear-condition fingerprint agrees. The fixtures
  // below therefore keep a matching fingerprint on every claimant whose subject
  // is alias precedence or the one-to-one tiebreak, so those invariants stay
  // asserted; the ID-authority-despite-a-changed-fingerprint reading is the one
  // thing that is gone, and the test after them pins its replacement.
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
          title: "ID match, restated title, fingerprint intact",
          class: " old_class ",
          clearCondition: "  Old   clear condition ",
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
        title: "ID match, restated title, fingerprint intact",
        class: " old_class ",
        clearCondition: "  Old   clear condition ",
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
          class: "INTEGRITY",
          clearCondition: "Fix it",
          disposition: "REOPENED",
        },
      ])?.[0]?.stableId,
    ).toBe("A-01");
  });

  it("#247 mints a fresh identity for a round that reuses a spent ID", () => {
    // Recorded: PM `P-01` was filed at round 3 as issue 216 — "a production call
    // site grades a writing role through the role comparison source". The writer
    // fixed it, so round 4's guardian numbered its own first note from P-01
    // again on the new diff. The sole claimant won uncontested with no
    // fingerprint comparison (the tiebreak only ran for two or more claimants),
    // so it absorbed issue 216's identity and overwrote its title and clear
    // condition — and the filing pass then skipped the note as already filed.
    const prior = [
      roundWithArchitectFindings([
        {
          stableId: "P-01",
          currentId: "P-01",
          title: "D4's role comparison source ships as a seam with no consumer",
          class: "PRODUCT",
          clearCondition:
            "A production call site grades a writing role through the `role` comparison source.",
          disposition: "REPEATED",
        },
      ]),
    ];

    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "P-01",
        title: "Advisory test:budgets gate is implemented but undeclared",
        class: "PRODUCT",
        clearCondition:
          "This repo's afk.config.json declares gatePolicy.cost.environmentSensitive.",
        disposition: "OPEN",
      },
    ]);

    // A fresh identity, and not `P-01`: reusing the bare ID would hand the new
    // obligation the prior one's identity by another route.
    expect(advanced.map((finding) => [finding.stableId, finding.currentId])).toEqual([
      ["P-01-2", "P-01"],
    ]);
  });

  it("#247 rejoins its own lineage when a drifted fingerprint reverts", () => {
    // The guard costs nothing for a genuine repeat: the fingerprint fallback
    // searches every prior occurrence, so an identity whose wording drifted for
    // one round and came back keeps its stable ID rather than splitting.
    const prior: PersistedGuardianReviewRound[] = [
      { ...roundWithArchitectFindings([
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "The obligation, as first stated",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "OPEN",
        },
      ]) },
      {
        ...roundWithArchitectFindings([
          {
            stableId: "A-01-2",
            currentId: "A-01",
            title: "A different obligation that reused the ID",
            class: "PRODUCT",
            clearCondition: "Deliver the missing outcome",
            disposition: "OPEN",
          },
        ]),
        round: 2,
      },
    ];

    expect(
      advanceGuardianFindingLineage(prior, "architect", [
        {
          id: "A-01",
          title: "The first obligation, restated",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence",
          disposition: "REPEATED",
        },
      ]).map((finding) => finding.stableId),
    ).toEqual(["A-01"]);
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
        class: " Integrity ",
        clearCondition: "  Commit   the durable evidence ",
        disposition: "REPEATED",
      },
    ]);

    expect(advanced?.map((finding) => finding.stableId)).toEqual([
      "A-09",
      "A-01",
    ]);
  });

  it("B-03 QA-01 gives a contested identity to the stableId claimant when no single fingerprint matches", () => {
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
    // through its currentId, and both fingerprints match it, so no single
    // fingerprint singles out a winner. The identity goes to the claimant whose
    // ID equals the prior stableId; the other claimant gets a new stable
    // identity and keeps its guardian-provided ID as currentId (ADR 0057
    // decision 1 amendment).
    const advanced = advanceGuardianFindingLineage(prior, "architect", [
      {
        id: "A-05",
        title: "Current-ID claimant",
        class: "INTEGRITY",
        clearCondition: "Commit the durable evidence",
        disposition: "REPEATED",
        reachableTrigger: "A retry reaches the current alias.",
        introducedByReviewedDiff: true,
      },
      {
        id: "A-01",
        title: "Stable-ID claimant",
        class: " Integrity ",
        clearCondition: "  Commit   the durable evidence ",
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
        class: "INTEGRITY",
        clearCondition: "Commit the durable evidence",
        disposition: "REPEATED",
        reachableTrigger: "A retry reaches the current alias.",
        introducedByReviewedDiff: true,
      },
      {
        stableId: "A-01",
        currentId: "A-01",
        title: "Stable-ID claimant",
        class: " Integrity ",
        clearCondition: "  Commit   the durable evidence ",
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
