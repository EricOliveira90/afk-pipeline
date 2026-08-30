import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  formatContractLockProvenance,
  type ContractLockProvenance,
} from "./artifacts.js";
import type { ContractNegotiationOutcome } from "./contract-review.js";
import { CONTRACT_NEGOTIATION_OUTCOME_FILENAME } from "./contract-review.js";

export const ADJUDICATION_FILENAME = "adjudication.md";

/**
 * The durable per-finding decision record (ADR 0054). One adjudication
 * decides one finding, so a multi-finding impasse needs more than one, and
 * the orchestrator may only lock the contract once every contested finding
 * has one. This file is what carries decisions between the runs that
 * collect them, and what stops an applied decision being applied twice.
 */
export const ADJUDICATION_DECISIONS_FILENAME = "adjudication-decisions.json";

export type Adjudication =
  | {
      version: 1;
      findingId: string;
      winningPosition: "PLANNER" | "EVALUATOR";
      author: string;
    }
  | {
      version: 1;
      findingId: string;
      thirdInstruction: string;
      author: string;
    };

export type AdjudicationWaitResult =
  | { status: "accepted" }
  | { status: "expired"; defect?: string }
  | { status: "cancelled" };

function requireNonBlankString(
  value: unknown,
  field: string,
  source: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${field} must be a non-blank string`);
  }
}

/**
 * Validate one human adjudication against the impasse it decides.
 *
 * `decidedFindingIds` are the findings this impasse already has a recorded
 * decision for. Re-deciding one is refused rather than recorded twice: the
 * first decision is already applied or queued for the same apply step, so a
 * second copy could only either change a settled answer silently or make
 * the bounded wait accept a decision that adds nothing and redispatch the
 * slice forever.
 */
export function parseAdjudication(
  value: string | unknown,
  impasse: ContractNegotiationOutcome,
  source = ADJUDICATION_FILENAME,
  decidedFindingIds: readonly string[] = [],
): Adjudication {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = parsed as Record<string, unknown>;
  const hasWinner = "winningPosition" in input;
  const hasInstruction = "thirdInstruction" in input;
  if (hasWinner === hasInstruction) {
    throw new Error(
      `${source} must contain exactly one of winningPosition or thirdInstruction`,
    );
  }

  const decisionKey = hasWinner ? "winningPosition" : "thirdInstruction";
  const expected = ["version", "findingId", decisionKey, "author"];
  const keys = Object.keys(input);
  const expectedSet = new Set(expected);
  if (
    keys.some((key) => !expectedSet.has(key)) ||
    expected.some((key) => !(key in input))
  ) {
    throw new Error(
      `${source} root object must contain exactly version, findingId, author and one of winningPosition or thirdInstruction`,
    );
  }
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }

  requireNonBlankString(input.findingId, "findingId", source);
  requireNonBlankString(input.author, "author", source);
  const finding = impasse.findings.find(({ id }) => id === input.findingId);
  if (!finding) {
    throw new Error(
      `${source} findingId ${input.findingId} is absent from the current IMPASSE`,
    );
  }
  if (finding.state !== "CONTESTED") {
    throw new Error(
      `${source} findingId ${input.findingId} is not CONTESTED in the current IMPASSE`,
    );
  }
  if (decidedFindingIds.includes(input.findingId)) {
    throw new Error(
      `${source} findingId ${input.findingId} was already adjudicated in the current IMPASSE`,
    );
  }

  if (hasWinner) {
    if (
      input.winningPosition !== "PLANNER" &&
      input.winningPosition !== "EVALUATOR"
    ) {
      throw new Error(
        `${source} winningPosition must be PLANNER or EVALUATOR`,
      );
    }
    return {
      version: 1,
      findingId: input.findingId,
      winningPosition: input.winningPosition,
      author: input.author,
    };
  }

  requireNonBlankString(
    input.thirdInstruction,
    "thirdInstruction",
    source,
  );
  return {
    version: 1,
    findingId: input.findingId,
    thirdInstruction: input.thirdInstruction,
    author: input.author,
  };
}

/** One recorded decision: the human's bytes plus the parsed form. */
export interface RecordedAdjudication {
  raw: string;
  decision: Adjudication;
}

/**
 * The witness that proves the crash window (ADR 0055 Seam 1 decision 5).
 * Written immediately before `lockContract`, cleared by the applied mark:
 * finding it beside a `LOCKED` contract proves the lock is the one *these*
 * decisions produced, where a bare `LOCKED` proved nothing at all.
 */
export interface AdjudicationPendingLock {
  /** Fingerprint of the exact decision set, over the recorded raw bytes. */
  decisions: string;
  /** The impasse those decisions settle. */
  impasse: string;
}

export interface AdjudicationDecisionLog {
  version: 1;
  /** Fingerprint of the impasse these decisions were made against. */
  impasse: string;
  decisions: RecordedAdjudication[];
  /** True once the decisions reached an accepted contract lock. */
  applied: boolean;
  /** Present only between the lock attempt and the applied mark. */
  pendingLock?: AdjudicationPendingLock;
}

/**
 * Identity of the impasse a decision log belongs to. Round, attempt, and
 * every finding's id/severity/state — the whole of what makes a decision
 * answerable. A renegotiation that produces a different impasse therefore
 * produces a different fingerprint, and the stale log is discarded rather
 * than counted towards the new impasse's contested findings.
 */
export function impasseFingerprint(
  outcome: ContractNegotiationOutcome,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        round: outcome.round,
        attempt: outcome.attempt,
        findings: outcome.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          state: finding.state,
        })),
      }),
    )
    .digest("hex");
}

/** Contested findings in this impasse, in artifact order. */
export function contestedFindingIds(
  outcome: ContractNegotiationOutcome,
): string[] {
  return outcome.findings
    .filter((finding) => finding.state === "CONTESTED")
    .map((finding) => finding.id);
}

function emptyLog(outcome: ContractNegotiationOutcome): AdjudicationDecisionLog {
  return {
    version: 1,
    impasse: impasseFingerprint(outcome),
    decisions: [],
    applied: false,
  };
}

function decisionLogPath(sliceDir: string): string {
  return join(sliceDir, ADJUDICATION_DECISIONS_FILENAME);
}

/**
 * Read the decision log for this impasse, failing closed: a missing,
 * malformed, or stale log yields an empty one and a reason the caller can
 * log. Every recorded decision is re-validated against the current impasse,
 * so a log that no longer describes decidable findings cannot be what
 * permits a lock.
 */
export function loadAdjudicationDecisionLog(
  sliceDir: string,
  outcome: ContractNegotiationOutcome,
): { log: AdjudicationDecisionLog; discarded: string | null } {
  const path = decisionLogPath(sliceDir);
  if (!existsSync(path)) return { log: emptyLog(outcome), discarded: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `${ADJUDICATION_DECISIONS_FILENAME} must contain a JSON object`,
      );
    }
    const input = parsed as Record<string, unknown>;
    if (input.version !== 1) {
      throw new Error(
        `${ADJUDICATION_DECISIONS_FILENAME} must declare version 1`,
      );
    }
    if (input.impasse !== impasseFingerprint(outcome)) {
      throw new Error(
        `${ADJUDICATION_DECISIONS_FILENAME} was recorded against a different IMPASSE`,
      );
    }
    if (typeof input.applied !== "boolean") {
      throw new Error(
        `${ADJUDICATION_DECISIONS_FILENAME} applied must be a boolean`,
      );
    }
    if (!Array.isArray(input.decisions)) {
      throw new Error(
        `${ADJUDICATION_DECISIONS_FILENAME} decisions must be an array`,
      );
    }
    const decisions: RecordedAdjudication[] = [];
    for (const entry of input.decisions) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `${ADJUDICATION_DECISIONS_FILENAME} decisions entries must be objects`,
        );
      }
      const raw = (entry as Record<string, unknown>).raw;
      if (typeof raw !== "string") {
        throw new Error(
          `${ADJUDICATION_DECISIONS_FILENAME} decisions entries must carry the raw decision`,
        );
      }
      // Re-parse the human's bytes rather than trusting the stored parse,
      // and against the decisions already accepted so a duplicated entry
      // is a defect rather than a second vote.
      const decision = parseAdjudication(
        raw,
        outcome,
        ADJUDICATION_DECISIONS_FILENAME,
        decisions.map((recorded) => recorded.decision.findingId),
      );
      decisions.push({ raw, decision });
    }
    const pendingLock = parsePendingLock(input.pendingLock, input.impasse);
    return {
      log: {
        version: 1,
        impasse: input.impasse,
        decisions,
        applied: input.applied,
        ...(pendingLock ? { pendingLock } : {}),
      },
      discarded: null,
    };
  } catch (error) {
    return {
      log: emptyLog(outcome),
      discarded: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate the pending-lock witness like everything else in the log: a
 * malformed one throws, which discards the whole log rather than quietly
 * ignoring the one field a lock might be inherited on (fail-closed). A
 * witness for another impasse is a defect, not a witness — the log already
 * declares which impasse it belongs to.
 */
function parsePendingLock(
  value: unknown,
  impasse: unknown,
): AdjudicationPendingLock | null {
  if (value === undefined) return null;
  const source = `${ADJUDICATION_DECISIONS_FILENAME} pendingLock`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object when present`);
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !("decisions" in input) || !("impasse" in input)) {
    throw new Error(`${source} must contain exactly decisions and impasse`);
  }
  requireNonBlankString(input.decisions, "decisions", source);
  requireNonBlankString(input.impasse, "impasse", source);
  if (input.impasse !== impasse) {
    throw new Error(`${source} was recorded against a different IMPASSE`);
  }
  return { decisions: input.decisions, impasse: input.impasse };
}

