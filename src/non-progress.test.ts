import { describe, expect, it } from "vitest";
import {
  buildRecoveryIntervention,
  contractNonProgressObservation,
  buildSemanticCapIntervention,
  decideNonProgress,
  emptyNonProgressHistory,
  parseNonProgressHistory,
  type NonProgressObservation,
} from "./non-progress.js";
import {
  advanceContractFindingLineage,
  emptyContractFindingLineage,
} from "./contract-convergence.js";
import type { ContractReviewFinding } from "./contract-review.js";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const TREE_C = "c".repeat(40);

function observation(
  revision: number,
  activeBlockingIds: string[],
  overrides: Partial<NonProgressObservation> = {},
): NonProgressObservation {
  const treeId = [TREE_A, TREE_B, TREE_C][revision - 1] ?? TREE_C;
  return {
    cause: {
      kind: "QA_CONVERGENCE",
      interventionClass: "IMPLEMENTATION_INTERVENTION",
    },
    phase: "deterministic-qa",
    revision,
    candidate: {
      branch: "afk/demo-slice-01",
      treeId,
      phase: "deterministic-qa",
      revision,
    },
    activeBlockingIds,
    repeatedBlockingIds: [],
    reopenedWithoutNewEvidenceIds: [],
    regressedBlockingIds: [],
    findings: activeBlockingIds.map((id) => ({
      stableId: id,
      currentId: id,
      state: "OPEN",
      disposition: "OPEN",
      occurrences: 1,
      summary: `${id} summary`,
      evidence: `${id} evidence`,
      clearCondition: `${id} clear`,
      artifactReferences: [`reviews/${id}.json`],
    })),
    supportingEvidence: ["gate.json"],
    ...overrides,
  };
}

