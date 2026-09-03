import {
  advanceContractFindingLineage,
  contractPlannerContext,
  decideContractContinuation,
  loadContractFindingLineage,
  saveContractFindingLineage,
  validateContractReviewAgainstLineage,
  type ContractContinuationDecision,
  type ContractFindingLineage,
} from "./contract-convergence.js";
import {
  contractReviewGapMetrics,
  formatContractReviewFindings,
  openContractReviewFindings,
  validateRound1ContractReview,
  validateRound2ContractReview,
  type ContractResponse,
  type ContractRevisionArtifacts,
  type ContractReview,
  type ContractReviewFinding,
} from "./contract-review.js";
import {
  buildExecutionIntervention,
  buildRecoveryIntervention,
  buildSemanticCapIntervention,
  contractNonProgressObservation,
  decideNonProgress,
  loadNonProgressHistory,
  qaNonProgressObservation,
  saveNonProgressHistory,
  writeInterventionRequest,
  type InterventionRequest,
} from "./non-progress.js";
import {
  advanceQAFindingLineage,
  decideQAFinalRepair,
  loadQAConvergenceState,
  markQAFinalRepairUsed,
  qaLifecycleHistory,
  resolveQAScopeAmendments,
  saveQAConvergenceState,
  type QAConvergenceState,
  type QAConvergenceUpdate,
  type QAFinalRepairDecision,
} from "./qa-convergence.js";
import type {
  QAReview,
  QAReviewAttemptFinding,
  QAReviewLifecycleFinding,
  QAReviewStage,
} from "./qa-review.js";

export interface ConvergenceLocation {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

export interface ConvergenceArtifacts extends ConvergenceLocation {
  sliceDir: string;
  runSlug: string;
}

function persistIntervention(
  target: ConvergenceArtifacts,
  request: InterventionRequest,
): InterventionRequest {
  writeInterventionRequest(target.sliceDir, request, {
    repoRoot: target.repoRoot,
    runSlug: target.runSlug,
    ghIssue: target.ghIssue,
  });
  return request;
}

/**
 * Owns one slice's contract-review lifecycle. The orchestrator sequences
 * planner and evaluator dispatches; this session owns durable context,
 * validation, lineage, continuation policy, and intervention transitions.
 */
export class ContractRoundLifecycle {
  private lineage: ContractFindingLineage;
  private previousReview: ContractReview | null = null;

  constructor(private readonly target: ConvergenceArtifacts) {
    this.lineage = loadContractFindingLineage(target);
  }

  get openFindings(): readonly ContractReviewFinding[] {
    return contractPlannerContext(this.lineage).open;
  }

  preparePlannerRound(
    round: number,
    gateObjection: string | null,
  ): {
    requiresResponse: boolean;
    routedFindings: ContractReviewFinding[];
    revisionNote: string;
  } {
    const context = contractPlannerContext(this.lineage);
    const resolvedHistory =
      context.relevantResolved.length > 0
        ? `\n\nKeep this relevant resolved history satisfied to avoid regression:\n\n` +
          formatContractReviewFindings(context.relevantResolved)
        : "";
    const priorFindings =
      context.open.length > 0
        ? `The contract review returned REVISE with these findings. ` +
          `Respond to each clear-condition:\n\n` +
          `${formatContractReviewFindings(context.open)}` +
          resolvedHistory
        : null;
    const revisionNote =
      gateObjection === null
        ? priorFindings ?? ""
        : `The pipeline REJECTED the previous contract before any code was generated:\n\n` +
          `${gateObjection}\n\nResolve exactly that in this revision.` +
          (priorFindings
            ? `\n\nKeep the previous review's findings satisfied too.\n\n${priorFindings}`
            : "");
    return {
      requiresResponse: round > 1 && this.previousReview !== null,
      routedFindings:
        round > 1 ? openContractReviewFindings(context.open) : [],
      revisionNote,
    };
  }

  evaluatorHistoryNote(evaluatorRound: number, relSliceDir: string): string {
    const context = contractPlannerContext(this.lineage);
    const durableHistory =
      context.open.length > 0 || context.relevantResolved.length > 0
        ? [
            "Durable finding lineage for this slice:",
            "",
            "Current open findings:",
            formatContractReviewFindings(context.open),
            "",
            "Relevant resolved history:",
            formatContractReviewFindings(context.relevantResolved),
          ].join("\n")
        : "No durable finding lineage exists for this slice.";
    if (evaluatorRound > 1) {
      return (
        `A previous round's findings were handed to the planner. ` +
        `Its prose companion is ${relSliceDir}/feedback-r${evaluatorRound - 1}.md. ` +
        `Reuse a finding's exact \`id\` when the same gap still stands — ` +
        `the convergence lifecycle measures repeated gaps by ID.\n\n` +
        durableHistory
      );
    }
    return this.lineage.revision > 0
      ? `This is a fresh attempt with durable finding lineage. ` +
          `Reuse stable IDs and disposition every still-open finding. ` +
          `Resolved history relevant to this revision is already in the planner context.\n\n` +
          durableHistory
      : "This is the first review round; every finding ID is new.";
  }

