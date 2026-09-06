import { describe, expect, it } from "vitest";
import { decideCandidateGatePhase } from "./candidate-gate-policy.js";
import type {
  GateDeclaration,
  GateEvidence,
  GateResult,
} from "./gate-runner.js";

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
  it("routes all failure content through the compact failure set only", () => {
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
    // The retry note is control-plane text only (guardian round 2, PM 2):
    // no gate evidence paths, finding IDs, summaries, states, or report
    // references — all failure content rides solely in the compact failure
    // set the envelope renders as the prompt's final block.
    expect(decision.retryNote).toContain("implementation round 2");
    expect(decision.retryNote).toContain("failure set");
    expect(decision.retryNote).not.toContain("gates/attempt-failed.json");
    expect(decision.retryNote).not.toMatch(/gates[/\\]tests\.log/);
    expect(decision.retryNote).not.toContain("QA-");
    expect(decision.retryNote).not.toContain("State: RESOLVED");
    expect(decision.retryNote).not.toContain("reviews/");
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
