/**
 * The one transaction that mutates a slice's accepted contract pair, and
 * the one exit that locks it (ADR 0055 Seam 1 decision 3).
 *
 * `contract.md` and `acceptance-manifest.json` are the orchestrator-owned
 * single source of truth for a slice (ADR 0008), and two paths rewrite
 * them: the focused scope revision (ADR 0051) and the impasse
 * adjudication apply (ADR 0054). Each shipped its own copy of
 * capture → mutate → validate → lock → restore-on-failure, and each gate
 * round found the next rule one copy had forgotten. This module is the
 * single copy: a new mutation path either calls it and inherits every
 * rule, or it visibly does not exist.
 *
 * The rules, carried over verbatim from the ADRs that established them:
 *
 * - **Capture before the first mutation.** Both files' bytes are read
 *   before `fn` runs, because the mutation reopens the contract and
 *   deletes the manifest before the planner that writes their
 *   replacements (ADR 0051).
 * - **Restore on every exit not signalled as accepted.** A `finally`
 *   puts both files back byte-for-byte unless `fn` called
 *   `tx.onAccepted()`. Success is signalled by the inner function, never
 *   inferred from a return value, so an exit path added inside `fn`
 *   later is rolled back by default rather than silently exempted
 *   (ADR 0051).
 * - **Announce the rollback, naming both files.** An operator reading
 *   the run log after a failure has to know the contract in front of
 *   them is the pre-mutation one and not a half-applied edit
 *   (ADR 0051).
 * - **One lock exit.** `tx.lock()` is the only place these paths call
 *   `artifacts.lockContract`, and it runs the completion predicate
 *   (ADR 0055 §2) and the mechanical lock gate before it does. With one
 *   lock exit there is no second path for a lock-gate bypass to live in.
 * - **Every lock names what produced it.** The lock exit stamps the
 *   contract's `**Lock-Provenance:**` line and, for an adjudication, writes
 *   the pending-lock witness that proves the crash window before it locks
 *   (ADR 0055 §4–5). Provenance is a required argument, so a future caller
 *   cannot lock anonymously.
 *
 * What is deliberately *outside* the transaction: the escalation archive
 * (written by the caller before a revision starts, ADR 0050/0051) and
 * `adjudication-decisions.json` (ADR 0054). Human input and the evidence
 * an operator needs to hand-declare a scope must outlive a mechanical
 * refusal, even though the contract must not change.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as artifacts from "./artifacts.js";
import { ACCEPTANCE_MANIFEST_FILENAME } from "./acceptance-manifest.js";
import {
  recordPendingLock,
  clearPendingLock,
  unresolvedBlockingFindingIds,
  type AdjudicationDecisionLog,
} from "./adjudication.js";
import type { ContractLockProvenance } from "./artifacts.js";
import type { ContractNegotiationOutcome } from "./contract-review.js";

/**
 * What the transaction needs from a `SliceContext`, and nothing more —
 * the whole slice context would drag the orchestrator's world into a
 * module the orchestrator imports.
 */
export interface ContractTransactionContext {
  absSliceDir: string;
  tag: string;
  logger: {
    phase(message: string, via?: "error" | "log" | "warn"): void;
  };
  /** The mechanical lock gate: migration-prefix and run-specific checks. */
  onContractLocked?: (contractPath: string) => string | null;
}

/** How the rollback announcement reads for this caller. */
export interface ContractRollbackNotice {
  /** What did not complete, e.g. `"focused scope revision did not complete"`. */
  reason: string;
  /** Qualifies the restored pair, e.g. `"the previously accepted"`. */
  qualifier: string;
  /** Optional trailing clause, e.g. which decisions survive the rollback. */
  note?: string;
}

/** The lock exit's request. */
export interface ContractLockRequest {
  /**
   * What produced this lock (ADR 0055 §4). Required: "every lock exit
   * stamps, no special cases" is only true if there is no way to reach the
   * lock exit without saying why.
   */
  provenance: ContractLockProvenance;
  /**
   * The adjudication shape to check the completion predicate against, and
   * the log the pending-lock witness is written into. Omitted by mutation
   * paths with no impasse to complete (an ordinary focused revision),
   * where the predicate is vacuous and there is no crash window to prove.
   */
  completion?: {
    outcome: ContractNegotiationOutcome;
    log: AdjudicationDecisionLog;
  };
}

/**
 * The lock exit's answer. `refusal` is the defect, unphrased: the caller
 * owns how a refusal reads to the operator, because a focused revision
 * and an adjudication describe the same objection differently.
 */
export type ContractLockResult =
  | { locked: true }
  | { locked: false; refusal: string };

