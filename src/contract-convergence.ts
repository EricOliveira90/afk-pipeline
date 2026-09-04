import type {
  ContractReview,
  ContractReviewFinding,
} from "./contract-review.js";
import { parseContractReview } from "./contract-review.js";
import {
  loadRunState,
  saveRunState,
  type RunState,
} from "./run-state.js";

export type ContractFindingDisposition =
  | "OPEN"
  | "RESOLVED"
  | "REPEATED"
  | "REOPENED"
  | "REGRESSED"
  | "CONTESTED"
  | "WITHDRAWN";

export interface ContractFindingLineageEntry {
  stableId: string;
  currentId: string;
  disposition: ContractFindingDisposition;
  firstSeenRevision: number;
  lastSeenRevision: number;
  occurrences: number;
  finding: ContractReviewFinding;
}

export interface ContractFindingLineage {
  version: 1;
  extensionUsed: boolean;
  revision: number;
  findings: Record<string, ContractFindingLineageEntry>;
}

export interface ContractConvergenceUpdate {
  lineage: ContractFindingLineage;
  freshBlockingIds: string[];
  repeatedBlockingIds: string[];
  reopenedBlockingIds: string[];
  regressedBlockingIds: string[];
}

export type ContractContinuationDecision =
  | { action: "extend"; findingIds: string[] }
  | { action: "stop"; reason: string };

