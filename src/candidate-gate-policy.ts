import { join } from "node:path";
import type { GeneratorFailureSet } from "./context-envelope.js";
import type {
  GateDeclaration,
  GateEvidence,
  GateEvidenceArtifact,
} from "./gate-runner.js";

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
      /**
       * The focused failure set for the next generator dispatch. QA already
       * passed this candidate before the full slice suite ran, so every QA
       * finding is RESOLVED by construction; the repair envelope carries the
       * failed gates only. Carrying the pre-gate finding set forward would
       * re-ship resolved lineage to a fresh generator (architect A2, PM
       * P-02). Resolved lineage stays persisted in the QA convergence state
       * for convergence decisions and intervention evidence.
       */
      failureSet: GeneratorFailureSet;
    };

/**
 * Turns one accepted-candidate gate phase into the next orchestration
 * decision. Required-gate classification and repair context stay together.
 *
 * The retry note is control-plane text only. All failure content — gate IDs,
 * evidence paths, finding IDs, clear conditions — travels exclusively in the
 * compact `failureSet`, which the generator envelope renders as the single
 * final failure block (PRD user story 5; guardian round 2, PM 2).
 */
export function decideCandidateGatePhase(input: {
  run: CandidateGatePhaseRun;
  declarations: readonly GateDeclaration[];
  evidenceDir: string;
  nextRound: number;
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
    failureSet: {
      findings: [],
      gates: failures.map(({ evidencePath, result }) => ({
        id: result.gateId,
        evidence: [
          evidencePath.replace(/\\/g, "/"),
          join(input.evidenceDir, result.logArtifactId).replace(/\\/g, "/"),
        ],
      })),
    },
    retryNote:
      `This is implementation round ${input.nextRound}. The full slice ` +
      `suite failed on the accepted candidate. Fix every failed gate in ` +
      `the current failure set at the end of this prompt without ` +
      `regressing behavior the candidate already delivers.`,
  };
}
