import {
  decideContractContinuation,
  type ContractContinuationDecision,
  type ContractConvergenceUpdate,
  type ContractFindingLineage,
} from "./contract-convergence.js";
import type { ContractReview } from "./contract-review.js";
import {
  buildSemanticCapIntervention,
  contractNonProgressObservation,
  decideNonProgress,
  loadNonProgressHistory,
  qaNonProgressObservation,
  saveNonProgressHistory,
  type InterventionRequest,
} from "./non-progress.js";
import {
  decideQAFinalRepair,
  markQAFinalRepairUsed,
  saveQAConvergenceState,
  type QAConvergenceState,
  type QAConvergenceUpdate,
  type QAFinalRepairDecision,
} from "./qa-convergence.js";
import type { QAReview, QAReviewStage } from "./qa-review.js";

export interface ConvergenceLocation {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

export function coordinateContractContinuation(input: {
  location: ConvergenceLocation;
  before: ContractFindingLineage;
  update: ContractConvergenceUpdate;
  review: ContractReview;
  candidate: { branch: string; treeId: string };
  supportingEvidence: readonly string[];
  eligibleForNonProgress: boolean;
  atNormalBoundary: boolean;
  semanticCapReached: boolean;
  gateObjection: boolean;
  revisionCitationValidated: boolean;
}): {
  continuation: ContractContinuationDecision | null;
  intervention: InterventionRequest | null;
} {
  const observation = contractNonProgressObservation({
    before: input.before,
    update: input.update,
    candidate: input.candidate,
    supportingEvidence: input.supportingEvidence,
  });
  let history = loadNonProgressHistory(input.location);
  let intervention: InterventionRequest | null = null;
  if (input.eligibleForNonProgress) {
    const decision = decideNonProgress(history, observation);
    history = decision.history;
    saveNonProgressHistory(input.location, history);
    if (decision.action === "intervene") intervention = decision.request;
  }
  const continuation = input.atNormalBoundary
    ? decideContractContinuation({
        before: input.before,
        update: input.update,
        review: input.review,
        gateObjection: input.gateObjection,
        revisionCitationValidated: input.revisionCitationValidated,
      })
    : null;
  if (
    intervention === null &&
    input.semanticCapReached &&
    continuation?.action !== "extend" &&
    input.eligibleForNonProgress
  ) {
    const recorded = history.observations.at(-1);
    const prior =
      recorded?.phase === observation.phase &&
      recorded.revision === observation.revision
        ? { ...history, observations: history.observations.slice(0, -1) }
        : history;
    const exhausted = buildSemanticCapIntervention(prior, observation);
    saveNonProgressHistory(input.location, exhausted.history);
    intervention = exhausted.request;
  }
  return { continuation, intervention };
}

export function coordinateQAContinuation(input: {
  location: ConvergenceLocation;
  before: QAConvergenceState;
  update: QAConvergenceUpdate;
  review: QAReview;
  stage: QAReviewStage;
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
    before: input.before,
    update: input.update,
    phase:
      input.stage === "deterministic"
        ? "deterministic-qa"
        : "shared-preview-uat",
    candidate: input.candidate,
    supportingEvidence: input.supportingEvidence,
  });
  const decision = decideNonProgress(
    loadNonProgressHistory(input.location),
    observation,
  );
  saveNonProgressHistory(input.location, decision.history);
  let convergence = input.update.state;
  let finalRepair: QAFinalRepairDecision | null = null;
  if (decision.action === "continue" && input.allowFinalRepair) {
    finalRepair = decideQAFinalRepair({
      before: input.before,
      update: input.update,
      review: input.review,
      stage: input.stage,
      candidateTreeId: input.candidate.treeId,
    });
    if (finalRepair.action === "extend") {
      convergence = markQAFinalRepairUsed(convergence);
      saveQAConvergenceState(input.location, convergence);
    }
  }
  if (decision.action === "intervene") {
    return {
      convergence,
      finalRepair,
      intervention: decision.request,
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
    saveNonProgressHistory(input.location, exhausted.history);
    return {
      convergence,
      finalRepair,
      intervention: exhausted.request,
    };
  }
  return { convergence, finalRepair, intervention: null };
}
