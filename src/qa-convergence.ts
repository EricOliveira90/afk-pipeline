import {
  parseQAReview,
  type QAReview,
  type QAReviewAttemptFinding,
  type QAReviewFinding,
  type QAReviewStage,
} from "./qa-review.js";
import {
  loadRunState,
  saveRunState,
  type RunState,
} from "./run-state.js";

export type QAFindingDisposition =
  | "OPEN"
  | "RESOLVED"
  | "REPEATED"
  | "REOPENED"
  | "REGRESSED";

export interface QAFindingLineageEntry {
  stableId: string;
  currentId: string;
  stage: QAReviewStage;
  disposition: QAFindingDisposition;
  firstSeenRevision: number;
  lastSeenRevision: number;
  occurrences: number;
  candidateTreeId: string;
  finding: QAReviewFinding;
  artifactReferences: string[];
}

export interface QAConvergenceState {
  version: 1;
  extensionUsed: boolean;
  revision: number;
  findings: Record<string, QAFindingLineageEntry>;
}

export interface QAConvergenceUpdate {
  state: QAConvergenceState;
  freshBlockingIds: string[];
  repeatedBlockingIds: string[];
  reopenedBlockingIds: string[];
  regressedBlockingIds: string[];
}

export type QAFinalRepairDecision =
  | { action: "extend"; findingIds: string[] }
  | { action: "stop"; reason: string };

