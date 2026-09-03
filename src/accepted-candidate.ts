import { implementationRoundsRemaining } from "./bounds.js";
import {
  clearExactStageCheckpoint,
  inspectExactStageCheckpoint,
  recordExactStageCheckpoint,
  runPendingDeterministicStage,
  type CompletedCandidateStage,
} from "./exact-stage-resume.js";
import {
  buildDeterministicGateIntervention,
  buildPersistedQAExhaustionIntervention,
  buildRecoveryIntervention,
  loadNonProgressHistory,
  writeInterventionRequest,
  type ConvergencePhase,
  type InterventionRequest,
} from "./non-progress.js";
import {
  hasPendingQAFinalRepair,
  loadQAConvergenceState,
} from "./qa-convergence.js";
import type { QAReviewAttemptFinding } from "./qa-review.js";
import type { MigrationValidation } from "./migration-gate.js";

interface AcceptedCandidateTarget {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
  sliceDir: string;
  runSlug: string;
  worktreeDir: string;
  featureBranch: string;
  branch: string;
  sharedPreview: boolean;
  migrationValidation?: MigrationValidation;
}

export type ExactStageDispatch =
  | {
      action: "FINALIZE";
      checkpoint: {
        completedStage: CompletedCandidateStage;
        candidateTreeId: string;
        nextPendingStage: "post-qa-deterministic";
      };
    }
  | { action: "REEVALUATE"; reason: string };

export type AcceptedCandidateDispatch =
  | { action: "PASS" }
  | { action: "INTERVENE"; request: InterventionRequest };

export interface ImplementationAttemptPlan {
  firstRound: number;
  attemptLimit: number;
  finalRound: number;
}

function phaseFor(
  completedStage: CompletedCandidateStage,
): Exclude<ConvergencePhase, "contract"> {
  return completedStage === "deterministic-qa"
    ? "deterministic-qa"
    : "shared-preview-uat";
}

/**
 * Owns policy at the accepted-candidate boundary: resume eligibility,
 * implementation capacity, deterministic finalization, and terminal evidence.
 */
export class AcceptedCandidateLifecycle {
  readonly completedStage: CompletedCandidateStage;

  constructor(private readonly target: AcceptedCandidateTarget) {
    this.completedStage = target.sharedPreview
      ? "shared-preview-uat"
      : "deterministic-qa";
  }

  resetCheckpoint(): void {
    clearExactStageCheckpoint(this.target);
  }

  inspectResume(
    currentCandidateTreeId: string | null,
    maximumRound: number,
  ): ExactStageDispatch {
    const decision = inspectExactStageCheckpoint({
      ...this.target,
      currentCandidateTreeId,
      expectedCompletedStage: this.completedStage,
      maximumRound,
    });
    if (decision.action === "resume") {
      return { action: "FINALIZE", checkpoint: decision.checkpoint };
    }
    clearExactStageCheckpoint(this.target);
    return { action: "REEVALUATE", reason: decision.reason };
  }

  planImplementationAttempts(input: {
    firstRound: number;
    normalRoundLimit: number;
    resumeMode?: "killed" | "stuck";
  }): ImplementationAttemptPlan {
    const convergence = loadQAConvergenceState(this.target);
    let attemptLimit = implementationRoundsRemaining({
      limit: input.normalRoundLimit,
      spent: input.firstRound - 1,
      resumeMode: input.resumeMode,
    });
    if (
      input.resumeMode !== "stuck" &&
      attemptLimit === 0 &&
      hasPendingQAFinalRepair({
        state: convergence,
        nextRound: input.firstRound,
        normalRoundLimit: input.normalRoundLimit,
      })
    ) {
      attemptLimit = 1;
    }
    return {
      firstRound: input.firstRound,
      attemptLimit,
      finalRound: input.firstRound + attemptLimit - 1,
    };
  }

  accept(input: {
    round: number;
    candidateTreeId: string;
  }): AcceptedCandidateDispatch {
    recordExactStageCheckpoint(this.target, {
      version: 1,
      completedStage: this.completedStage,
      candidateTreeId: input.candidateTreeId,
      nextPendingStage: "post-qa-deterministic",
      round: input.round,
    });
    return this.finalize(input.candidateTreeId);
  }