  grantFinalResponse(): void {
    this.lineage = { ...this.lineage, extensionUsed: true };
    saveContractFindingLineage(this.target, this.lineage);
  }

  recordRound(input: {
    review: ContractReview;
    evaluatorRound: number;
    plannerResponse: ContractResponse | null;
    revisionArtifacts: ContractRevisionArtifacts | null;
    attemptLifecyclePrevious: ContractReview | null;
    candidate: { branch: string; treeId: string };
    supportingEvidence: readonly string[];
    round: number;
    normalRoundLimit: number;
    semanticRoundLimit: number;
    gateObjection: boolean;
    hasContestedBlocker: boolean;
  }): {
    metrics: ReturnType<typeof contractReviewGapMetrics>;
    openFindings: readonly ContractReviewFinding[];
    continuation: ContractContinuationDecision | null;
    intervention: InterventionRequest | null;
  } {
    const before = this.lineage;
    validateContractReviewAgainstLineage(before, input.review);
    if (input.evaluatorRound === 1 && before.revision === 0) {
      validateRound1ContractReview(input.review);
    } else if (this.previousReview && input.plannerResponse) {
      validateRound2ContractReview(
        this.previousReview,
        input.plannerResponse,
        input.review,
        input.revisionArtifacts ?? undefined,
        input.attemptLifecyclePrevious ?? this.previousReview,
      );
    }

    const update = advanceContractFindingLineage(before, input.review);
    this.lineage = update.lineage;
    saveContractFindingLineage(this.target, this.lineage);
    const observation = contractNonProgressObservation({
      before,
      update,
      candidate: input.candidate,
      supportingEvidence: input.supportingEvidence,
    });
    const eligible =
      input.review.verdict === "REVISE" &&
      !input.gateObjection &&
      !input.hasContestedBlocker;
    let history = loadNonProgressHistory(this.target);
    let intervention: InterventionRequest | null = null;
    if (eligible) {
      const decision = decideNonProgress(history, observation);
      history = decision.history;
      saveNonProgressHistory(this.target, history);
      if (decision.action === "intervene") {
        intervention = persistIntervention(this.target, decision.request);
      }
    }
    const atNormalBoundary =
      input.round === input.semanticRoundLimit &&
      input.round === input.normalRoundLimit;
    const continuation = atNormalBoundary
      ? decideContractContinuation({
          before,
          update,
          review: input.review,
          gateObjection: input.gateObjection,
          revisionCitationValidated: input.revisionArtifacts !== null,
        })
      : null;
    if (
      intervention === null &&
      input.round === input.semanticRoundLimit &&
      continuation?.action !== "extend" &&
      eligible
    ) {
      const recorded = history.observations.at(-1);
      const prior =
        recorded?.phase === observation.phase &&
        recorded.revision === observation.revision
          ? { ...history, observations: history.observations.slice(0, -1) }
          : history;
      const exhausted = buildSemanticCapIntervention(prior, observation);
      saveNonProgressHistory(this.target, exhausted.history);
      intervention = persistIntervention(this.target, exhausted.request);
    }
    const metrics = contractReviewGapMetrics(input.review, this.previousReview);
    this.previousReview = input.review;
    return {
      metrics,
      openFindings: this.openFindings,
      continuation,
      intervention,
    };
  }
}

export interface RecordedQAAttempt {
  review: QAReview;
  before: QAConvergenceState;
  update: QAConvergenceUpdate;
  history: QAReviewLifecycleFinding[];
  unresolved: QAReviewAttemptFinding[];
}

/**
 * Owns one QA stage's attempt lifecycle. Artifact production remains with the
 * evaluator adapter; once an attempt is validated and archived, this session
 * owns lineage, scope-resolution persistence, repair policy, and intervention.
 */
export class QAAttemptLifecycle {
  private state: QAConvergenceState;

  constructor(
    private readonly target: ConvergenceArtifacts,
    private readonly stage: QAReviewStage,
  ) {
    this.state = loadQAConvergenceState(target);
  }

  get convergence(): QAConvergenceState {
    return this.state;
  }