interface ConvergenceLocation {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DISPOSITIONS: readonly QAFindingDisposition[] = [
  "OPEN",
  "RESOLVED",
  "REPEATED",
  "REOPENED",
  "REGRESSED",
];

export function emptyQAConvergenceState(): QAConvergenceState {
  return {
    version: 1,
    extensionUsed: false,
    revision: 0,
    findings: {},
  };
}

function lineageKey(stage: QAReviewStage, stableId: string): string {
  return `${stage}:${stableId}`;
}

function findingFingerprint(finding: QAReviewFinding): string {
  return JSON.stringify({
    severity: finding.severity,
    behaviorIds: [...finding.behaviorIds].sort(),
    expected: finding.expected.trim(),
    clearCondition: finding.clearCondition.trim(),
    remedy: finding.remedy,
    amendmentPaths: [...finding.amendmentPaths].sort(),
  });
}

function cloneFinding(finding: QAReviewFinding): QAReviewFinding {
  return {
    ...finding,
    behaviorIds: [...finding.behaviorIds],
    amendmentPaths: [...finding.amendmentPaths],
  };
}

function cloneState(state: QAConvergenceState): QAConvergenceState {
  return {
    version: 1,
    extensionUsed: state.extensionUsed,
    revision: state.revision,
    findings: Object.fromEntries(
      Object.entries(state.findings).map(([key, entry]) => [
        key,
        {
          ...entry,
          finding: cloneFinding(entry.finding),
          artifactReferences: [...entry.artifactReferences],
        },
      ]),
    ),
  };
}

function stageEntries(
  state: QAConvergenceState,
  stage: QAReviewStage,
): QAFindingLineageEntry[] {
  return Object.values(state.findings).filter(
    (entry) => entry.stage === stage,
  );
}

function matchingPriorEntry(
  entries: readonly QAFindingLineageEntry[],
  finding: QAReviewFinding,
): QAFindingLineageEntry | undefined {
  return (
    entries.find((entry) => entry.currentId === finding.id) ??
    entries.find(
      (entry) =>
        findingFingerprint(entry.finding) === findingFingerprint(finding),
    )
  );
}

/**
 * A fresh invocation may not erase a durable open finding. Stable IDs are
 * authoritative, while the deterministic fingerprint catches an evaluator
 * that renames the same obligation.
 */
export function validateQAReviewAgainstLineage(
  state: QAConvergenceState,
  stage: QAReviewStage,
  review: QAReview,
): void {
  if (review.failureClass === "INFRASTRUCTURE") return;
  const entries = stageEntries(state, stage);
  const omitted = entries
    .filter((entry) => entry.finding.state === "OPEN")
    .filter(
      (entry) =>
        !review.findings.some(
          (finding) =>
            finding.id === entry.currentId ||
            findingFingerprint(finding) ===
              findingFingerprint(entry.finding),
        ),
    )
    .map((entry) => entry.currentId);
  if (omitted.length > 0) {
    throw new Error(
      `QA review omitted durable open finding${omitted.length === 1 ? "" : "s"} ` +
        omitted.join(", "),
    );
  }
}

/**
 * Fold one validated QA attempt into compact durable lineage.
 */
export function advanceQAFindingLineage(
  prior: QAConvergenceState,
  details: {
    stage: QAReviewStage;
    review: QAReview;
    attemptFindings: readonly QAReviewAttemptFinding[];
    candidateTreeId: string;
    /**
     * Upgrade bridge for a resumed run whose archived lifecycle predates
     * durable QA convergence state. Only matching IDs may start RESOLVED.
     */
    restoredOpenFindings?: readonly QAReviewAttemptFinding[];
  },
): QAConvergenceUpdate {
  if (!TREE_ID.test(details.candidateTreeId)) {
    throw new Error("QA convergence requires a valid candidate tree identity");
  }
  validateQAReviewAgainstLineage(prior, details.stage, details.review);
  if (details.review.failureClass === "INFRASTRUCTURE") {
    return {
      state: prior,
      freshBlockingIds: [],
      repeatedBlockingIds: [],
      reopenedBlockingIds: [],
      regressedBlockingIds: [],
    };
  }

  const state = cloneState(prior);
  const revision = prior.revision + 1;
  state.revision = revision;
  const entries = stageEntries(state, details.stage);
  const attemptById = new Map(
    details.attemptFindings.map((finding) => [finding.id, finding]),
  );
  const restoredOpenIds = new Set(
    (details.restoredOpenFindings ?? []).map(({ id }) => id),
  );
  const freshBlockingIds: string[] = [];
  const repeatedBlockingIds: string[] = [];
  const reopenedBlockingIds: string[] = [];
  const regressedBlockingIds: string[] = [];

  for (const finding of details.review.findings) {
    const priorEntry = matchingPriorEntry(entries, finding);
    if (
      !priorEntry &&
      finding.state === "RESOLVED" &&
      !restoredOpenIds.has(finding.id)
    ) {
      throw new Error(
        `QA review fresh finding ${finding.id} must start as OPEN`,
      );
    }
    const stableId = priorEntry?.stableId ?? finding.id;
    let disposition: QAFindingDisposition = finding.state;
    if (finding.state === "OPEN" && priorEntry) {
      if (priorEntry.finding.state === "RESOLVED") {
        disposition =
          priorEntry.currentId === finding.id ? "REOPENED" : "REGRESSED";
      } else {
        disposition = "REPEATED";
      }
    }
    const attemptFinding = attemptById.get(finding.id);
    if (!attemptFinding) {
      throw new Error(
        `QA lifecycle record omitted canonical finding ${finding.id}`,
      );
    }
    const entry: QAFindingLineageEntry = {
      stableId,
      currentId: finding.id,
      stage: details.stage,
      disposition,
      firstSeenRevision: priorEntry?.firstSeenRevision ?? revision,
      lastSeenRevision: revision,
      occurrences: (priorEntry?.occurrences ?? 0) + 1,
      candidateTreeId: details.candidateTreeId,
      finding: cloneFinding(finding),
      artifactReferences: [...attemptFinding.artifactReferences],
    };
    state.findings[lineageKey(details.stage, stableId)] = entry;

    if (finding.severity !== "BLOCKING" || finding.state !== "OPEN") {
      continue;
    }
    if (!priorEntry) freshBlockingIds.push(finding.id);
    if (disposition === "REPEATED") repeatedBlockingIds.push(finding.id);
    if (disposition === "REOPENED") reopenedBlockingIds.push(finding.id);
    if (disposition === "REGRESSED") regressedBlockingIds.push(finding.id);
  }

  return {
    state,
    freshBlockingIds,
    repeatedBlockingIds,
    reopenedBlockingIds,
    regressedBlockingIds,
  };
}

function overlaps(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightIds = new Set(right);
  return left.some((id) => rightIds.has(id));
}

/**
 * Generator memory stays compact: active source-change findings plus only
 * resolved source-change findings whose behavior scope overlaps active work.
 */
export function qaGeneratorContext(
  state: QAConvergenceState,
  stage?: QAReviewStage,
): {
  open: QAFindingLineageEntry[];
  relevantResolved: QAFindingLineageEntry[];
} {
  const entries = Object.values(state.findings).filter(
    (entry) =>
      entry.finding.remedy === "SOURCE_CHANGE" &&
      (stage === undefined || entry.stage === stage),
  );
  const open = entries.filter((entry) => entry.finding.state === "OPEN");
  const relevantResolved = entries.filter(
    (entry) =>
      entry.finding.state === "RESOLVED" &&
      open.some((active) =>
        overlaps(active.finding.behaviorIds, entry.finding.behaviorIds),
      ),
  );
  return { open, relevantResolved };
}

function formatEntry(entry: QAFindingLineageEntry): string {
  return [
    `- Finding ID: \`${entry.currentId}\``,
    `  QA stage: ${entry.stage}`,
    `  Disposition: ${entry.disposition}`,
    `  Severity: ${entry.finding.severity}`,
    `  State: ${entry.finding.state}`,
    `  Unresolved: ${entry.finding.state === "OPEN" ? "yes" : "no"}`,
    `  Remedy: ${entry.finding.remedy}`,
    `  Summary: ${entry.finding.summary}`,
    `  Expected: ${entry.finding.expected}`,
    `  Observed: ${entry.finding.observed}`,
    `  Clear condition: ${entry.finding.clearCondition}`,
    "  Artifact references:",
    ...entry.artifactReferences.map((path) => `  - \`${path}\``),
  ].join("\n");
}

export function formatQAGeneratorContext(
  state: QAConvergenceState,
  gateFailureReferences: readonly string[] = [],
  stage?: QAReviewStage,
): string {
  const context = qaGeneratorContext(state, stage);
  const sections: string[] = [];
  if (gateFailureReferences.length > 0) {
    sections.push(
      [
        "Current deterministic gate failures:",
        ...gateFailureReferences.map((path) => `- \`${path}\``),
      ].join("\n"),
    );
  }
  if (context.open.length > 0) {
    sections.push(
      [
        "Current open QA findings:",
        ...context.open.map(formatEntry),
      ].join("\n"),
    );
  }
  if (context.relevantResolved.length > 0) {
    sections.push(
      [
        "Relevant resolved QA findings — keep these behaviors satisfied:",
        ...context.relevantResolved.map(formatEntry),
      ].join("\n"),
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : "(none)";
}

export function qaLifecycleHistory(
  state: QAConvergenceState,
  stage: QAReviewStage,
): Array<{ id: string; state: "OPEN" | "RESOLVED" }> {
  return stageEntries(state, stage).map((entry) => ({
    id: entry.currentId,
    state: entry.finding.state,
  }));
}

/**
 * A scope amendment is orchestrator-owned. Once it lands, durable memory must
 * not route the request to a resumed generator.
 */
export function resolveQAScopeAmendments(
  prior: QAConvergenceState,
  stage: QAReviewStage,
  findingIds: readonly string[],
): QAConvergenceState {
  const state = cloneState(prior);
  const ids = new Set(findingIds);
  for (const entry of stageEntries(state, stage)) {
    if (!ids.has(entry.currentId)) continue;
    entry.disposition = "RESOLVED";
    entry.finding.state = "RESOLVED";
  }
  return state;
}

export function decideQAFinalRepair(input: {
  before: QAConvergenceState;
  update: QAConvergenceUpdate;
  review: QAReview;
  stage: QAReviewStage;
  candidateTreeId: string;
}): QAFinalRepairDecision {
  if (input.before.extensionUsed) {
    return {
      action: "stop",
      reason: "the one candidate-QA final repair was already used",
    };
  }
  if (
    input.review.verdict !== "FAIL" ||
    input.review.failureClass !== "IMPLEMENTATION"
  ) {
    return {
      action: "stop",
      reason: "the final QA result was not an implementation failure",
    };
  }
  if (input.update.repeatedBlockingIds.length > 0) {
    return {
      action: "stop",
      reason: `blocking findings repeated: ${input.update.repeatedBlockingIds.join(", ")}`,
    };
  }
  if (input.update.reopenedBlockingIds.length > 0) {
    return {
      action: "stop",
      reason: `resolved blocking findings reopened: ${input.update.reopenedBlockingIds.join(", ")}`,
    };
  }
  if (input.update.regressedBlockingIds.length > 0) {
    return {
      action: "stop",
      reason: `resolved behavior regressed: ${input.update.regressedBlockingIds.join(", ")}`,
    };
  }

  const unresolvedEarlier = Object.values(input.before.findings)
    .filter(
      (entry) =>
        entry.finding.severity === "BLOCKING" &&
        entry.finding.state === "OPEN",
    )
    .filter((entry) => {
      const current = input.update.state.findings[
        lineageKey(entry.stage, entry.stableId)
      ];
      return current?.finding.state === "OPEN";
    })
    .map((entry) => entry.currentId);
  if (unresolvedEarlier.length > 0) {
    return {
      action: "stop",
      reason: `earlier blocking findings remain unresolved: ${unresolvedEarlier.join(", ")}`,
    };
  }

  const fresh = new Set(input.update.freshBlockingIds);
  const activeBlocking = Object.values(input.update.state.findings).filter(
    (entry) =>
      entry.stage === input.stage &&
      entry.lastSeenRevision === input.update.state.revision &&
      entry.finding.severity === "BLOCKING" &&
      entry.finding.state === "OPEN",
  );
  if (activeBlocking.length === 0) {
    return { action: "stop", reason: "no actionable final blocker exists" };
  }
  const unqualified = activeBlocking.filter(
    (entry) =>
      !fresh.has(entry.currentId) ||
      entry.finding.remedy !== "SOURCE_CHANGE" ||
      entry.candidateTreeId !== input.candidateTreeId,
  );
  if (unqualified.length > 0) {
    return {
      action: "stop",
      reason:
        "final blockers are not genuinely fresh source-change findings " +
        `on the current candidate: ${unqualified
          .map((entry) => entry.currentId)
          .join(", ")}`,
    };
  }
  return {
    action: "extend",
    findingIds: activeBlocking.map((entry) => entry.currentId),
  };
}

export function markQAFinalRepairUsed(
  state: QAConvergenceState,
): QAConvergenceState {
  return { ...cloneState(state), extensionUsed: true };
}

export function hasPendingQAFinalRepair(input: {
  state: QAConvergenceState;
  nextRound: number;
  normalRoundLimit: number;
}): boolean {
  return (
    input.state.extensionUsed &&
    input.nextRound === input.normalRoundLimit + 1
  );
}

function convergenceMap(
  state: RunState,
): Record<string, unknown> | null {
  const value = state.qaConvergence;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "run state qaConvergence must be an object when present",
    );
  }
  return value as Record<string, unknown>;
}

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(
      `persisted QA finding lineage ${field} must be an integer >= ${minimum}`,
    );
  }
  return value as number;
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `persisted QA finding lineage ${field} must be a non-blank string`,
    );
  }
  return value;
}