  finalize(candidateTreeId: string): AcceptedCandidateDispatch {
    const result = runPendingDeterministicStage({
      ...this.target,
      worktreeDir: this.target.worktreeDir,
      featureBranch: this.target.featureBranch,
      sharedPreview: this.target.sharedPreview,
      ...(this.target.migrationValidation !== undefined
        ? { migrationValidation: this.target.migrationValidation }
        : {}),
    });
    if (result.ok) return { action: "PASS" };
    const convergence = loadQAConvergenceState(this.target);
    const phase = phaseFor(this.completedStage);
    const blockerId = "post-qa-deterministic";
    const revision = Math.max(convergence.revision, 1);
    return {
      action: "INTERVENE",
      request: this.persist(
        buildRecoveryIntervention({
          phase,
          candidate: {
            branch: this.target.branch,
            treeId: candidateTreeId,
            phase,
            revision,
          },
          summary:
            `AFK could not complete the pending deterministic stage for ` +
            `an already accepted candidate: ${result.error}`,
          blockerIds: [blockerId],
          attemptedRepairs: [
            {
              phase,
              revision,
              candidateTreeId,
              activeBlockingIds: [blockerId],
            },
          ],
          supportingEvidence: [
            `candidate-tree:${candidateTreeId}`,
            `pending-stage:${blockerId}`,
            `pending-stage-error:${result.error}`,
          ],
        }),
      ),
    };
  }

  exhaustImplementation(input: {
    phase: Exclude<ConvergencePhase, "contract">;
    candidateTreeId: string;
    firstRound: number;
    attemptLimit: number;
    archivedUnresolved: readonly QAReviewAttemptFinding[];
    supportingEvidence: readonly string[];
  }): Extract<AcceptedCandidateDispatch, { action: "INTERVENE" }> {
    const convergence = loadQAConvergenceState(this.target);
    const request = buildPersistedQAExhaustionIntervention({
      phase: input.phase,
      candidate: {
        branch: this.target.branch,
        treeId: input.candidateTreeId,
        phase: input.phase,
        revision: Math.max(convergence.revision, input.firstRound, 1),
      },
      convergence,
      history: loadNonProgressHistory(this.target),
      archivedFindings: input.archivedUnresolved,
      supportingEvidence: [
        ...input.supportingEvidence,
        ...input.archivedUnresolved.flatMap(
          ({ artifactReferences }) => artifactReferences,
        ),
      ],
      summary:
        `AFK exhausted ${input.attemptLimit} implementation attempt(s) ` +
        `without an accepted candidate.`,
    });
    return { action: "INTERVENE", request: this.persist(request) };
  }

  exhaustDeterministicGates(input: {
    candidateTreeId: string;
    revision: number;
    failedGateIds: readonly string[];
    attemptTreeIds: readonly string[];
    supportingEvidence: readonly string[];
  }): Extract<AcceptedCandidateDispatch, { action: "INTERVENE" }> {
    const phase: Exclude<ConvergencePhase, "contract"> = "deterministic-qa";
    const request = buildDeterministicGateIntervention({
      candidate: {
        branch: this.target.branch,
        treeId: input.candidateTreeId,
        phase,
        revision: input.revision,
      },
      failedGateIds: input.failedGateIds,
      attemptedRepairs: input.attemptTreeIds.map((treeId, index) => ({
        phase,
        revision: Math.max(
          1,
          input.revision - input.attemptTreeIds.length + index + 1,
        ),
        candidateTreeId: treeId,
        activeBlockingIds: [...input.failedGateIds],
      })),
      supportingEvidence: input.supportingEvidence,
      summary:
        `AFK exhausted deterministic base-gate repair capacity with failed ` +
        `gate(s) ${[...new Set(input.failedGateIds)].sort().join(", ")}.`,
      convergence: loadQAConvergenceState(this.target),
      history: loadNonProgressHistory(this.target),
    });
    return { action: "INTERVENE", request: this.persist(request) };
  }

  private persist(request: InterventionRequest): InterventionRequest {
    writeInterventionRequest(this.target.sliceDir, request, {
      repoRoot: this.target.repoRoot,
      runSlug: this.target.runSlug,
      ghIssue: this.target.ghIssue,
    });
    return request;
  }
}