  recordAttempt(input: {
    review: QAReview;
    attemptFindings: readonly QAReviewAttemptFinding[];
    candidateTreeId: string;
    restoredOpenFindings: readonly QAReviewAttemptFinding[];
  }): RecordedQAAttempt {
    const before = this.state;
    const update = advanceQAFindingLineage(before, {
      stage: this.stage,
      review: input.review,
      attemptFindings: input.attemptFindings,
      candidateTreeId: input.candidateTreeId,
      restoredOpenFindings: input.restoredOpenFindings,
    });
    this.state = update.state;
    saveQAConvergenceState(this.target, this.state);
    return {
      review: input.review,
      before,
      update,
      history: qaLifecycleHistory(this.state, this.stage),
      unresolved:
        input.review.failureClass === "INFRASTRUCTURE"
          ? [...input.restoredOpenFindings]
          : input.attemptFindings.filter((finding) => finding.unresolved),
    };
  }

  resolveScopeAmendments(findingIds: readonly string[]): {
    convergence: QAConvergenceState;
    history: QAReviewLifecycleFinding[];
  } {
    this.state = resolveQAScopeAmendments(
      this.state,
      this.stage,
      findingIds,
    );
    saveQAConvergenceState(this.target, this.state);
    return {
      convergence: this.state,
      history: qaLifecycleHistory(this.state, this.stage),
    };
  }

  completeImplementation(input: {
    attempt: RecordedQAAttempt;
    candidate: { branch: string; treeId: string };
    supportingEvidence: readonly string[];
    allowFinalRepair: boolean;
    semanticCapReached: boolean;
  }): {
    convergence: QAConvergenceState;
    finalRepair: QAFinalRepairDecision | null;
    intervention: InterventionRequest | null;
  } {
    const observation = qaNonProgressObservation({
      before: input.attempt.before,
      update: input.attempt.update,
      phase:
        this.stage === "deterministic"
          ? "deterministic-qa"
          : "shared-preview-uat",
      candidate: input.candidate,
      supportingEvidence: input.supportingEvidence,
    });
    const decision = decideNonProgress(
      loadNonProgressHistory(this.target),
      observation,
    );
    saveNonProgressHistory(this.target, decision.history);
    let finalRepair: QAFinalRepairDecision | null = null;
    if (decision.action === "continue" && input.allowFinalRepair) {
      finalRepair = decideQAFinalRepair({
        before: input.attempt.before,
        update: input.attempt.update,
        review: input.attempt.review,
        stage: this.stage,
        candidateTreeId: input.candidate.treeId,
      });
      if (finalRepair.action === "extend") {
        this.state = markQAFinalRepairUsed(this.state);
        saveQAConvergenceState(this.target, this.state);
      }
    }
    if (decision.action === "intervene") {
      return {
        convergence: this.state,
        finalRepair,
        intervention: persistIntervention(this.target, decision.request),
      };
    }
    if (input.semanticCapReached && finalRepair?.action !== "extend") {
      const exhausted = buildSemanticCapIntervention(
        {
          ...decision.history,
          observations: decision.history.observations.slice(0, -1),
        },
        observation,
      );
      saveNonProgressHistory(this.target, exhausted.history);
      return {
        convergence: this.state,
        finalRepair,
        intervention: persistIntervention(this.target, exhausted.request),
      };
    }
    return {
      convergence: this.state,
      finalRepair,
      intervention: null,
    };
  }
}

export function recordRecoveryIntervention(
  target: ConvergenceArtifacts,
  input: {
    phase: "deterministic-qa" | "shared-preview-uat";
    branch: string;
    treeId: string;
    revision: number;
    summary: string;
    supportingEvidence?: readonly string[];
  },
): InterventionRequest {
  return persistIntervention(
    target,
    buildRecoveryIntervention({
      phase: input.phase,
      candidate: {
        branch: input.branch,
        treeId: input.treeId,
        phase: input.phase,
        revision: input.revision,
      },
      summary: input.summary,
      supportingEvidence: input.supportingEvidence,
    }),
  );
}

export function recordExecutionIntervention(
  target: ConvergenceArtifacts,
  input: {
    phase: "deterministic-qa" | "shared-preview-uat";
    branch: string;
    treeId: string;
    revision: number;
    summary: string;
    blockerIds?: readonly string[];
    supportingEvidence?: readonly string[];
  },
): InterventionRequest {
  return persistIntervention(
    target,
    buildExecutionIntervention({
      phase: input.phase,
      candidate: {
        branch: input.branch,
        treeId: input.treeId,
        phase: input.phase,
        revision: input.revision,
      },
      summary: input.summary,
      blockerIds: input.blockerIds,
      supportingEvidence: input.supportingEvidence,
    }),
  );
}
