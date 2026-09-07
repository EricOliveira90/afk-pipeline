import { describe, expect, it } from "vitest";
import {
  buildGuardianRoundScope,
  foldGuardianFindings,
  openGuardianFindings,
  resolvedGuardianFindings,
} from "./guardian-round-scope.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRecord,
  PersistedGuardianReviewRound,
} from "./run-state.js";

function finding(
  overrides: Partial<PersistedGuardianFinding> & { stableId: string },
): PersistedGuardianFinding {
  return {
    currentId: overrides.stableId,
    title: `${overrides.stableId} title`,
    class: "INTEGRITY",
    clearCondition: `Clear ${overrides.stableId}.`,
    disposition: "OPEN",
    reachableTrigger: "A normal retry reads the invalid durable state.",
    introducedByReviewedDiff: true,
    ...overrides,
  };
}

function record(
  overrides: Partial<PersistedGuardianReviewRecord> = {},
): PersistedGuardianReviewRecord {
  return {
    source: "INVOKED",
    outcome: "FIX-BEFORE-SHIP",
    findings: [],
    findingsOriginRound: 1,
    ...overrides,
  };
}

function round(
  number: number,
  overrides: Partial<PersistedGuardianReviewRound> = {},
): PersistedGuardianReviewRound {
  return {
    round: number,
    reviewedHeadSha: `reviewed-${number}`,
    headSha: `head-${number}`,
    architect: record({ findingsOriginRound: number }),
    pm: record({ outcome: "SHIP", findingsOriginRound: number }),
    ...overrides,
  };
}

describe("foldGuardianFindings", () => {
  it("keeps the latest entry per stable identity across rounds", () => {
    const rounds = [
      round(1, {
        architect: record({
          findingsOriginRound: 1,
          findings: [
            finding({ stableId: "A-01" }),
            finding({ stableId: "A-02" }),
          ],
        }),
      }),
      round(2, {
        architect: record({
          findingsOriginRound: 2,
          findings: [
            finding({
              stableId: "A-01",
              disposition: "RESOLVED",
              title: "A-01 as round 2 saw it",
            }),
          ],
        }),
      }),
    ];

    const folded = foldGuardianFindings(rounds, "architect");

    expect(folded).toHaveLength(2);
    expect(folded.find((e) => e.finding.stableId === "A-01")).toEqual({
      round: 2,
      finding: expect.objectContaining({
        disposition: "RESOLVED",
        title: "A-01 as round 2 saw it",
      }),
    });
    // Omitted by round 2, so its round-1 entry stands: an obligation nobody
    // dispositioned is not lost.
    expect(folded.find((e) => e.finding.stableId === "A-02")).toEqual({
      round: 1,
      finding: expect.objectContaining({ disposition: "OPEN" }),
    });
  });

  it("ignores cache-sourced records, which re-copy an earlier round verbatim", () => {
    const carried = finding({ stableId: "A-01", disposition: "OPEN" });
    const rounds = [
      round(1, {
        architect: record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [carried],
        }),
      }),
      round(2, {
        architect: record({
          source: "CACHE",
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [carried],
        }),
      }),
    ];

    expect(foldGuardianFindings(rounds, "architect")).toEqual([
      { round: 1, finding: carried },
    ]);
  });

  it("folds each guardian's ledger independently", () => {
    const rounds = [
      round(1, {
        architect: record({
          findingsOriginRound: 1,
          findings: [finding({ stableId: "A-01" })],
        }),
        pm: record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [finding({ stableId: "P-01", class: "PRODUCT" })],
        }),
      }),
    ];

    expect(
      foldGuardianFindings(rounds, "architect").map((e) => e.finding.stableId),
    ).toEqual(["A-01"]);
    expect(
      foldGuardianFindings(rounds, "pm").map((e) => e.finding.stableId),
    ).toEqual(["P-01"]);
  });
});

describe("openGuardianFindings / resolvedGuardianFindings", () => {
  it("routes every non-RESOLVED disposition to the open block", () => {
    const folded = (
      ["OPEN", "REPEATED", "REOPENED", "REGRESSED", "RESOLVED"] as const
    ).map((disposition, index) => ({
      round: 1,
      finding: finding({ stableId: `A-0${index + 1}`, disposition }),
    }));

    expect(
      openGuardianFindings(folded).map((e) => e.finding.disposition),
    ).toEqual(["OPEN", "REPEATED", "REOPENED", "REGRESSED"]);
    expect(
      resolvedGuardianFindings(folded).map((e) => e.finding.stableId),
    ).toEqual(["A-05"]);
  });
});