interface LineageLocation {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

const ACTIVE_STATES = new Set(["OPEN", "CONTESTED"]);
const TERMINAL_STATES = new Set(["RESOLVED", "WITHDRAWN"]);

export function emptyContractFindingLineage(): ContractFindingLineage {
  return {
    version: 1,
    extensionUsed: false,
    revision: 0,
    findings: {},
  };
}

function findingFingerprint(finding: ContractReviewFinding): string {
  return JSON.stringify({
    severity: finding.severity,
    behaviorIds: [...finding.behaviorIds].sort(),
    expected: finding.expected.trim(),
    clearCondition: finding.clearCondition.trim(),
  });
}

function isActive(finding: ContractReviewFinding): boolean {
  return ACTIVE_STATES.has(finding.state);
}

function isTerminal(entry: ContractFindingLineageEntry): boolean {
  return TERMINAL_STATES.has(entry.finding.state);
}

function directDisposition(
  finding: ContractReviewFinding,
): ContractFindingDisposition {
  return finding.state;
}

function activeDisposition(
  prior: ContractFindingLineageEntry,
  finding: ContractReviewFinding,
): ContractFindingDisposition {
  if (isTerminal(prior)) {
    return prior.currentId === finding.id ? "REOPENED" : "REGRESSED";
  }
  return "REPEATED";
}

function cloneLineage(
  lineage: ContractFindingLineage,
): ContractFindingLineage {
  return {
    version: 1,
    extensionUsed: lineage.extensionUsed,
    revision: lineage.revision,
    findings: Object.fromEntries(
      Object.entries(lineage.findings).map(([id, entry]) => [
        id,
        {
          ...entry,
          finding: {
            ...entry.finding,
            behaviorIds: [...entry.finding.behaviorIds],
            revisionCitation: entry.finding.revisionCitation
              ? { ...entry.finding.revisionCitation }
              : null,
          },
        },
      ]),
    ),
  };
}

/**
 * Fold one validated evaluator review into the compact per-slice lineage.
 * IDs are authoritative; the deterministic fingerprint catches a provider
 * that renames the same obligation and classifies it as repetition or
 * regression instead of rewarding it as fresh.
 */
export function advanceContractFindingLineage(
  prior: ContractFindingLineage,
  review: ContractReview,
): ContractConvergenceUpdate {
  const lineage = cloneLineage(prior);
  const revision = prior.revision + 1;
  lineage.revision = revision;

  const byCurrentId = new Map(
    Object.values(lineage.findings).map((entry) => [entry.currentId, entry]),
  );
  const byFingerprint = new Map(
    Object.values(lineage.findings).map((entry) => [
      findingFingerprint(entry.finding),
      entry,
    ]),
  );
  const freshBlockingIds: string[] = [];
  const repeatedBlockingIds: string[] = [];
  const reopenedBlockingIds: string[] = [];
  const regressedBlockingIds: string[] = [];

  for (const finding of review.findings) {
    const priorEntry =
      byCurrentId.get(finding.id) ??
      byFingerprint.get(findingFingerprint(finding));
    const stableId = priorEntry?.stableId ?? finding.id;
    const disposition =
      priorEntry && isActive(finding)
        ? activeDisposition(priorEntry, finding)
        : directDisposition(finding);
    const entry: ContractFindingLineageEntry = {
      stableId,
      currentId: finding.id,
      disposition,
      firstSeenRevision: priorEntry?.firstSeenRevision ?? revision,
      lastSeenRevision: revision,
      occurrences: (priorEntry?.occurrences ?? 0) + 1,
      finding: {
        ...finding,
        behaviorIds: [...finding.behaviorIds],
        revisionCitation: finding.revisionCitation
          ? { ...finding.revisionCitation }
          : null,
      },
    };
    lineage.findings[stableId] = entry;
    byCurrentId.set(finding.id, entry);
    byFingerprint.set(findingFingerprint(finding), entry);

    if (finding.severity !== "BLOCKING" || !isActive(finding)) continue;
    if (!priorEntry) freshBlockingIds.push(finding.id);
    if (disposition === "REPEATED") repeatedBlockingIds.push(finding.id);
    if (disposition === "REOPENED") reopenedBlockingIds.push(finding.id);
    if (disposition === "REGRESSED") regressedBlockingIds.push(finding.id);
  }

  return {
    lineage,
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
 * Planner memory is deliberately small: every currently active finding,
 * plus resolved/withdrawn blockers whose behavior scope overlaps an active
 * finding. Unrelated closed history stays durable but leaves the prompt.
 */
export function contractPlannerContext(
  lineage: ContractFindingLineage,
): {
  open: ContractReviewFinding[];
  relevantResolved: ContractReviewFinding[];
} {
  const entries = Object.values(lineage.findings);
  const openEntries = entries.filter((entry) => isActive(entry.finding));
  const open = openEntries.map((entry) => entry.finding);
  const relevantResolved = entries
    .filter(
      (entry) =>
        entry.finding.severity === "BLOCKING" &&
        TERMINAL_STATES.has(entry.finding.state) &&
        openEntries.some((active) =>
          overlaps(active.finding.behaviorIds, entry.finding.behaviorIds),
        ),
    )
    .map((entry) => entry.finding);
  return { open, relevantResolved };
}

/**
 * A fresh process may restart negotiation at local round 1, but it may not
 * erase blockers that were still open in durable lineage. The review must
 * disposition each one under the same ID or the same deterministic identity.
 */
export function validateContractReviewAgainstLineage(
  lineage: ContractFindingLineage,
  review: ContractReview,
): void {
  const currentIds = new Set(review.findings.map(({ id }) => id));
  const currentFingerprints = new Set(
    review.findings.map((finding) => findingFingerprint(finding)),
  );
  const omitted = Object.values(lineage.findings)
    .filter(
      (entry) =>
        entry.finding.severity === "BLOCKING" && isActive(entry.finding),
    )
    .filter(
      (entry) =>
        !currentIds.has(entry.currentId) &&
        !currentFingerprints.has(findingFingerprint(entry.finding)),
    )
    .map((entry) => entry.currentId);
  if (omitted.length > 0) {
    throw new Error(
      `contract-review.json omitted durable open finding${omitted.length === 1 ? "" : "s"} ` +
        omitted.join(", "),
    );
  }
}

/**
 * Decide the one narrow response beyond the configured normal cap.
 * Validation of the changed-text citation remains in contract-review.ts;
 * this policy only consumes the resulting structured evidence.
 */
export function decideContractContinuation(input: {
  before: ContractFindingLineage;
  update: ContractConvergenceUpdate;
  review: ContractReview;
  gateObjection: boolean;
  revisionCitationValidated: boolean;
}): ContractContinuationDecision {
  if (input.gateObjection) {
    return { action: "stop", reason: "the final contract was gate-refused" };
  }
  if (input.before.extensionUsed) {
    return {
      action: "stop",
      reason: "the one contract convergence extension was already used",
    };
  }
  if (input.review.verdict !== "REVISE") {
    return { action: "stop", reason: "the final review was not REVISE" };
  }
  if (!input.revisionCitationValidated) {
    return {
      action: "stop",
      reason: "the final review has no validated changed-text revision",
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
      reason:
        `resolved blocking findings reopened without new evidence: ` +
        input.update.reopenedBlockingIds.join(", "),
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
        entry.finding.severity === "BLOCKING" && isActive(entry.finding),
    )
    .filter((entry) => {
      const current = input.update.lineage.findings[entry.stableId];
      return current !== undefined && isActive(current.finding);
    })
    .map((entry) => entry.currentId);
  if (unresolvedEarlier.length > 0) {
    return {
      action: "stop",
      reason: `earlier blocking findings remain unresolved: ${unresolvedEarlier.join(", ")}`,
    };
  }

  const activeBlocking = input.review.findings.filter(
    (finding) => finding.severity === "BLOCKING" && isActive(finding),
  );
  if (activeBlocking.length === 0) {
    return { action: "stop", reason: "no actionable final blocker exists" };
  }
  const fresh = new Set(input.update.freshBlockingIds);
  const unqualified = activeBlocking.filter(
    (finding) =>
      !fresh.has(finding.id) ||
      finding.state !== "OPEN" ||
      finding.revisionCitation === null,
  );
  if (unqualified.length > 0) {
    return {
      action: "stop",
      reason:
        `final blockers are not genuinely fresh changed-text findings: ` +
        unqualified.map(({ id }) => id).join(", "),
    };
  }
  return {
    action: "extend",
    findingIds: activeBlocking.map(({ id }) => id),
  };
}

function convergenceMap(
  state: RunState,
): Record<string, unknown> | null {
  const value = state.contractConvergence;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "run state contractConvergence must be an object when present",
    );
  }
  return value as Record<string, unknown>;
}

const LINEAGE_DISPOSITIONS: readonly ContractFindingDisposition[] = [
  "OPEN",
  "RESOLVED",
  "REPEATED",
  "REOPENED",
  "REGRESSED",
  "CONTESTED",
  "WITHDRAWN",
];

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(
      `persisted contract finding lineage ${field} must be an integer >= ${minimum}`,
    );
  }
  return value as number;
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `persisted contract finding lineage ${field} must be a non-blank string`,
    );
  }
  return value;
}

