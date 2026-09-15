# Slice 06 — Recovery completion and replay (#335)

## What shipped

- B-01: `src/preserve-work-recovery.ts:completeRecoveryAttempt` (entry guard, `readLockedAcceptedPair` → injected `lockGate` → `provenance` precondition chain, `endCompletionThroughRollback`)
- B-02: `src/preserve-work-recovery.ts:completeRecoveryAttempt` (the one `transactRunState<LockedCompletion>` body and its `nextRecoveryEvent`/`appendRecoveryLineageEvent` append)
- B-03: `src/preserve-work-recovery.ts:endCompletionThroughRollback`
- B-04: `src/preserve-work-recovery.ts:recoveryPreDispatchRefusal`, `src/preserve-work-recovery.ts:RecoveryPreDispatchRefusal`
- B-05: `src/preserve-work-recovery.ts:replayOutcome`, `src/preserve-work-recovery.ts:completedReplacementFor`
- B-10: `src/preserve-work-recovery.ts:replayOutcome`
- B-11: `src/preserve-work-recovery.ts:admitStaleRenegotiation` (the replay branch's fall-through)
- B-12: `src/run-state.ts:COMPLETION_FIELDS`, `src/run-state.ts:sanitizeRecoveryLineage`, `src/run-state.ts:PersistedRecoveryLineageEvent`
- P-01: `src/preserve-work-recovery.test.ts` — `[behavior:#335:P-01]`
- P-02: `src/preserve-work-recovery.ts:nextRecoveryEvent` (one builder for every terminal event), `src/preserve-work-recovery.test.ts` — `[behavior:#335:P-02]`
- P-03: `src/preserve-work-recovery.test.ts` — `[behavior:#335:P-03]`
- P-04: `src/preserve-work-recovery.test.ts` — `[behavior:#335:P-04]`
- P-05: `src/preserve-work-recovery.test.ts` — `[behavior:#335:P-05]`
- Map row: `ARCHITECTURE.md` "Preserved-work recovery"
- End-to-end over a resumed run's persisted document: `src/resume-integration.test.ts` — `[behavior:#335:B-02] [behavior:#335:B-04]`, with `src/resume-integration.fixtures.ts:writeRecoveryReplacementPair`

## Decisions made during implementation

- **The gate and the stamp are injected, not imported.** `ContractTransactionContext.onContractLocked` and the `**Lock-Provenance:**` wording live in `src/contract-transaction.ts` / `src/artifacts.ts`, which are Review-rails internals this module may not import and which are outside this slice's file scope. `lockGate: (contractPath) => string | null` and `provenance: string` are required parameters instead, so "exactly one gate, reached with the replacement contract's path" is a type-level fact. The literal `**Lock-Provenance:**` appears nowhere in the module, not even in a comment.
- **A missing gate or a blank/missing provenance is a refusal, never a skip.** A non-function `lockGate` produces the refusal string without a call; a provenance that trims to `""` refuses with the same `lock-gate-refused` code, on ADR 0055 §4's "every lock exit stamps, no special cases".
- **Every unsuccessful ending goes through #333's writer**, and `endCompletionThroughRollback` re-reads the lineage first. `rollBackRecoveryAttempt` takes no `attemptId` and acts on whatever unresolved event trails, so handing it a lineage that moved on would restore another attempt's snapshot over this slice's pair; teaching it an `attemptId` is what P-02 forbids, so the caller checks and, when the check fails, writes nothing anywhere (no `failure`, no `rollback` in the result).
- **The CAS-lost ending calls the rollback writer after the transaction returned**, not inside it, so the run-state lock is never taken twice — the same shape `reconcileRecoveryLineage` already uses.
- **Replay is keyed on the pair, not on the request.** `completedReplacementFor` searches every target's trailing `COMPLETED` event for one whose replacement fingerprints match the pair on disk; the recorded target and reason are then compared as values to tell an exact repeat (`replay-completed-no-op`) from a conflict (`replay-conflict`). The branch sits after the `attempt-already-pending` refusal and before tip resolution, because one step later a snapshot of the replacement pair would already be published.
- **`extensions.length === 0` is compared, not assumed**, so the replay identity check does not become vacuous when `--extend-scope` (#278) ships.
- **B-04's "absent from the slice's diff" observables are asserted as content, not as a `git diff`.** The feature branch already carries merges of #332/#333/#334 and #277 itself edited `src/cli-options.ts` relative to `main`, so a `name-only` diff against any base is either wrong or environment-dependent. In its place: no shipped module outside `src/preserve-work-recovery.ts` names either new export; `src/wave.ts` still reads `outcome = await runSliceExecute(ctx);`; `src/orchestrator.ts`'s recovery import list is still exactly #334's two names; `src/run-events.ts`, `src/run-snapshot.ts` and `src/status.ts` contain no `/recovery/i` at all; and #277's `--renegotiate-stale` refusal is re-pinned behaviorally from this slice's own test file so `src/cli-options.test.ts` and `src/cli-entries.test.ts` stay untouched.
- **B-02's "exactly one `transactRunState` call" is a structural count over the declaration's own body**, sliced out of the comment-stripped module source between its signature and the next `\nexport `. Spying on an ESM namespace import is not reliable here, and the module's existing `MODULE_SOURCE`/`occurrences()` idiom already answers this shape of question.
- **B-03's changed-trailing-event cases are driven only through `beforeLockAcquired`.** Planted before the call they would be a different claim — the entry read would see them and answer `no-pending-attempt`, or simply complete the newer attempt. The second variant admits its attempt against a *third* valid pair inside the seam and writes the live pair back, so "the second attempt's snapshot was not read onto disk" is a real observable while "both pair files are byte-identical across the call" still holds.
- **Commits are grouped, not strictly one-per-behavior**: the implementation landed as one commit because the completion, its refusal endings and the replay branch share one control flow, and the test block as one commit because its cases share the fixture helpers in a single file. Both name every behavior they carry.
- `RUN_STATE_VERSION` stays 7 and no migration file was added: the three `COMPLETED` members are additive state-scoped optional persisted fields, on the `ROLLBACK_FAILURE_FIELDS` precedent.

## Gotchas / learnings

- `src/resume-integration.fixtures.ts`'s recovery fixture records a stand-in `scopeFingerprint` (`"b8".repeat(32)`). Nothing in #332/#333/#334 reads it, but the completion rechecks it under the lock and refuses a stand-in as lost consensus, so `writeRecoveryReplacementPair` rewrites it to `runScopeFingerprint` of the scope the fixture actually persists. Anything else that starts reading that field will hit the same wall.
- `sanitizeRecoveryLineage` does not cross-check a lineage key against its events' `target.ghIssue`, which is what lets B-10's different-target case plant a `COMPLETED` event for slice 8/#278 under key `"278"` while the pair sits in slice 07's directory. If that cross-check is ever added, that test needs a different plant.
- `plantedEvent` in `src/preserve-work-recovery.test.ts` had to gain the three `COMPLETED` members: without them run state now drops any planted completion, which would silently have made #334's `P-03` planted-COMPLETED row vacuous. Its default replacement fingerprints are deliberately a pair no fixture writes, so a planted completion never accidentally matches the pair on disk and turns a later admission into a replay.
- `readLockedAcceptedPair` returns `undefined` for a `NEGOTIATING` contract, so a reopened pair makes *both* of `recoveryPreDispatchRefusal`'s observed fingerprints `RECOVERY_FINGERPRINT_ABSENT` — the mutated-but-still-`LOCKED` case is the only one that reports a real digest.
- A structural assertion that names its own needle counts itself: `occurrences(sourceOf("preserve-work-recovery.test.ts"), "spawnSync(")` reads 2, not 1. The needle is assembled from fragments so the assertion is not its own second match.
- `git add architecture.md` silently matches nothing on this checkout — the tracked path is `ARCHITECTURE.md`, and only the exact case stages it, even though both resolve to the same file on Windows.
