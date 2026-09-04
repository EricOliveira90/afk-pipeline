import { join } from "node:path";
import type {
  GateDeclaration,
  GateEvidence,
  GateEvidenceArtifact,
} from "./gate-runner.js";
import {
  formatQAGeneratorContext,
  type QAConvergenceState,
} from "./qa-convergence.js";

export interface CandidateGatePhaseRun {
  evidence: GateEvidence;
  evidencePath: string;
  attempts: Array<{ evidence: GateEvidence; evidencePath: string }>;
  artifacts: GateEvidenceArtifact[];
}

export type CandidateGateDecision =
  | { action: "PASS" }
  | { action: "ERROR"; error: string }
  | {
      action: "REPAIR";
      failedGateIds: string[];
      references: string[];
      retryNote: string;
    };

/**
 * Turns one accepted-candidate gate phase into the next orchestration
 * decision. Required-gate classification and repair context stay together.
 */
export function decideCandidateGatePhase(input: {
  run: CandidateGatePhaseRun;
  declarations: readonly GateDeclaration[];
  evidenceDir: string;
  nextRound: number;
  convergence: QAConvergenceState;
  repairStage?: Parameters<typeof formatQAGeneratorContext>[2];
}): CandidateGateDecision {
  const requiredIds = new Set(
    input.declarations
      .filter((declaration) => declaration.required)
      .map((declaration) => declaration.id),
  );
  const infrastructure = input.run.evidence.results.filter(
    (gate) =>
      requiredIds.has(gate.gateId) && gate.status === "INFRASTRUCTURE",
  );
  if (infrastructure.length > 0) {
    return {
      action: "ERROR",
      error:
        `Full slice suite infrastructure failed: ` +
        `${infrastructure.map((gate) => gate.gateId).join(", ")} ` +
        `(${input.run.evidencePath.replace(/\\/g, "/")})`,
    };
  }

  const failures = input.run.attempts.flatMap(({ evidence, evidencePath }) =>
    evidence.results
      .filter(
        (result) =>
          requiredIds.has(result.gateId) && result.status === "FAIL",
      )
      .map((result) => ({ evidencePath, result })),
  );
  if (failures.length === 0) return { action: "PASS" };

  const references = [
    ...new Set(
      failures.map(({ evidencePath }) => evidencePath.replace(/\\/g, "/")),
    ),
    ...failures.map(({ result }) =>
      join(input.evidenceDir, result.logArtifactId).replace(/\\/g, "/"),
    ),
  ];
  return {
    action: "REPAIR",
    failedGateIds: failures.map(({ result }) => result.gateId),
    references,
    retryNote:
      `This is implementation round ${input.nextRound}. Fix every unresolved ` +
      `full-suite failure and preserve prior resolved QA behavior:\n` +
      formatQAGeneratorContext(
        input.convergence,
        references,
        input.repairStage,
      ),
  };
}
