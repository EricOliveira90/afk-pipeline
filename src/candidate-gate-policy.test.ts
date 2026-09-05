import { describe, expect, it } from "vitest";
import { decideCandidateGatePhase } from "./candidate-gate-policy.js";
import type {
  GateDeclaration,
  GateEvidence,
  GateResult,
} from "./gate-runner.js";
import { emptyQAConvergenceState } from "./qa-convergence.js";

const TREE_ID = "a".repeat(40);

function gateResult(
  gateId: string,
  status: GateResult["status"],
): GateResult {
  return {
    gateId,
    stage: "base",
    status,
    failureKind: status === "FAIL" ? "COMMAND" : null,
    startedAt: "2026-09-05T00:00:00.000Z",
    endedAt: "2026-09-05T00:00:00.010Z",
    durationMs: 10,
    exitCode: status === "FAIL" ? 1 : 0,
    treeId: TREE_ID,
    logArtifactId: `${gateId}.log`,
  };
}

describe("candidate gate repair policy", () => {
  it("routes failed evidence and open QA findings without resolved lineage", () => {
    const declarations: GateDeclaration[] = [
      {
        id: "tests",
        stage: "base",
        required: true,
        command: "pnpm test",
      },
    ];
    const failedEvidence: GateEvidence = {
      version: 1,
      attemptId: "attempt-failed",
      treeId: TREE_ID,
      results: [gateResult("tests", "FAIL")],
    };
    const convergence = emptyQAConvergenceState();
    convergence.revision = 2;
    convergence.findings["deterministic:QA-PRIOR"] = {
      stableId: "QA-PRIOR",
      currentId: "QA-PRIOR",
      stage: "deterministic",
      disposition: "RESOLVED",
      firstSeenRevision: 1,
      lastSeenRevision: 1,
      occurrences: 1,
      candidateTreeId: TREE_ID,
      finding: {
        id: "QA-PRIOR",
        severity: "BLOCKING",
        behaviorIds: ["B-PRIOR"],
        summary: "Preserve the prior behavior",
        evidence: "The focused assertion passes",
        expected: "The prior behavior remains fixed",
        observed: "The prior behavior remains fixed",
        clearCondition: "The focused assertion keeps passing",
        state: "RESOLVED",
        remedy: "SOURCE_CHANGE",
        amendmentPaths: [],
      },
      artifactReferences: ["reviews/qa-prior.json"],
    };
    convergence.findings["deterministic:QA-CURRENT"] = {
      stableId: "QA-CURRENT",
      currentId: "QA-CURRENT",
      stage: "deterministic",
      disposition: "OPEN",
      firstSeenRevision: 2,
      lastSeenRevision: 2,
      occurrences: 1,
      candidateTreeId: TREE_ID,
      finding: {
        id: "QA-CURRENT",
        severity: "BLOCKING",
        behaviorIds: ["B-PRIOR"],
        summary: "Repair the current behavior",
        evidence: "The current assertion fails",
        expected: "The current behavior works",
        observed: "The current behavior regressed",
        clearCondition: "The current assertion passes",
        state: "OPEN",
        remedy: "SOURCE_CHANGE",
        amendmentPaths: [],
      },
      artifactReferences: ["reviews/qa-current.json"],
    };

    const decision = decideCandidateGatePhase({
      run: {
        evidence: failedEvidence,
        evidencePath: "gates/attempt-failed.json",
        attempts: [
          {
            evidence: failedEvidence,
            evidencePath: "gates/attempt-failed.json",
          },
        ],
        artifacts: [],
      },
      declarations,
      evidenceDir: "gates",
      nextRound: 2,
      convergence,
      repairStage: "deterministic",
    });

    expect(decision).toMatchObject({
      action: "REPAIR",
      failedGateIds: ["tests"],
      references: [
        "gates/attempt-failed.json",
        expect.stringMatching(/gates\/tests\.log$/),
      ],
    });
    expect(decision.action).toBe("REPAIR");
    if (decision.action !== "REPAIR") return;
    expect(decision.retryNote).toContain("implementation round 2");
    expect(decision.retryNote).toContain("gates/attempt-failed.json");
    expect(decision.retryNote).toMatch(/gates[/\\]tests\.log/);
    expect(decision.retryNote).toContain("QA-CURRENT");
    expect(decision.retryNote).not.toContain("QA-PRIOR");
    expect(decision.retryNote).not.toContain("State: RESOLVED");
    expect(decision.retryNote).not.toContain(
      "The focused assertion keeps passing",
    );
    expect(decision.retryNote).not.toContain("reviews/qa-prior.json");
    // The focused failure-set projection carries the failed gates only.
    // Findings are empty by policy: QA passed the candidate before the full
    // suite ran, so any finding in the convergence state is resolved lineage
    // and must not re-enter a generator envelope (architect A2, PM P-02).
    expect(decision.failureSet).toEqual({
      findings: [],
      gates: [
        {
          id: "tests",
          evidence: [
            "gates/attempt-failed.json",
            expect.stringMatching(/gates[/\\]tests\.log$/),
          ],
        },
      ],
    });
  });
});