/**
 * Parse durable lineage fail-closed. Once the key exists, malformed root or
 * nested data is an operator-visible state defect, never an empty history.
 */
export function parseContractFindingLineage(
  value: unknown,
): ContractFindingLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted contract finding lineage must be an object");
  }
  const input = value as Partial<ContractFindingLineage>;
  if (
    input.version !== 1 ||
    typeof input.extensionUsed !== "boolean" ||
    !input.findings ||
    typeof input.findings !== "object" ||
    Array.isArray(input.findings)
  ) {
    throw new Error(
      "persisted contract finding lineage must contain version 1, extensionUsed, revision, and findings",
    );
  }
  const revision = requireSafeInteger(input.revision, "revision", 0);
  const findings: Record<string, ContractFindingLineageEntry> = {};
  for (const [key, raw] of Object.entries(
    input.findings as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `persisted contract finding lineage finding ${key} must be an object`,
      );
    }
    const entry = raw as Partial<ContractFindingLineageEntry>;
    const stableId = requireNonBlank(entry.stableId, `${key}.stableId`);
    const currentId = requireNonBlank(entry.currentId, `${key}.currentId`);
    if (stableId !== key) {
      throw new Error(
        `persisted contract finding lineage key ${key} must match stableId ${stableId}`,
      );
    }
    if (
      typeof entry.disposition !== "string" ||
      !LINEAGE_DISPOSITIONS.includes(
        entry.disposition as ContractFindingDisposition,
      )
    ) {
      throw new Error(
        `persisted contract finding lineage ${key}.disposition is invalid`,
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
        `persisted contract finding lineage ${key}.lastSeenRevision exceeds revision`,
      );
    }
    const occurrences = requireSafeInteger(
      entry.occurrences,
      `${key}.occurrences`,
      1,
    );
    const rawFinding = entry.finding;
    const activeBlocking =
      rawFinding?.severity === "BLOCKING" &&
      (rawFinding.state === "OPEN" || rawFinding.state === "CONTESTED");
    const finding = parseContractReview(
      JSON.stringify({
        version: 2,
        verdict: activeBlocking ? "REVISE" : "ACCEPT",
        findings: [rawFinding],
      }),
      `persisted contract finding lineage ${key}.finding`,
    ).findings[0]!;
    if (finding.id !== currentId) {
      throw new Error(
        `persisted contract finding lineage ${key}.currentId must match finding id ${finding.id}`,
      );
    }
    findings[key] = {
      stableId,
      currentId,
      disposition: entry.disposition as ContractFindingDisposition,
      firstSeenRevision,
      lastSeenRevision,
      occurrences,
      finding,
    };
  }
  return {
    version: 1,
    extensionUsed: input.extensionUsed,
    revision,
    findings,
  };
}

export function loadContractFindingLineage(
  location: LineageLocation,
): ContractFindingLineage {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const map = convergenceMap(state);
  if (!map || map[location.ghIssue] === undefined) {
    return emptyContractFindingLineage();
  }
  return parseContractFindingLineage(map[location.ghIssue]);
}

export function saveContractFindingLineage(
  location: LineageLocation,
  lineage: ContractFindingLineage,
): void {
  const state = loadRunState(location.repoRoot, location.prdSlug);
  const existing = convergenceMap(state) ?? {};
  state.contractConvergence = {
    ...existing,
    [location.ghIssue]: lineage,
  };
  saveRunState(location.repoRoot, state);
}
