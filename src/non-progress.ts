import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContractConvergenceUpdate,
  ContractFindingLineage,
  ContractFindingLineageEntry,
} from "./contract-convergence.js";
import type {
  QAConvergenceState,
  QAConvergenceUpdate,
  QAFindingLineageEntry,
} from "./qa-convergence.js";
import {
  loadRunState,
  saveRunState,
  type RunState,
} from "./run-state.js";

export const INTERVENTION_FILENAME = "intervention.json";

export type ConvergencePhase =
  | "contract"
  | "deterministic-qa"
  | "shared-preview-uat";

export type InterventionClass =
  | "PRODUCT_DECISION"
  | "RECOVERY_ACTION"
  | "IMPLEMENTATION_INTERVENTION";

export type NonProgressReason =
  | "EQUIVALENT_REPETITION"
  | "REOPENED_WITHOUT_NEW_EVIDENCE"
  | "OSCILLATION"
  | "REGRESSION_GROWTH";

export interface PreservedCandidate {
  branch: string;
  treeId: string;
  phase: ConvergencePhase;
  revision: number;
}

export interface InterventionFinding {
  stableId: string;
  currentId: string;
  state: string;
  disposition: string;
  occurrences: number;
  summary: string;
  evidence: string;
  clearCondition: string;
  artifactReferences: string[];
}

export interface NonProgressObservation {
  phase: ConvergencePhase;
  revision: number;
  candidate: PreservedCandidate;
  activeBlockingIds: string[];
  repeatedBlockingIds: string[];
  reopenedWithoutNewEvidenceIds: string[];
  regressedBlockingIds: string[];
  findings: InterventionFinding[];
  supportingEvidence: string[];
}

export interface NonProgressHistory {
  version: 1;
  observations: NonProgressObservation[];
}

export interface InterventionRequest {
  version: 1;
  interventionClass: InterventionClass;
  phase: ConvergencePhase;
  reasonCodes: NonProgressReason[];
  blockerIds: string[];
  summary: string;
  findingLineage: InterventionFinding[];
  attemptedRepairs: Array<{
    phase: ConvergencePhase;
    revision: number;
    candidateTreeId: string;
    activeBlockingIds: string[];
  }>;
  preservedCandidate: PreservedCandidate;
  supportingEvidence: string[];
  requiredOperatorAction: string;
}

export type NonProgressDecision =
  | { action: "continue"; history: NonProgressHistory }
  | {
      action: "intervene";
      history: NonProgressHistory;
      request: InterventionRequest;
    };

