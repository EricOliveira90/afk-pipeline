import {
  advanceContractFindingLineage,
  contractPlannerContext,
  decideContractContinuation,
  loadContractFindingLineage,
  saveContractFindingLineage,
  validateContractReviewAgainstLineage,
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

declare const validatedContractReviewBrand: unique symbol;

export interface ValidatedContractReview {
  readonly review: ContractReview;
  readonly [validatedContractReviewBrand]: true;
}

export type ContractRoundDispatch =
  | { action: "CONTINUE" }
  | { action: "FINAL_RESPONSE"; findingIds: string[] }
  | {
      action: "STOP";
      reason: string;
      intervention: InterventionRequest | null;
    };

export type QAAttemptDispatch =
  | { action: "CONTINUE" }
  | { action: "FINAL_REPAIR"; findingIds: string[] }
  | { action: "STOP"; reason: string }
  | { action: "INTERVENE"; request: InterventionRequest };

export function validateFreshContractReview(
  review: ContractReview,
): ValidatedContractReview {
  validateRound1ContractReview(review);
  return { review } as ValidatedContractReview;
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
    // A same-run planner response answers the exact review it was handed.
    // Durable lineage may coalesce equivalent findings across revisions, but
    // distinct findings in one review still require distinct responses.
    const currentRoundFindings =
      round > 1 && this.previousReview !== null
        ? openContractReviewFindings(this.previousReview.findings)
        : context.open;
    const resolvedHistory =
      context.relevantResolved.length > 0
        ? `\n\nKeep this relevant resolved history satisfied to avoid regression:\n\n` +
          formatContractReviewFindings(context.relevantResolved)
        : "";
    const priorFindings =
      currentRoundFindings.length > 0
        ? `The contract review returned REVISE with these findings. ` +
          `Respond to each clear-condition:\n\n` +
          `${formatContractReviewFindings(currentRoundFindings)}` +
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
      routedFindings: round > 1 ? currentRoundFindings : [],
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

  validateAttempt(input: {
    review: ContractReview;
    evaluatorRound: number;
    plannerResponse: ContractResponse | null;
    revisionArtifacts: ContractRevisionArtifacts | null;
    attemptLifecyclePrevious: ContractReview | null;
    fresh?: boolean;
  }): ValidatedContractReview {
    validateContractReviewAgainstLineage(this.lineage, input.review);
    if (
      input.fresh ||
      (input.evaluatorRound === 1 && this.lineage.revision === 0)
    ) {
      return validateFreshContractReview(input.review);
    } else if (this.previousReview && input.plannerResponse) {
      validateRound2ContractReview(
        this.previousReview,
        input.plannerResponse,
        input.review,
        input.revisionArtifacts ?? undefined,
        input.attemptLifecyclePrevious ?? this.previousReview,
      );
    }
    return {
      review: input.review,
    } as ValidatedContractReview;
  }

  recordRound(input: {
    validated: ValidatedContractReview;
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
    dispatch: ContractRoundDispatch;
  } {
    const review = input.validated.review;
    const before = this.lineage;
    const update = advanceContractFindingLineage(before, review);
    this.lineage = update.lineage;
    saveContractFindingLineage(this.target, this.lineage);
    const observation = contractNonProgressObservation({
      before,
      update,
      candidate: input.candidate,
      supportingEvidence: input.supportingEvidence,
    });
    const eligible =
      review.verdict === "REVISE" &&
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
          review,
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
    let dispatch: ContractRoundDispatch = { action: "CONTINUE" };
    if (intervention !== null) {
      dispatch = {
        action: "STOP",
        reason: intervention.summary,
        intervention,
      };
    } else if (continuation?.action === "extend") {
      this.lineage = { ...this.lineage, extensionUsed: true };
      saveContractFindingLineage(this.target, this.lineage);
      dispatch = {
        action: "FINAL_RESPONSE",
        findingIds: continuation.findingIds,
      };
    } else if (input.round === input.semanticRoundLimit) {
      dispatch = {
        action: "STOP",
        reason:
          continuation?.action === "stop"
            ? continuation.reason
            : `contract negotiation reached semantic round ${input.semanticRoundLimit}`,
        intervention,
      };
    }
    const metrics = contractReviewGapMetrics(review, this.previousReview);
    this.previousReview = review;
    return {
      metrics,
      openFindings: this.openFindings,
      dispatch,
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
    position?: {
      implementationAttempt: number;
      implementationAttemptLimit: number;
      round: number;
      normalRoundLimit: number;
    };
  }): {
    convergence: QAConvergenceState;
    dispatch: QAAttemptDispatch;
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
    let finalRepair = null as ReturnType<typeof decideQAFinalRepair> | null;
    const allowFinalRepair =
      input.position !== undefined &&
      input.position.round === input.position.normalRoundLimit;
    const semanticCapReached =
      input.position !== undefined &&
      input.position.implementationAttempt ===
        input.position.implementationAttemptLimit;
    if (decision.action === "continue" && allowFinalRepair) {
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
        dispatch: {
          action: "INTERVENE",
          request: persistIntervention(this.target, decision.request),
        },
      };
    }
    if (semanticCapReached && finalRepair?.action !== "extend") {
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
        dispatch: {
          action: "INTERVENE",
          request: persistIntervention(this.target, exhausted.request),
        },
      };
    }
    return {
      convergence: this.state,
      dispatch:
        finalRepair?.action === "extend"
          ? { action: "FINAL_REPAIR", findingIds: finalRepair.findingIds }
          : finalRepair?.action === "stop"
            ? { action: "STOP", reason: finalRepair.reason }
            : { action: "CONTINUE" },
    };
  }
}