describe("buildGuardianRoundScope", () => {
  it("scopes round 1 to the whole branch with no findings to verify", () => {
    const scope = buildGuardianRoundScope({
      rounds: [],
      guardian: "architect",
      defaultBranch: "main",
    });

    expect(scope.round).toBe(1);
    expect(scope.deltaBaseSha).toBeNull();
    expect(scope.roundScope).toContain("review round 1");
    expect(scope.roundScope).toContain("git diff main...HEAD");
    expect(scope.openFindings).toContain("(none");
    expect(scope.resolvedHistory).toContain("(none");
  });

  it("scopes round 2 to the prior round's headSha and lists open findings by stable ID", () => {
    const scope = buildGuardianRoundScope({
      rounds: [
        round(1, {
          headSha: "aaaaaaaaaaaabbbbbbbbbbbb",
          architect: record({
            findingsOriginRound: 1,
            findings: [
              finding({
                stableId: "A-01",
                currentId: "A-07",
                title: "Durable record is written incomplete",
                clearCondition: "The round persists before the early return.",
              }),
            ],
          }),
        }),
      ],
      guardian: "architect",
      defaultBranch: "main",
    });

    expect(scope.round).toBe(2);
    expect(scope.deltaBaseSha).toBe("aaaaaaaaaaaabbbbbbbbbbbb");
    expect(scope.roundScope).toContain("review round 2, a verification round");
    expect(scope.roundScope).toContain(
      "git diff aaaaaaaaaaaabbbbbbbbbbbb..HEAD",
    );
    expect(scope.roundScope).not.toContain("main...HEAD");
    // Issue #171 added scope: show the stable ID and ask for its reuse.
    expect(scope.roundScope).toContain("Reuse the stable IDs");
    expect(scope.openFindings).toContain("[A-01]");
    expect(scope.openFindings).toContain("numbered A-07 in that round");
    expect(scope.openFindings).toContain(
      "The round persists before the early return.",
    );
    expect(scope.resolvedHistory).toContain("(none");
  });

  it("splits dispositions between the verify block and the do-not-re-raise block", () => {
    const scope = buildGuardianRoundScope({
      rounds: [
        round(1, {
          architect: record({
            findingsOriginRound: 1,
            findings: [
              finding({ stableId: "A-01", disposition: "RESOLVED" }),
              finding({ stableId: "A-02", disposition: "REPEATED" }),
            ],
          }),
        }),
      ],
      guardian: "architect",
      defaultBranch: "main",
    });

    expect(scope.openFindings).toContain("[A-02]");
    expect(scope.openFindings).not.toContain("[A-01]");
    expect(scope.resolvedHistory).toContain("[A-01]");
    expect(scope.resolvedHistory).toContain("Do not");
    expect(scope.resolvedHistory).not.toContain("[A-02]");
  });

  it("keeps a guardian that has never completed a review on the round-1 scope", () => {
    // Round 1's architect died mid-run: it left a ledger round but never read
    // the branch, so round 2 must not be handed a delta against it.
    const scope = buildGuardianRoundScope({
      rounds: [
        round(1, {
          architect: record({
            outcome: "DIED_MID_RUN",
            source: "INVOKED",
            findingsOriginRound: 1,
          }),
        }),
      ],
      guardian: "architect",
      defaultBranch: "main",
    });

    expect(scope.round).toBe(2);
    expect(scope.deltaBaseSha).toBeNull();
    expect(scope.roundScope).toContain("git diff main...HEAD");
  });

  it("scopes to the prior round's headSha even when that round added no findings", () => {
    const scope = buildGuardianRoundScope({
      rounds: [
        round(1, {
          headSha: "round-one-head",
          architect: record({
            outcome: "SHIP",
            findingsOriginRound: 1,
            findings: [],
          }),
        }),
      ],
      guardian: "architect",
      defaultBranch: "main",
    });

    expect(scope.deltaBaseSha).toBe("round-one-head");
    expect(scope.openFindings).toContain("(none");
  });
});
