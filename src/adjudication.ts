import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

export interface AdjudicationDecisionLog {
  version: 1;
  /** Fingerprint of the impasse these decisions were made against. */
  impasse: string;
  decisions: RecordedAdjudication[];
  /** True once the decisions reached an accepted contract lock. */
  applied: boolean;
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
    return {
      log: {
        version: 1,
        impasse: input.impasse,
        decisions,
        applied: input.applied,
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

/** Mark the recorded decisions as applied to an accepted contract lock. */
export function markAdjudicationDecisionsApplied(
  sliceDir: string,
  log: AdjudicationDecisionLog,
): AdjudicationDecisionLog {
  return writeAdjudicationDecisionLog(sliceDir, { ...log, applied: true });
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