interface Location {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

interface CandidateInput {
  branch: string;
  treeId: string;
}

const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_OBSERVATIONS = 12;

export function emptyNonProgressHistory(): NonProgressHistory {
  return { version: 1, observations: [] };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function evidenceKey(entry: {
  evidence: string;
  clearCondition: string;
  finding: { expected: string; observed: string; behaviorIds: string[] };
}): string {
  return JSON.stringify({
    evidence: entry.evidence.trim(),
    expected: entry.finding.expected.trim(),
    observed: entry.finding.observed.trim(),
    clearCondition: entry.clearCondition.trim(),
    behaviorIds: [...entry.finding.behaviorIds].sort(),
  });
}

function contractEntryEvidenceKey(entry: ContractFindingLineageEntry): string {
  return evidenceKey({
    evidence: entry.finding.evidence,
    clearCondition: entry.finding.clearCondition,
    finding: entry.finding,
  });
}

function qaEntryEvidenceKey(entry: QAFindingLineageEntry): string {
  return evidenceKey({
    evidence: entry.finding.evidence,
    clearCondition: entry.finding.clearCondition,
    finding: entry.finding,
  });
}

function equivalentIds<T extends { stableId: string; currentId: string }>(
  ids: readonly string[],
  before: readonly T[],
  after: readonly T[],
  keyOf: (entry: T) => string,
): string[] {
  const beforeByStable = new Map(before.map((entry) => [entry.stableId, entry]));
  const afterByCurrent = new Map(after.map((entry) => [entry.currentId, entry]));
  return sortedUnique(
    ids.filter((id) => {
      const current = afterByCurrent.get(id);
      const prior = current ? beforeByStable.get(current.stableId) : undefined;
      return current !== undefined && prior !== undefined &&
        keyOf(current) === keyOf(prior);
    }),
  );
}

function contractFinding(entry: ContractFindingLineageEntry): InterventionFinding {
  return {
    stableId: entry.stableId,
    currentId: entry.currentId,
    state: entry.finding.state,
    disposition: entry.disposition,
    occurrences: entry.occurrences,
    summary: entry.finding.observed,
    evidence: entry.finding.evidence,
    clearCondition: entry.finding.clearCondition,
    artifactReferences: entry.finding.revisionCitation
      ? [entry.finding.revisionCitation.artifact]
      : [],
  };
}

function qaFinding(entry: QAFindingLineageEntry): InterventionFinding {
  return {
    stableId: entry.stableId,
    currentId: entry.currentId,
    state: entry.finding.state,
    disposition: entry.disposition,
    occurrences: entry.occurrences,
    summary: entry.finding.summary,
    evidence: entry.finding.evidence,
    clearCondition: entry.finding.clearCondition,
    artifactReferences: [...entry.artifactReferences],
  };
}

function activeContractIds(entries: readonly ContractFindingLineageEntry[]): string[] {
  return sortedUnique(
    entries
      .filter(
        (entry) =>
          entry.finding.severity === "BLOCKING" &&
          (entry.finding.state === "OPEN" ||
            entry.finding.state === "CONTESTED"),
      )
      .map((entry) => entry.currentId),
  );
}

function activeQAIds(entries: readonly QAFindingLineageEntry[]): string[] {
  return sortedUnique(
    entries
      .filter(
        (entry) =>
          entry.finding.severity === "BLOCKING" &&
          entry.finding.state === "OPEN",
      )
      .map((entry) => entry.currentId),
  );
}

export function contractNonProgressObservation(input: {
  before: ContractFindingLineage;
  update: ContractConvergenceUpdate;
  candidate: CandidateInput;
  supportingEvidence?: readonly string[];
}): NonProgressObservation {
  const beforeEntries = Object.values(input.before.findings);
  const entries = Object.values(input.update.lineage.findings);
  const openIds = new Set(
    entries
      .filter((entry) => entry.finding.state === "OPEN")
      .map((entry) => entry.currentId),
  );
  return {
    phase: "contract",
    revision: input.update.lineage.revision,
    candidate: {
      ...input.candidate,
      phase: "contract",
      revision: input.update.lineage.revision,
    },
    activeBlockingIds: activeContractIds(entries),
    repeatedBlockingIds: equivalentIds(
      input.update.repeatedBlockingIds.filter((id) => openIds.has(id)),
      beforeEntries,
      entries,
      contractEntryEvidenceKey,
    ),
    reopenedWithoutNewEvidenceIds: equivalentIds(
      input.update.reopenedBlockingIds,
      beforeEntries,
      entries,
      contractEntryEvidenceKey,
    ),
    regressedBlockingIds: sortedUnique(input.update.regressedBlockingIds),
    findings: entries.map(contractFinding).sort((a, b) =>
      a.stableId.localeCompare(b.stableId),
    ),
    supportingEvidence: sortedUnique(input.supportingEvidence ?? []),
  };
}

export function qaNonProgressObservation(input: {
  before: QAConvergenceState;
  update: QAConvergenceUpdate;
  phase: Exclude<ConvergencePhase, "contract">;
  candidate: CandidateInput;
  supportingEvidence?: readonly string[];
}): NonProgressObservation {
  const stage =
    input.phase === "deterministic-qa" ? "deterministic" : "shared-preview";
  const beforeEntries = Object.values(input.before.findings).filter(
    (entry) => entry.stage === stage,
  );
  const entries = Object.values(input.update.state.findings).filter(
    (entry) => entry.stage === stage,
  );
  return {
    phase: input.phase,
    revision: input.update.state.revision,
    candidate: {
      ...input.candidate,
      phase: input.phase,
      revision: input.update.state.revision,
    },
    activeBlockingIds: activeQAIds(entries),
    repeatedBlockingIds: equivalentIds(
      input.update.repeatedBlockingIds,
      beforeEntries,
      entries,
      qaEntryEvidenceKey,
    ),
    reopenedWithoutNewEvidenceIds: equivalentIds(
      input.update.reopenedBlockingIds,
      beforeEntries,
      entries,
      qaEntryEvidenceKey,
    ),
    regressedBlockingIds: sortedUnique(input.update.regressedBlockingIds),
    findings: entries.map(qaFinding).sort((a, b) =>
      a.stableId.localeCompare(b.stableId),
    ),
    supportingEvidence: sortedUnique(input.supportingEvidence ?? []),
  };
}

function activeSignature(observation: NonProgressObservation): string {
  return observation.activeBlockingIds.join("|");
}

function findingStates(
  observation: NonProgressObservation,
): Map<string, string> {
  return new Map(
    observation.findings.map((finding) => [
      finding.stableId,
      finding.state,
    ]),
  );
}

function hasDispositionOscillation(
  twoBack: NonProgressObservation | undefined,
  previous: NonProgressObservation | undefined,
  current: NonProgressObservation,
): boolean {
  if (!twoBack || !previous) return false;
  const earlierStates = findingStates(twoBack);
  const previousStates = findingStates(previous);
  return current.findings.some((finding) => {
    const earlier = earlierStates.get(finding.stableId);
    const prior = previousStates.get(finding.stableId);
    return (
      earlier !== undefined &&
      prior !== undefined &&
      finding.state === earlier &&
      finding.state !== prior
    );
  });
}

function samePhaseHistory(
  history: NonProgressHistory,
  phase: ConvergencePhase,
): NonProgressObservation[] {
  return history.observations.filter((entry) => entry.phase === phase);
}

function reasonCodes(
  history: NonProgressHistory,
  observation: NonProgressObservation,
): NonProgressReason[] {
  const reasons: NonProgressReason[] = [];
  const phaseHistory = samePhaseHistory(history, observation.phase);
  const previous = phaseHistory.at(-1);
  const twoBack = phaseHistory.at(-2);
  if (
    previous &&
    observation.repeatedBlockingIds.length > 0 &&
    activeSignature(observation) === activeSignature(previous)
  ) {
    reasons.push("EQUIVALENT_REPETITION");
  }
  if (observation.reopenedWithoutNewEvidenceIds.length > 0) {
    reasons.push("REOPENED_WITHOUT_NEW_EVIDENCE");
  }
  if (hasDispositionOscillation(twoBack, previous, observation)) {
    reasons.push("OSCILLATION");
  }
  const priorRegressions = new Set(
    phaseHistory.flatMap((entry) => entry.regressedBlockingIds),
  );
  if (
    observation.regressedBlockingIds.some((id) => !priorRegressions.has(id))
  ) {
    reasons.push("REGRESSION_GROWTH");
  }
  return reasons;
}

function bestCandidate(
  history: NonProgressHistory,
  current: NonProgressObservation,
): PreservedCandidate {
  return [...samePhaseHistory(history, current.phase), current]
    .sort(
      (left, right) =>
        left.regressedBlockingIds.length - right.regressedBlockingIds.length ||
        left.activeBlockingIds.length - right.activeBlockingIds.length ||
        right.revision - left.revision,
    )[0]!.candidate;
}

function interventionClass(phase: ConvergencePhase): InterventionClass {
  return phase === "contract"
    ? "PRODUCT_DECISION"
    : "IMPLEMENTATION_INTERVENTION";
}

function requiredAction(
  kind: InterventionClass,
  blockerIds: readonly string[],
  candidate: PreservedCandidate,
): string {
  const blockers = blockerIds.join(", ");
  if (kind === "PRODUCT_DECISION") {
    return (
      `Clarify or decide the contract requirement behind ${blockers}, record ` +
      `that decision in the source issue, then resume from candidate tree ` +
      `${candidate.treeId}.`
    );
  }
  if (kind === "RECOVERY_ACTION") {
    return (
      `Restore or select candidate tree ${candidate.treeId}, then resume the ` +
      `recorded pending stage without changing the quality gates.`
    );
  }
  return (
    `Inspect ${blockers} on preserved candidate tree ${candidate.treeId}, make ` +
    `one targeted implementation repair that keeps resolved behavior intact, ` +
    `then resume the slice.`
  );
}

export function decideNonProgress(
  history: NonProgressHistory,
  observation: NonProgressObservation,
): NonProgressDecision {
  const reasons = reasonCodes(history, observation);
  const nextHistory: NonProgressHistory = {
    version: 1,
    observations: [...history.observations, observation].slice(
      -MAX_OBSERVATIONS,
    ),
  };
  if (reasons.length === 0) {
    return { action: "continue", history: nextHistory };
  }
  const blockers = sortedUnique([
    ...observation.repeatedBlockingIds,
    ...observation.reopenedWithoutNewEvidenceIds,
    ...observation.regressedBlockingIds,
    ...observation.activeBlockingIds,
  ]);
  const preservedCandidate = bestCandidate(history, observation);
  const kind = interventionClass(observation.phase);
  const phaseHistory = samePhaseHistory(nextHistory, observation.phase);
  const request: InterventionRequest = {
    version: 1,
    interventionClass: kind,
    phase: observation.phase,
    reasonCodes: reasons,
    blockerIds: blockers,
    summary:
      `AFK stopped ${observation.phase} before another equivalent dispatch: ` +
      `${reasons.join(", ")} for ${blockers.join(", ")}.`,
    findingLineage: observation.findings,
    attemptedRepairs: phaseHistory.map((entry) => ({
      phase: entry.phase,
      revision: entry.revision,
      candidateTreeId: entry.candidate.treeId,
      activeBlockingIds: [...entry.activeBlockingIds],
    })),
    preservedCandidate,
    supportingEvidence: sortedUnique([
      ...observation.supportingEvidence,
      ...observation.findings.flatMap((finding) =>
        finding.artifactReferences,
      ),
    ]),
    requiredOperatorAction: requiredAction(kind, blockers, preservedCandidate),
  };
  return { action: "intervene", history: nextHistory, request };
}

function historyMap(state: RunState): Record<string, unknown> | null {
  if (state.nonProgress === undefined) return null;
  if (
    !state.nonProgress ||
    typeof state.nonProgress !== "object" ||
    Array.isArray(state.nonProgress)
  ) {
    throw new Error("run state nonProgress must be an object when present");
  }
  return state.nonProgress as Record<string, unknown>;
}

export function parseNonProgressHistory(value: unknown): NonProgressHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted non-progress history must be an object");
  }
  const input = value as Partial<NonProgressHistory>;
  if (input.version !== 1 || !Array.isArray(input.observations)) {
    throw new Error(
      "persisted non-progress history must contain version 1 and observations",
    );
  }
  const validPhases: readonly ConvergencePhase[] = [
    "contract",
    "deterministic-qa",
    "shared-preview-uat",
  ];
  const stringArray = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every(
      (entry) => typeof entry === "string" && entry.trim() !== "",
    );
  for (const observation of input.observations) {
    if (
      !observation ||
      typeof observation !== "object" ||
      !validPhases.includes(observation.phase) ||
      !Number.isSafeInteger(observation.revision) ||
      observation.revision < 1 ||
      typeof observation.candidate?.branch !== "string" ||
      observation.candidate.branch.trim() === "" ||
      !TREE_ID.test(observation.candidate?.treeId ?? "") ||
      observation.candidate?.phase !== observation.phase ||
      observation.candidate?.revision !== observation.revision ||
      !stringArray(observation.activeBlockingIds) ||
      !stringArray(observation.repeatedBlockingIds) ||
      !stringArray(observation.reopenedWithoutNewEvidenceIds) ||
      !stringArray(observation.regressedBlockingIds) ||
      !stringArray(observation.supportingEvidence) ||
      !Array.isArray(observation.findings) ||
      observation.findings.some(
        (finding) =>
          !finding ||
          typeof finding !== "object" ||
          typeof finding.stableId !== "string" ||
          finding.stableId.trim() === "" ||
          typeof finding.currentId !== "string" ||
          finding.currentId.trim() === "" ||
          typeof finding.state !== "string" ||
          finding.state.trim() === "" ||
          typeof finding.disposition !== "string" ||
          finding.disposition.trim() === "" ||
          !Number.isSafeInteger(finding.occurrences) ||
          finding.occurrences < 1 ||
          typeof finding.summary !== "string" ||
          finding.summary.trim() === "" ||
          typeof finding.evidence !== "string" ||
          finding.evidence.trim() === "" ||
          typeof finding.clearCondition !== "string" ||
          finding.clearCondition.trim() === "" ||
          !stringArray(finding.artifactReferences),
      )
    ) {
      throw new Error("persisted non-progress observation is malformed");
    }
  }
  return structuredClone(input as NonProgressHistory);
}

export function loadNonProgressHistory(location: Location): NonProgressHistory {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const map = historyMap(state);
  if (!map || map[location.ghIssue] === undefined) {
    return emptyNonProgressHistory();
  }
  return parseNonProgressHistory(map[location.ghIssue]);
}

export function saveNonProgressHistory(
  location: Location,
  history: NonProgressHistory,
): void {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const existing = historyMap(state) ?? {};
  state.nonProgress = { ...existing, [location.ghIssue]: history };
  saveRunState(location.repoRoot, state);
}

export function writeInterventionRequest(
  sliceDir: string,
  request: InterventionRequest,
): string {
  const path = join(sliceDir, INTERVENTION_FILENAME);
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf-8");
  return path;
}