export function parseQAConvergenceState(
  value: unknown,
): QAConvergenceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted QA finding lineage must be an object");
  }
  const input = value as Partial<QAConvergenceState>;
  if (
    input.version !== 1 ||
    typeof input.extensionUsed !== "boolean" ||
    !input.findings ||
    typeof input.findings !== "object" ||
    Array.isArray(input.findings)
  ) {
    throw new Error(
      "persisted QA finding lineage must contain version 1, extensionUsed, revision, and findings",
    );
  }
  const revision = requireSafeInteger(input.revision, "revision", 0);
  const findings: Record<string, QAFindingLineageEntry> = {};
  for (const [key, raw] of Object.entries(
    input.findings as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `persisted QA finding lineage finding ${key} must be an object`,
      );
    }
    const entry = raw as Partial<QAFindingLineageEntry>;
    const stableId = requireNonBlank(entry.stableId, `${key}.stableId`);
    const currentId = requireNonBlank(entry.currentId, `${key}.currentId`);
    if (
      entry.stage !== "deterministic" &&
      entry.stage !== "shared-preview"
    ) {
      throw new Error(
        `persisted QA finding lineage ${key}.stage is invalid`,
      );
    }
    if (key !== lineageKey(entry.stage, stableId)) {
      throw new Error(
        `persisted QA finding lineage key ${key} must match stage and stableId`,
      );
    }
    if (
      typeof entry.disposition !== "string" ||
      !DISPOSITIONS.includes(entry.disposition as QAFindingDisposition)
    ) {
      throw new Error(
        `persisted QA finding lineage ${key}.disposition is invalid`,
      );
    }
    const firstSeenRevision = requireSafeInteger(
      entry.firstSeenRevision,
      `${key}.firstSeenRevision`,
      1,
    );
    const lastSeenRevision = requireSafeInteger(
      entry.lastSeenRevision,
      `${key}.lastSeenRevision`,
      firstSeenRevision,
    );
    if (lastSeenRevision > revision) {
      throw new Error(
        `persisted QA finding lineage ${key}.lastSeenRevision exceeds revision`,
      );
    }
    const occurrences = requireSafeInteger(
      entry.occurrences,
      `${key}.occurrences`,
      1,
    );
    const candidateTreeId = requireNonBlank(
      entry.candidateTreeId,
      `${key}.candidateTreeId`,
    );
    if (!TREE_ID.test(candidateTreeId)) {
      throw new Error(
        `persisted QA finding lineage ${key}.candidateTreeId is invalid`,
      );
    }
    if (
      !Array.isArray(entry.artifactReferences) ||
      entry.artifactReferences.length !== 2 ||
      entry.artifactReferences.some(
        (reference) =>
          typeof reference !== "string" || reference.trim() === "",
      )
    ) {
      throw new Error(
        `persisted QA finding lineage ${key}.artifactReferences must contain two non-blank strings`,
      );
    }
    const rawFinding = entry.finding;
    const blockingOpen =
      rawFinding?.severity === "BLOCKING" &&
      rawFinding.state === "OPEN";
    const finding = parseQAReview(
      JSON.stringify({
        version: 2,
        verdict: blockingOpen ? "FAIL" : "PASS",
        failureClass: blockingOpen ? "IMPLEMENTATION" : "NONE",
        infrastructureEvidence: null,
        findings: [rawFinding],
      }),
      `persisted QA finding lineage ${key}.finding`,
    ).findings[0]!;
    if (finding.id !== currentId) {
      throw new Error(
        `persisted QA finding lineage ${key}.currentId must match finding id ${finding.id}`,
      );
    }
    findings[key] = {
      stableId,
      currentId,
      stage: entry.stage,
      disposition: entry.disposition as QAFindingDisposition,
      firstSeenRevision,
      lastSeenRevision,
      occurrences,
      candidateTreeId,
      finding,
      artifactReferences: [...entry.artifactReferences],
    };
  }
  return {
    version: 1,
    extensionUsed: input.extensionUsed,
    revision,
    findings,
  };
}

export function loadQAConvergenceState(
  location: ConvergenceLocation,
): QAConvergenceState {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const map = convergenceMap(state);
  if (!map || map[location.ghIssue] === undefined) {
    return emptyQAConvergenceState();
  }
  return parseQAConvergenceState(map[location.ghIssue]);
}

export function saveQAConvergenceState(
  location: ConvergenceLocation,
  convergence: QAConvergenceState,
): void {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const existing = convergenceMap(state) ?? {};
  state.qaConvergence = {
    ...existing,
    [location.ghIssue]: convergence,
  };
  saveRunState(location.repoRoot, state);
}