export interface ContractTransaction {
  readonly contractPath: string;
  readonly manifestPath: string;
  /** `contract.md`'s bytes before the first mutation. */
  readonly previousContract: string;
  /**
   * `acceptance-manifest.json`'s bytes before the first mutation, or
   * `null` when the slice had no manifest yet — the rollback then deletes
   * whatever the mutation wrote rather than resurrecting a file that
   * never existed.
   */
  readonly previousManifestText: string | null;
  /**
   * The single lock exit: completion predicate, then the pending-lock
   * witness, then the stamped `lockContract`, then the mechanical lock
   * gate. Does *not* signal acceptance — a caller with bookkeeping to
   * finish after the lock (marking a decision log applied) must still be
   * rolled back if that bookkeeping fails, so `onAccepted` stays a
   * separate, explicit call.
   */
  lock(request: ContractLockRequest): ContractLockResult;
  /**
   * Signals an accepted lock. Nothing is restored after this. Per
   * ADR 0051 this is the only way out of the transaction that keeps the
   * mutation.
   */
  onAccepted(): void;
}

/**
 * Run `fn` as the one contract-mutation transaction. See the module
 * docstring for the rules it enforces.
 */
export async function withContractTransaction<T>(
  ctx: ContractTransactionContext,
  notice: ContractRollbackNotice,
  fn: (tx: ContractTransaction) => Promise<T>,
): Promise<T> {
  const contractPath = join(ctx.absSliceDir, "contract.md");
  const manifestPath = join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME);
  const previousContract = readFileSync(contractPath, "utf-8");
  const previousManifestText = existsSync(manifestPath)
    ? readFileSync(manifestPath, "utf-8")
    : null;

  let accepted = false;
  const tx: ContractTransaction = {
    contractPath,
    manifestPath,
    previousContract,
    previousManifestText,
    lock(request) {
      // The completion predicate is the last line of defence, not the
      // courier's park check: a path that parks on undecided findings has
      // already refused long before it reaches a lock. It is re-asked
      // here because ADR 0055 §2 puts the question at the lock exit, so a
      // future caller that forgets the earlier check still cannot lock
      // over an unresolved blocking finding.
      if (request.completion) {
        const undecided = unresolvedBlockingFindingIds(
          request.completion.outcome,
          request.completion.log,
        );
        if (undecided.length > 0) {
          return {
            locked: false,
            refusal:
              `unresolved blocking finding${undecided.length === 1 ? "" : "s"} ` +
              `${undecided.join(", ")} ` +
              `${undecided.length === 1 ? "has" : "have"} no recorded human ` +
              `decision`,
          };
        }
      }
      // Witness first, lock second, applied-mark third (ADR 0055 §5). Only
      // this order makes the crash window provable: a witness over an
      // unlocked contract proves nothing and is overwritten by the next
      // apply, while a witness beside a lock proves the lock is this
      // decision set's.
      //
      // The witness must not outlive a lock exit that did not lock: the
      // rollback restores the pre-transaction contract, and if that
      // restored contract is itself stale LOCKED debris, a surviving
      // witness would prove the *refused* lock on the next dispatch and
      // bypass the gate re-run. Cleared in the finally for every
      // non-locked exit, including a thrown lockContract or gate.
      if (request.completion) {
        recordPendingLock(ctx.absSliceDir, request.completion.log);
      }
      let lockAccepted = false;
      try {
        artifacts.lockContract(contractPath, request.provenance);
        const objection = ctx.onContractLocked?.(contractPath) ?? null;
        if (objection !== null) {
          // No local reopen: the rollback below restores the pre-mutation
          // contract byte-for-byte, which is strictly more than reopening
          // the status line of a contract the planner may also have
          // rewritten.
          return { locked: false, refusal: objection };
        }
        lockAccepted = true;
        return { locked: true };
      } finally {
        if (!lockAccepted && request.completion) {
          clearPendingLock(ctx.absSliceDir, request.completion.log);
        }
      }
    },
    onAccepted() {
      accepted = true;
    },
  };

  try {
    return await fn(tx);
  } finally {
    if (!accepted) {
      writeFileSync(contractPath, previousContract, "utf-8");
      if (previousManifestText === null) {
        rmSync(manifestPath, { force: true });
      } else {
        writeFileSync(manifestPath, previousManifestText, "utf-8");
      }
      ctx.logger.phase(
        `${ctx.tag}: ${notice.reason} — restored ${notice.qualifier} ` +
          `contract.md and ${ACCEPTANCE_MANIFEST_FILENAME}` +
          (notice.note ? `; ${notice.note}` : ""),
      );
    }
  }
}
