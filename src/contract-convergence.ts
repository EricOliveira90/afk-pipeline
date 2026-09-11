import type {
  ContractReview,
  ContractReviewFinding,
} from "./contract-review.js";
import {
  ACTIVE_CONTRACT_FINDING_STATES,
  parseContractReview,
} from "./contract-review.js";
import { idMatchIsCorroborated } from "./guardian-convergence.js";
import {
  loadRunState,
  updateRunState,
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
  /**
   * The provider-qualified run slug, not the bare PRD slug (#178). Durable
   * lineage lives in the same `.afk/state/<run-slug>.json` file as the run's
   * scope, slice records and resume counters. Keying it on the bare slug split
   * a codex or claude run's memory across two state files: `afk clean-failed`,
   * the resume counters and an operator editing "the" state file all reached a
   * different file than the tamper guard's memory.
   *
   * The move is a key change, not a schema change — nothing about the
   * persisted shape or version differs — so a build on either side of it
   * reads an *empty* lineage from the other's file rather than failing.
   * {@link findOrphanedContractLineage} exists to make that one silent case
   * loud; see ADR 0061.
   */
  runSlug: string;
  ghIssue: string;
}

// One set, shared with the informing side. See ACTIVE_CONTRACT_FINDING_STATES.
const ACTIVE_STATES = ACTIVE_CONTRACT_FINDING_STATES;
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
 * The deterministic fingerprint catches a provider that renames the same
 * obligation and classifies it as repetition or regression instead of rewarding
 * it as fresh.
 *
 * An ID match is authoritative only while it is corroborated
 * ({@link idMatchIsCorroborated}): the fingerprint agrees, or the prior entry
 * is still live. Within one negotiation the evaluator numbers consistently and
 * restates a live finding's `expected` and `clearCondition` freely as the round
 * moves — measured on the recorded PRD 4 reviews, 32 of 43 same-ID
 * continuations rewrote one or the other — so a live prior keeps ID precedence.
 * A *terminal* entry's ID carries no such warrant. Across a restart-from-base
 * the evaluator renumbers from `F-01` while durable lineage keeps the previous
 * pass's IDs, so a fresh finding lands on a spent, already-RESOLVED number and
 * used to be folded onto it as REOPENED — two of those trip OSCILLATION and
 * kill negotiation at round 1 (#240).
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

  // A fresh finding whose ID is spent may not take the spent identity's key:
  // that would overwrite the terminal entry and erase the history the reopen
  // and regression rules read.
  const mintStableId = (id: string): string => {
    if (lineage.findings[id] === undefined) return id;
    for (let n = 2; ; n++) {
      const candidate = `${id}-${n}`;
      if (lineage.findings[candidate] === undefined) return candidate;
    }
  };

  for (const finding of review.findings) {
    const fingerprint = findingFingerprint(finding);
    const idMatch = byCurrentId.get(finding.id);
    const corroboratedIdMatch =
      idMatch !== undefined &&
      idMatchIsCorroborated({
        fingerprintAgrees: findingFingerprint(idMatch.finding) === fingerprint,
        priorIsLive: !isTerminal(idMatch),
      });
    const priorEntry = corroboratedIdMatch
      ? idMatch
      : byFingerprint.get(fingerprint);
    const stableId = priorEntry?.stableId ?? mintStableId(finding.id);
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
    byFingerprint.set(fingerprint, entry);

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
  const state = loadRunState(location.repoRoot, location.runSlug);
  const map = convergenceMap(state);
  if (!map || map[location.ghIssue] === undefined) {
    return emptyContractFindingLineage();
  }
  return parseContractFindingLineage(map[location.ghIssue]);
}

/**
 * Lineage a pre-#178 build left in the bare-PRD-slug state file that this
 * run's provider-qualified file does not hold — or `null` when there is no
 * such split. Returns an operator-facing message; the caller journals it.
 *
 * Deliberately a diagnostic and not a migration. On a non-kiro run the
 * bare-slug file is *someone else's*: either a live kiro run's state for the
 * same PRD, or an orphan an older build fabricated with the wrong
 * `featureBranch`. Adopting from it silently would import another run's
 * tamper-guard memory, which is a worse failure than the one it fixes — the
 * lineage this build cannot see is recoverable by hand (#178 records the
 * surgery), a lineage it wrongly *adopts* refuses contracts for findings that
 * were never this slice's. So: name both files and adopt nothing.
 */
export function findOrphanedContractLineage(location: {
  repoRoot: string;
  prdSlug: string;
  runSlug: string;
  ghIssue: string;
}): string | null {
  if (location.runSlug === location.prdSlug) return null;
  const qualified = convergenceMap(
    loadRunState(location.repoRoot, location.runSlug),
  );
  if (qualified?.[location.ghIssue] !== undefined) return null;
  const bare = convergenceMap(loadRunState(location.repoRoot, location.prdSlug));
  if (bare?.[location.ghIssue] === undefined) return null;
  return (
    `durable contract lineage for #${location.ghIssue} exists in ` +
    `.afk/state/${location.prdSlug}.json but not in this run's ` +
    `.afk/state/${location.runSlug}.json, so this negotiation starts with no ` +
    `lineage. Lineage moved to the provider-qualified state file in ADR 0061; ` +
    `nothing is adopted automatically because the bare-slug file may belong to ` +
    `another run. Copy the entry across by hand if it is this slice's.`
  );
}

export function saveContractFindingLineage(
  location: LineageLocation,
  lineage: ContractFindingLineage,
): void {
  updateRunState(location.repoRoot, location.runSlug, (state) => {
    const existing = convergenceMap(state) ?? {};
    state.contractConvergence = {
      ...existing,
      [location.ghIssue]: lineage,
    };
  });
}