describe("non-progress policy", () => {
  it("continues genuine progress but stops equivalent repetition before dispatch", () => {
    const first = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, ["QA-01"]),
    );
    expect(first.action).toBe("continue");
    const repeated = decideNonProgress(
      first.history,
      observation(2, ["QA-01"], {
        repeatedBlockingIds: ["QA-01"],
      }),
    );
    expect(repeated.action).toBe("intervene");
    if (repeated.action !== "intervene") return;
    expect(repeated.request.reasonCodes).toContain("EQUIVALENT_REPETITION");
    expect(repeated.request.attemptedRepairs).toHaveLength(2);
    expect(repeated.request.attemptedRepairs[0]).toMatchObject({
      revision: 1,
      findingLineage: [
        expect.objectContaining({
          stableId: "QA-01",
          state: "OPEN",
          disposition: "OPEN",
          evidence: "QA-01 evidence",
        }),
      ],
      supportingEvidence: ["gate.json", "reviews/QA-01.json"],
    });
  });

  it("classifies reopened findings, A-B-A oscillation, and regression growth", () => {
    const resolved = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, ["QA-01"], {
        activeBlockingIds: [],
        findings: [
          {
            ...observation(1, ["QA-01"]).findings[0]!,
            state: "RESOLVED",
            disposition: "RESOLVED",
          },
        ],
        supportingEvidence: ["revision-1-gate.json"],
      }),
    );
    const reopened = decideNonProgress(
      resolved.history,
      observation(2, ["QA-01"], {
        reopenedWithoutNewEvidenceIds: ["QA-01"],
        supportingEvidence: ["revision-2-gate.json"],
      }),
    );
    expect(reopened).toMatchObject({
      action: "intervene",
      request: {
        reasonCodes: ["REOPENED_WITHOUT_NEW_EVIDENCE"],
        attemptedRepairs: [
          {
            revision: 1,
            findingLineage: [
              expect.objectContaining({
                stableId: "QA-01",
                state: "RESOLVED",
                disposition: "RESOLVED",
                evidence: "QA-01 evidence",
              }),
            ],
            supportingEvidence: [
              "reviews/QA-01.json",
              "revision-1-gate.json",
            ],
          },
          {
            revision: 2,
            findingLineage: [
              expect.objectContaining({
                stableId: "QA-01",
                state: "OPEN",
                disposition: "OPEN",
                evidence: "QA-01 evidence",
              }),
            ],
            supportingEvidence: [
              "reviews/QA-01.json",
              "revision-2-gate.json",
            ],
          },
        ],
      },
    });

    const firstObservation = observation(1, ["QA-01"]);
    const first = decideNonProgress(emptyNonProgressHistory(), firstObservation);
    const second = decideNonProgress(
      first.history,
      observation(2, ["QA-02"], {
        findings: [
          {
            ...firstObservation.findings[0]!,
            state: "RESOLVED",
            disposition: "RESOLVED",
          },
          ...observation(2, ["QA-02"]).findings,
        ],
      }),
    );
    const oscillating = decideNonProgress(
      second.history,
      observation(3, ["QA-01"], {
        findings: [
          ...observation(3, ["QA-01"]).findings,
          {
            ...observation(3, ["QA-02"]).findings[0]!,
            state: "RESOLVED",
            disposition: "RESOLVED",
          },
        ],
      }),
    );
    expect(oscillating).toMatchObject({
      action: "intervene",
      request: {
        reasonCodes: ["OSCILLATION"],
        attemptedRepairs: [
          {
            findingLineage: expect.arrayContaining([
              expect.objectContaining({
                stableId: "QA-01",
                state: "OPEN",
                evidence: "QA-01 evidence",
              }),
            ]),
          },
          {
            findingLineage: expect.arrayContaining([
              expect.objectContaining({
                stableId: "QA-01",
                state: "RESOLVED",
                evidence: "QA-01 evidence",
              }),
            ]),
          },
          {
            findingLineage: expect.arrayContaining([
              expect.objectContaining({
                stableId: "QA-01",
                state: "OPEN",
                evidence: "QA-01 evidence",
              }),
            ]),
          },
        ],
      },
    });

    const regressing = decideNonProgress(
      first.history,
      observation(2, ["QA-02"], {
        regressedBlockingIds: ["QA-02"],
        findings: [
          ...observation(2, ["QA-02"]).findings,
          {
            ...observation(2, ["QA-OLD"]).findings[0]!,
            state: "RESOLVED",
            disposition: "RESOLVED",
          },
        ],
      }),
    );
    expect(regressing).toMatchObject({
      action: "intervene",
      request: {
        reasonCodes: ["REGRESSION_GROWTH"],
        attemptedRepairs: [
          {
            revision: 1,
            findingLineage: [
              expect.objectContaining({
                stableId: "QA-01",
                state: "OPEN",
                evidence: "QA-01 evidence",
              }),
            ],
          },
          {
            revision: 2,
            findingLineage: expect.arrayContaining([
              expect.objectContaining({
                stableId: "QA-02",
                state: "OPEN",
                disposition: "OPEN",
                evidence: "QA-02 evidence",
              }),
              expect.objectContaining({
                stableId: "QA-OLD",
                state: "RESOLVED",
                disposition: "RESOLVED",
                evidence: "QA-OLD evidence",
              }),
            ]),
          },
        ],
      },
    });
  });

  it("preserves the best recoverable candidate and emits an actionable typed request", () => {
    const first = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, []),
    );
    const regressing = decideNonProgress(
      first.history,
      observation(2, ["QA-02"], {
        regressedBlockingIds: ["QA-02"],
      }),
    );
    expect(regressing.action).toBe("intervene");
    if (regressing.action !== "intervene") return;
    expect(regressing.request).toMatchObject({
      version: 1,
      interventionClass: "IMPLEMENTATION_INTERVENTION",
      blockerIds: ["QA-02"],
      preservedCandidate: { treeId: TREE_A },
      supportingEvidence: ["gate.json", "reviews/QA-02.json"],
    });
    expect(regressing.request.requiredOperatorAction).toContain(TREE_A);
  });

  it("derives intervention classes only from typed terminal causes", () => {
    const product = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, ["F-01"], {
        cause: {
          kind: "CONTRACT_CONVERGENCE",
          interventionClass: "PRODUCT_DECISION",
        },
        phase: "contract",
        candidate: {
          branch: "afk/demo-slice-01",
          treeId: TREE_A,
          phase: "contract",
          revision: 1,
        },
        reopenedWithoutNewEvidenceIds: ["F-01"],
      }),
    );
    expect(product).toMatchObject({
      action: "intervene",
      request: { interventionClass: "PRODUCT_DECISION" },
    });

    const recovery = buildRecoveryIntervention({
      phase: "deterministic-qa",
      candidate: observation(1, ["QA-01"]).candidate,
      summary: "The pending deterministic checkpoint failed",
      blockerIds: ["post-qa-deterministic"],
      attemptedRepairs: [
        {
          phase: "deterministic-qa",
          revision: 1,
          candidateTreeId: TREE_A,
          activeBlockingIds: ["post-qa-deterministic"],
        },
      ],
      supportingEvidence: ["state.json#/stageCheckpoints/01"],
    });
    expect(recovery).toMatchObject({
      cause: {
        kind: "CHECKPOINT_RECOVERY",
        interventionClass: "RECOVERY_ACTION",
      },
      interventionClass: "RECOVERY_ACTION",
      blockerIds: ["post-qa-deterministic"],
      attemptedRepairs: [
        expect.objectContaining({
          activeBlockingIds: ["post-qa-deterministic"],
        }),
      ],
      supportingEvidence: ["state.json#/stageCheckpoints/01"],
    });

    const implementation = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, ["QA-01"], {
        reopenedWithoutNewEvidenceIds: ["QA-01"],
        supportingEvidence: ["This prose says product decision and restore"],
      }),
    );
    expect(implementation).toMatchObject({
      action: "intervene",
      request: {
        cause: {
          kind: "QA_CONVERGENCE",
          interventionClass: "IMPLEMENTATION_INTERVENTION",
        },
        interventionClass: "IMPLEMENTATION_INTERVENTION",
      },
    });
  });

  it("turns bounded semantic exhaustion into a structured intervention", () => {
    const first = decideNonProgress(
      emptyNonProgressHistory(),
      observation(1, ["QA-01"], {
        supportingEvidence: ["revision-1-gate.json"],
      }),
    );
    const exhausted = buildSemanticCapIntervention(
      first.history,
      observation(2, ["QA-03"], {
        supportingEvidence: ["revision-2-gate.json"],
      }),
    );
    expect(exhausted.request).toMatchObject({
      reasonCodes: ["SEMANTIC_CAP_EXHAUSTED"],
      blockerIds: ["QA-03"],
      interventionClass: "IMPLEMENTATION_INTERVENTION",
      attemptedRepairs: [
        {
          revision: 1,
          findingLineage: [
            expect.objectContaining({
              stableId: "QA-01",
              state: "OPEN",
              evidence: "QA-01 evidence",
            }),
          ],
          supportingEvidence: [
            "reviews/QA-01.json",
            "revision-1-gate.json",
          ],
        },
        {
          revision: 2,
          findingLineage: [
            expect.objectContaining({
              stableId: "QA-03",
              state: "OPEN",
              evidence: "QA-03 evidence",
            }),
          ],
          supportingEvidence: [
            "reviews/QA-03.json",
            "revision-2-gate.json",
          ],
        },
      ],
      supportingEvidence: [
        "reviews/QA-01.json",
        "reviews/QA-03.json",
        "revision-1-gate.json",
        "revision-2-gate.json",
      ],
    });
  });

  it("is provider-independent and validates durable candidate identity", () => {
    const input = observation(1, ["QA-01"]);
    expect(decideNonProgress(emptyNonProgressHistory(), input)).toEqual(
      decideNonProgress(
        structuredClone(emptyNonProgressHistory()),
        structuredClone(input),
      ),
    );
    expect(Object.keys(input)).not.toContain("provider");
    expect(() =>
      parseNonProgressHistory({
        version: 1,
        observations: [
          {
            ...input,
            candidate: { ...input.candidate, treeId: "not-a-tree" },
          },
        ],
      }),
    ).toThrow(/malformed/);
  });

  it("leaves contested contract blockers to the adjudication path", () => {
    const finding = (
      state: ContractReviewFinding["state"],
    ): ContractReviewFinding => ({
      id: "F-01",
      severity: "BLOCKING",
      behaviorIds: ["B-01"],
      evidence: "same contract evidence",
      expected: "the contract is unambiguous",
      observed: "the parties disagree",
      clearCondition: "a product decision settles the requirement",
      state,
      revisionCitation: null,
    });
    const first = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      { version: 2, verdict: "REVISE", findings: [finding("OPEN")] },
    );
    const contested = advanceContractFindingLineage(first.lineage, {
      version: 2,
      verdict: "REVISE",
      findings: [finding("CONTESTED")],
    });

    const observation = contractNonProgressObservation({
      before: first.lineage,
      update: contested,
      candidate: {
        branch: "afk/demo-slice-01",
        treeId: TREE_B,
      },
    });

    expect(observation.activeBlockingIds).toEqual(["F-01"]);
    expect(observation.repeatedBlockingIds).toEqual([]);
  });
});