/**
 * Write the log through a temporary file and a rename, so a reader never
 * sees a half-written decision set.
 */
function writeAdjudicationDecisionLog(
  sliceDir: string,
  log: AdjudicationDecisionLog,
): AdjudicationDecisionLog {
  const path = decisionLogPath(sliceDir);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(log, null, 2)}\n`, "utf-8");
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return log;
}

/** Record one accepted decision. */
export function appendAdjudicationDecision(
  sliceDir: string,
  log: AdjudicationDecisionLog,
  entry: RecordedAdjudication,
): AdjudicationDecisionLog {
  return writeAdjudicationDecisionLog(sliceDir, {
    ...log,
    decisions: [...log.decisions, entry],
  });
}

/**
 * Fingerprint of a decision set, over the humans' raw bytes in recorded
 * order — the same thing the planner was shown. A set that gained,
 * lost, or reordered a decision is a different set, so a witness for the
 * old one proves nothing about the new one.
 */
export function decisionSetFingerprint(
  decisions: readonly RecordedAdjudication[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(decisions.map((recorded) => recorded.raw)))
    .digest("hex");
}

/**
 * Record the pending-lock witness, immediately before the lock attempt
 * (ADR 0055 §5). Dying after this and before the lock leaves a witness
 * over an unlocked contract, which proves nothing and costs nothing: the
 * next dispatch runs the full apply and overwrites it.
 */
export function recordPendingLock(
  sliceDir: string,
  log: AdjudicationDecisionLog,
): AdjudicationDecisionLog {
  return writeAdjudicationDecisionLog(sliceDir, {
    ...log,
    pendingLock: {
      decisions: decisionSetFingerprint(log.decisions),
      impasse: log.impasse,
    },
  });
}

/**
 * Clear a pending-lock witness that never became an accepted lock — a
 * refused or failed lock exit. Without this, the witness survives beside
 * whatever contract the rollback restored; if that contract is stale
 * LOCKED debris, the next dispatch would prove the refused lock as this
 * decision set's own and inherit it (the A2 shape, recreated). The
 * witness is mechanical bookkeeping, not human input — clearing it is
 * not covered by the "decisions outlive refusals" rule.
 */
export function clearPendingLock(
  sliceDir: string,
  log: AdjudicationDecisionLog,
): AdjudicationDecisionLog {
  const { pendingLock: _cleared, ...rest } = log;
  return writeAdjudicationDecisionLog(sliceDir, rest);
}

/**
 * Mark the recorded decisions as applied to an accepted contract lock, and
 * clear the witness — the applied mark is the stronger proof, and a
 * witness left behind would outlive the window it describes.
 */
export function markAdjudicationDecisionsApplied(
  sliceDir: string,
  log: AdjudicationDecisionLog,
): AdjudicationDecisionLog {
  const { pendingLock: _cleared, ...rest } = log;
  return writeAdjudicationDecisionLog(sliceDir, { ...rest, applied: true });
}

/**
 * Does this log's own witness describe this log's own decision set? Only
 * then does it prove the lock beside it was produced by these decisions.
 */
export function pendingLockWitnessProves(
  log: AdjudicationDecisionLog,
): boolean {
  const witness = log.pendingLock;
  if (!witness) return false;
  return (
    witness.impasse === log.impasse &&
    witness.decisions === decisionSetFingerprint(log.decisions)
  );
}

/**
 * May a `LOCKED` contract be returned as the adjudicated lock without
 * applying the decisions again (ADR 0055 §5)?
 *
 * Only with proof: the log is marked applied, or it carries a witness
 * matching its own decision set. A bare `LOCKED` is deliberately not
 * enough — that shortcut is what let a stale lock be inherited (A2). The
 * provenance stamp is deliberately *not* re-checked here: a valid log
 * already binds to this impasse by its own fingerprint, and requiring the
 * stamp would wrongly refuse a legacy pre-stamp lock whose applied log is
 * intact.
 */
export function adjudicatedLockIsProven(input: {
  locked: boolean;
  log: AdjudicationDecisionLog;
}): boolean {
  if (!input.locked) return false;
  return input.log.applied || pendingLockWitnessProves(input.log);
}

/**
 * What to do with the contract when the decision log had to be discarded
 * (ADR 0055 §4). The log is gone either way; the question is whether the
 * lock beside it was the one those decisions produced.
 */
export type DiscardedDecisionLogReconciliation =
  /** The lock self-certifies: only a proven-complete decision set for this
   * impasse can carry this stamp. It stands; the loss is announced. */
  | { action: "lock-stands"; because: string }
  /** Provably stale, or unprovable — which is the same thing here. */
  | { action: "reopen"; because: string }
  /** Nothing is claiming to be settled, so there is nothing to reconcile. */
  | { action: "none" };

export function reconcileDiscardedDecisionLog(input: {
  locked: boolean;
  provenance: ContractLockProvenance | null;
  outcome: ContractNegotiationOutcome;
}): DiscardedDecisionLogReconciliation {
  if (!input.locked) return { action: "none" };
  const { provenance } = input;
  if (provenance === null) {
    return { action: "reopen", because: "the lock carries no provenance stamp" };
  }
  if (provenance.kind !== "impasse-adjudication") {
    return {
      action: "reopen",
      because: `the lock was produced by ${formatContractLockProvenance(provenance)}`,
    };
  }
  if (provenance.impasse !== impasseFingerprint(input.outcome)) {
    return {
      action: "reopen",
      because: "the lock is stamped with a different IMPASSE",
    };
  }
  return {
    action: "lock-stands",
    because: "the lock is stamped with the current IMPASSE",
  };
}

function decidedFindingIds(log: AdjudicationDecisionLog): Set<string> {
  return new Set(log.decisions.map((recorded) => recorded.decision.findingId));
}

/**
 * Contested findings this impasse still has no human decision for — the
 * subset a courier can act on. Presentation only: it is deliberately *not*
 * the lock predicate, because it cannot see an unresolved OPEN blocker.
 */
export function undecidedContestedFindingIds(
  outcome: ContractNegotiationOutcome,
  log: AdjudicationDecisionLog,
): string[] {
  const decided = decidedFindingIds(log);
  return contestedFindingIds(outcome).filter((id) => !decided.has(id));
}

/**
 * The completion predicate: every unresolved BLOCKING finding in this
 * exhaustion — `CONTESTED` and `OPEN` alike — that has no valid recorded
 * decision (ADR 0055 §2). `LOCKED` is permitted only when this is empty and
 * the mechanical lock gate passes. One function owns the question, so the
 * classifier and the lock path cannot disagree about which findings matter.
 *
 * Under ADR 0055 §1 the `OPEN` clause is unreachable — an impasse contains
 * only contested findings. It spans the full set anyway: A1 existed
 * precisely because the classifier and the predicate could drift apart, and
 * this is the last line of defence. If they drift again the failure mode is
 * "the lock is refused and the disagreement is visible", not "the contract
 * locks over an unresolved blocker".
 */
export function unresolvedBlockingFindingIds(
  outcome: ContractNegotiationOutcome,
  log: AdjudicationDecisionLog,
): string[] {
  const decided = decidedFindingIds(log);
  return outcome.findings
    .filter(
      (finding) =>
        finding.severity === "BLOCKING" &&
        finding.unresolved &&
        !decided.has(finding.id),
    )
    .map((finding) => finding.id);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAdjudication(options: {
  sliceDir: string;
  waitMs: number;
  pollMs: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<AdjudicationWaitResult> {
  const { sliceDir, waitMs, pollMs, signal } = options;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new Error("adjudication wait must be a non-negative integer");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error("adjudication poll interval must be a positive integer");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const deadline = now() + waitMs;
  const outcomePath = join(
    sliceDir,
    CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  );
  const decisionPath = join(sliceDir, ADJUDICATION_FILENAME);
  let latestDefect: string | undefined;

  while (true) {
    if (signal?.aborted) return { status: "cancelled" };
    if (existsSync(decisionPath)) {
      try {
        const outcome = JSON.parse(
          readFileSync(outcomePath, "utf-8"),
        ) as ContractNegotiationOutcome;
        // A decision for an already-decided finding is not progress: the
        // wait must keep waiting rather than redispatch a slice that would
        // park again on the same undecided finding.
        const { log } = loadAdjudicationDecisionLog(sliceDir, outcome);
        parseAdjudication(
          readFileSync(decisionPath, "utf-8"),
          outcome,
          ADJUDICATION_FILENAME,
          log.decisions.map((recorded) => recorded.decision.findingId),
        );
        return { status: "accepted" };
      } catch (error) {
        latestDefect = error instanceof Error ? error.message : String(error);
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: "expired",
        ...(latestDefect ? { defect: latestDefect } : {}),
      };
    }
    await sleep(Math.min(pollMs, remaining), signal);
  }
}
