/**
 * How the guardian layer's round evidence reaches disk, and nothing about when
 * (#221).
 *
 * The persistence adapter half of the guardian round persistence module;
 * `guardian-round-records.ts` is the other half — the persisted shape and the
 * normalizer that guards it. Together they own the complete persistence
 * invariant for guardian rounds, the way `contract-convergence.ts` and
 * `qa-convergence.ts` own their lineages'.
 *
 * The division of labor with the ship gate is fixed, and this module is the
 * losing side of it on purpose:
 *
 * - **The ship gate decides when.** Persisting on every exit path, including
 *   the failure paths and the catch-path retry, is exit-path knowledge that
 *   belongs to the sequencer (QA-04, QA-06). Nothing here schedules a write,
 *   infers one from a verdict, or exposes a policy for either.
 * - **This module decides how.** Normalization on the way in, compatibility
 *   defaults for a file written before a field existed, append-only rounds
 *   against replace-wholesale caches, filed-findings carry-forward, and
 *   filed-finding identity dedup.
 *
 * The three operations are named for the lifecycle that will consume them: ADR
 * 0057's third convergence lifecycle (#222) loads the ledger, appends a
 * completed round, and records what it filed. {@link GuardianRoundPersistence}
 * is that seam as a type, so the lifecycle can take this module as a
 * collaborator and a test can substitute a failing writer for one operation
 * without standing up a state file.
 *
 * Guardian rounds live inside the shared run-state file, so the writes go
 * through `run-state.ts`'s locked read-modify-write rather than owning a file:
 * a parallel slice write and a round append must not clobber each other.
 */
import { updateRunState, type PersistedReviewPhase } from "./run-state.js";
import type {
  PersistedFiledFinding,
  PersistedGuardianReviewRound,
} from "./guardian-round-records.js";

/**
 * Everything a guardian round decision reads back from run state: the rounds
 * already recorded and the findings this run has already filed issues for.
 *
 * Absent fields normalize to empty arrays. Both absences mean the same thing —
 * a run that has recorded no round and filed nothing — and a caller that has to
 * spell `?? []` at each use is a caller that can forget to.
 */
export interface GuardianRoundLedger {
  rounds: readonly PersistedGuardianReviewRound[];
  filedFindings: readonly PersistedFiledFinding[];
}

/**
 * Read the ledger out of the review phase the caller loaded.
 *
 * Takes the persisted phase rather than a repo path because *when* to read is
 * the sequencer's decision too: the orchestrator loads run state once and hands
 * the ship gate the phase it read, and a second read here would be a second
 * answer to "what did the ledger say when this pass started".
 */
export function loadGuardianRoundLedger(
  reviewPhase: PersistedReviewPhase | undefined,
): GuardianRoundLedger {
  return {
    rounds: reviewPhase?.rounds ?? [],
    filedFindings: reviewPhase?.filedFindings ?? [],
  };
}

/**
 * Atomically replace the cache fields and append the completed guardian rounds
 * the payload carries. Re-reads the file first so parallel slice updates and
 * earlier valid rounds are never clobbered. Pass `undefined` to clear the
 * complete review phase.
 *
 * Rounds are append-only and the caches are replaced wholesale, because the two
 * answer different questions: the ledger is the history of what every round
 * decided, while a cache entry is only a claim about the content in front of
 * this pass. So a payload's `rounds` extend what is on disk, and its cache
 * fields are the complete set of entries that survive the write — a caller that
 * still reused a cached sanity result or verdict has to carry it forward
 * (QA-04, QA-06).
 *
 * `filedFindings` is carried forward like `rounds` rather than replaced like the
 * caches. It is an append-only memory of issues that exist in the tracker, so
 * dropping it would make the next round file every note a second time — and the
 * round write that would drop it happens on every pass, before the filing
 * decision has even run.
 */
export function appendCompletedGuardianRound(
  repoRoot: string,
  runSlug: string,
  reviewPhase: PersistedReviewPhase | undefined,
) {
  updateRunState(repoRoot, runSlug, (current) => {
    if (reviewPhase === undefined) {
      delete current.reviewPhase;
    } else {
      const earlierRounds = current.reviewPhase?.rounds ?? [];
      const appendedRounds = reviewPhase.rounds ?? [];
      const filedFindings =
        reviewPhase.filedFindings ?? current.reviewPhase?.filedFindings;
      current.reviewPhase = {
        ...reviewPhase,
        ...(
          earlierRounds.length + appendedRounds.length > 0
            ? { rounds: [...earlierRounds, ...appendedRounds] }
            : {}
        ),
        ...(filedFindings ? { filedFindings } : {}),
      };
    }
  });
}

/**
 * Append filed-issue records, ignoring identities already recorded.
 *
 * Idempotent by finding identity — `guardian` + `stableId` — so re-filing the
 * same finding, or replaying a write after a crash, records it once. That
 * identity is the durable half of "filed exactly once" (ADR 0057 decision 4):
 * the issue exists in the tracker whatever a later round decides to call it, so
 * the first record wins and a second one with a different issue URL is dropped.
 *
 * A dedicated operation rather than a field on the round append, because filing
 * happens *after* the round has been persisted and the caches recomputed:
 * routing it through the round path would re-enter the round append for a write
 * that has no round to add. Re-reads the file first, so a record survives
 * whatever else the ship gate wrote in between.
 */
export function recordFiledGuardianFindings(
  repoRoot: string,
  runSlug: string,
  filed: readonly PersistedFiledFinding[],
) {
  if (filed.length === 0) return;
  updateRunState(repoRoot, runSlug, (current) => {
    const reviewPhase = current.reviewPhase ?? {};
    const records = [...(reviewPhase.filedFindings ?? [])];
    for (const record of filed) {
      const duplicate = records.some(
        (existing) =>
          existing.guardian === record.guardian &&
          existing.stableId === record.stableId,
      );
      if (duplicate) continue;
      records.push(record);
    }
    current.reviewPhase = { ...reviewPhase, filedFindings: records };
  });
}

/**
 * The adapter surface as one type: load the ledger, append a completed round,
 * record what was filed.
 *
 * Declared so the future `GuardianRoundLifecycle` (ADR 0057's third
 * consequence) can name its persistence collaborator instead of importing three
 * functions, and so a caller can substitute one operation — the ship gate's
 * write-failure tests substitute a throwing writer — without a state file.
 */
export interface GuardianRoundPersistence {
  loadGuardianRoundLedger: typeof loadGuardianRoundLedger;
  appendCompletedGuardianRound: typeof appendCompletedGuardianRound;
  recordFiledGuardianFindings: typeof recordFiledGuardianFindings;
}

/** The adapter bound to the shared run-state file. */
export const guardianRoundPersistence: GuardianRoundPersistence = {
  loadGuardianRoundLedger,
  appendCompletedGuardianRound,
  recordFiledGuardianFindings,
};
