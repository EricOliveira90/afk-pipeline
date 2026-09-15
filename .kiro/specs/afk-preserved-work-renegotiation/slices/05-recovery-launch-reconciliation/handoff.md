# Handoff — Recovery launch reconciliation (#334)

## What shipped

- B-01: src/preserve-work-recovery.ts:reconcileRecoveryLineage
- B-01: src/preserve-work-recovery.ts:RecoveryReconciliationOutcome
- B-02: src/preserve-work-recovery.ts:reconcileRecoveryLineage
- B-03: src/preserve-work-recovery.ts:deriveRestoreDestination
- B-04: src/orchestrator.ts:runPipeline
- B-05: src/preserve-work-recovery.ts:describeRecoveryReconciliation
- B-05: src/orchestrator.ts:runPipeline
- B-06: src/preserve-work-recovery.ts:reconcileRecoveryLineage
- B-07: src/preserve-work-recovery.ts:reconcileRecoveryLineage
- P-01: src/preserve-work-recovery.test.ts:"[behavior:#334:P-01] still refuses --renegotiate-stale on the one shared parse path"
- P-02: src/preserve-work-recovery.test.ts:"[behavior:#334:P-02] keeps the five reused exports callable at their current signatures"
- P-03: src/resume-integration.test.ts:"[behavior:#334:P-03] adds no reconciliation line to a run with no recovery lineage"

## Decisions made during implementation

- **Reconciliation delegates to `rollBackRecoveryAttempt` instead of restoring and
  appending itself.** This is the reading of the contract's "adds no second restore
  implementation, no second verification rule": #333's two-phase sequence (restore
  outside the ADR 0056 lock, then reread, recheck the trailing `attemptId` and
  state, admit the transition, append exactly one event) already exists in that
  writer. A copy here would have been a second answer to "was the pair put back",
  and it would also have broken `[behavior:#333:P-03]`, which pins the module at
  exactly two `appendRecoveryLineageEvent(` and two `transactRunState<` call sites.
  B-02's three outcomes map onto the writer's result directly: `rolledBack: true`
  → `ROLLED_BACK` appended; `rolledBack: false` with `event.state ===
  "ROLLBACK_FAILED"` → that event, whose `rollbackError` is the restore's own
  message verbatim; `rolledBack: false` with no `event` → nothing appended, which
  is the illegal `ROLLBACK_FAILED -> ROLLBACK_FAILED` B-06 requires.
- **`trigger: "cancellation"` for the synthesized failure.** `RecoveryFailureTrigger`
  is a closed union with no process-death member, and changing
  `rollBackRecoveryAttempt` or its types is an explicit non-goal. An abrupt process
  death is an uncommanded cancellation from the attempt's point of view; the
  rollback writer never branches on `trigger` and the value is returned to the
  caller rather than persisted, so the choice is observable nowhere.
- **A bare `logger.phase(..., "error")` line, not a typed run event.** Carrying a
  machine-readable reason would mean adding a member to `src/run-events.ts`, which
  is outside the write boundary. B-05 requires a `logger.phase(...)` line per
  target, and the stale-stop sentinel already reports an operator-facing refusal the
  same way.
- **The run-state file path is joined inside `reconcileRecoveryLineage`.**
  `run-state.ts`'s `statePath` is private and that module is out of scope, but
  B-05's append-nothing line has to name the file holding the hold. The join is
  commented as the one place this module knows the layout.
- **`describeRecoveryReconciliation` lives in `preserve-work-recovery.ts`.**
  ARCHITECTURE.md's "Hubs — do not grow these" gives `src/orchestrator.ts` one call
  site, and the retry a given outcome needs is a fact about the recovery protocol
  rather than about the run loop that prints it. The orchestrator formats nothing.
- **`ghIssue` ordering is numeric where both ids are integers.** These are issue
  numbers, so `#9` must sort before `#10` in the log lines; a plain `.sort()` over
  the lineage keys would put `"1001"` first.
- **The recovery fixture gained an additive `runSlug` option.**
  `makeRecoveryExecutionFixture` wrote `<slug>.json` while `runPipeline` reads the
  provider-qualified `<slug>-stub.json` (ADR 0002). The default is unchanged, so
  #332's byte-for-byte before/after comparison still measures what it measured.

## Gotchas / learnings

- `[behavior:#333:P-03]` and `[behavior:#333:P-05]` hard-count call sites in the
  module source (`appendRecoveryLineageEvent(`, `transactRunState<`,
  `parseAcceptanceManifest(`). Any future slice that adds a third writer or a
  second transaction to this module has to change those pins deliberately.
- `occurrences(MODULE_CODE, "rollBackRecoveryAttempt(")` is **1**, not 2: the
  definition is generic (`rollBackRecoveryAttempt<F extends RecoveryFailure>(`), so
  the name is not followed by `(` there. Counting a generic export's definition the
  way a non-generic one is counted silently measures nothing.
- Run-state lineage keys are integer-like strings, so a JS object enumerates them
  in ascending numeric order no matter what order they were written in. A test
  cannot plant an out-of-order lineage map to prove the sort; the explicit sort is
  what makes the order a promise rather than an artifact of engine key ordering.
- `src/orchestrator.ts`, `src/resume-integration.test.ts` and
  `src/resume-integration.fixtures.ts` must contain none of the strings
  `restoreAcceptedPairFromSnapshot`, `rollBackRecoveryAttempt` or
  `recoveryDispatchRefusal` — `[behavior:#333:B-07]` scans every other `src/*.ts`
  for them. That is why the orchestrator imports only `reconcileRecoveryLineage`
  and `describeRecoveryReconciliation`, and why the fixtures plant lineage as data.
- The two-segment locator is the case worth keeping: its derived `<sliceDir>` is the
  empty string, so the destination collapses onto `repoRoot` and a restore would
  rewrite the repository's own `contract.md` and `acceptance-manifest.json`. B-07's
  "only the two accepted-pair files change" cannot catch it, because those *are* two
  accepted-pair files. The B-03 test plants known bytes at the repository root and
  compares them afterwards for exactly that reason.
- A planted `ROLLBACK_FAILED` lineage event needs all three of `rollbackError`,
  `observedContractFingerprint` and `observedManifestFingerprint` non-blank, and
  every other state needs all three absent, or `sanitizeRecoveryLineage` drops the
  whole target's lineage and the test measures nothing.
