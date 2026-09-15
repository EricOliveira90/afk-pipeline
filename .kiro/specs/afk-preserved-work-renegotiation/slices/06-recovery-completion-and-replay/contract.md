# Slice Contract — Recovery completion and replay

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #335
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

`src/preserve-work-recovery.ts` can admit (#277), execute (#332), roll back
(#333) and reconcile (#334) a preserved-work recovery attempt, but nothing can
end one *successfully*: `LEGAL_RECOVERY_TRANSITIONS` admits `PENDING ->
COMPLETED` (`src/preserve-work-recovery.ts:251-269`) and no writer appends it.
This slice adds the two missing behaviors, both reached only through exported
seams: **completion** — one `completeRecoveryAttempt` that validates the
replacement pair through the module's one existing pair reader, runs an injected
mechanical lock gate, then inside a single ADR 0056 `transactRunState` rechecks
the same attempt is still `PENDING` with the admitted scope fingerprint and
appends the `COMPLETED` event carrying the replacement fingerprints and the lock
provenance, delegating every admitted failure to #333's rollback writer; one
`recoveryPreDispatchRefusal` that fails closed unless the current pair is still
locked and fingerprint-identical to that event — and **replay** — an exact
repeat against a completed replacement is a no-op, a repeat differing in target
or canonical reason is refused naming the completed attempt, and a genuinely
different valid locked pair is an ordinary new attempt. Reporting, `afk status`
and every dispatch call site belong to #336; this slice wires the pre-dispatch
check into no dispatch site, exactly as #333 shipped `recoveryDispatchRefusal`
("this slice wires it into no dispatch site",
`src/preserve-work-recovery.ts:1468`).

### In scope

- [behavior:B-01] `completeRecoveryAttempt(args)` in
  `src/preserve-work-recovery.ts` appends no `COMPLETED` event and writes no
  run-state document of its own unless three preconditions hold, with no second
  validation path and no bypass: the replacement pair validates through the
  module's only pair reader `readLockedAcceptedPair`
  (`src/preserve-work-recovery.ts:336-361`), a failure refused with the module's
  existing code `accepted-pair-invalid` (`:113-114`); an
  injected mechanical lock gate — a required
  `lockGate: (contractPath: string) => string | null` argument, structurally the
  same shape as `ContractTransactionContext.onContractLocked`
  (`src/contract-transaction.ts:184-185`) — returns `null`; and a required
  non-blank `provenance` string is supplied by the caller, a blank or missing one
  refused exactly as a refusing gate is, because the provenance *is* the lock
  exit's own stamp and its absence is the same unproven-lock fact — a mechanical
  grouping, recorded here rather than escalated. Decided here too, because
  the escalation tests do not fire on it: the gate and the provenance stamp are
  injected rather than imported because their owners
  (`src/contract-transaction.ts`, `src/artifacts.ts`) are files this slice may
  not edit or import — `src/artifacts.ts` is a Review-rails internal
  (ARCHITECTURE.md "Internals (do not import)", already the recorded reason this
  module hand-matches `**Status:** LOCKED` at
  `src/preserve-work-recovery.ts:330-334`) — and injection is this module's
  existing seam pattern for exactly that problem (`RecoveryGitProbes`,
  `src/preserve-work-recovery.ts:279-298`). A missing or refusing gate is a
  refusal, never a skip. New refusal code `lock-gate-refused` on
  `RecoveryRefusalCode`, covering both the refusing gate and the blank
  provenance. A precondition refusal is terminal for the attempt, not a
  retryable non-write: the write it forbids is the `COMPLETED` append and the
  run-state document that would carry it, and the attempt is then *ended* — it is
  not left `PENDING` — through B-03's delegation to #333's rollback writer, which
  restores the snapshot pair and appends `ROLLED_BACK`, or `ROLLBACK_FAILED` when
  the restore cannot be proven. The only refusal that writes nothing anywhere is
  B-03's changed-trailing-event shape.
- [behavior:B-02] On passing B-01, `completeRecoveryAttempt` performs exactly one
  `transactRunState` (`src/run-state.ts:672-684`, ADR 0056) which reloads state
  under the lock and, in that one body, rechecks that the target's trailing
  lineage event is the same `attemptId` and still `PENDING`, that
  `runScopeFingerprint(locked.scope)`
  (`src/preserve-work-recovery.ts:236-240`) still equals that event's
  `scopeFingerprint`, and that `isLegalRecoveryTransition("PENDING",
  "COMPLETED")` holds, then appends one `COMPLETED` event through
  `appendRecoveryLineageEvent` (`src/run-state.ts:1264-1274`) carrying the
  replacement pair's two fingerprints, the caller's provenance, the trailing
  event's `attemptId`, `target`, `reason` and `snapshotPath` verbatim, and an
  empty `extensions` array. Every other run-state field is copied forward
  untouched. PRD "Successful Completion and Scope Atomicity" also adds the
  proposed extension set in this write; decided here as vacuous and unwritten,
  because `--extend-scope` is #278 and the extension set this slice reads is
  empty (#335 non-goals), so the one document this transaction publishes
  contains the terminal event and no scope change.
- [behavior:B-03] No completion failure appends a `COMPLETED` event, and this
  slice writes no restore, no rollback and no `ROLLED_BACK`/`ROLLBACK_FAILED`
  append of its own (PRD: "Every unsuccessful admitted exit—including ...
  deterministic validation or lock-gate refusal, ... and a lost completion
  compare-and-swap—restores from the immutable snapshot"). Every ending is either
  #333's verified rollback writer `rollBackRecoveryAttempt`
  (`src/preserve-work-recovery.ts:1369-1446`), called after the transaction has
  returned and released the lock, the way `reconcileRecoveryLineage` already
  calls it (`:1689-1701`), or a refusal that writes nothing at all. Which of the
  two applies is decided by whether this attempt is still the target's trailing
  `PENDING` event, because that writer takes no `attemptId`: it reloads state
  itself, acts on whatever `rollbackableEvent` returns (`:1369-1390`, predicate
  `:1293-1302`) and rechecks only that the *trailing* event is unchanged
  (`:1412-1422`). So completion delegates to it only with a lineage it has just
  read and found still trailing this attempt's `PENDING` event, and the failure
  shapes are these three:
  - **Precondition refusal** — an invalid replacement pair
    (`accepted-pair-invalid`) or a refusing lock gate / blank provenance
    (`lock-gate-refused`), both detected before the transaction: completion reads
    run state once, and only when the target's trailing event is still this
    `attemptId` in state `PENDING` does the attempt end
    through `rollBackRecoveryAttempt` with
    `trigger: "deterministic-validation-refusal"` or
    `trigger: "lock-gate-refusal"` respectively, which restores the snapshot pair
    and appends `ROLLED_BACK`, or `ROLLBACK_FAILED` when the restore cannot be
    proven. No precondition refusal leaves the attempt `PENDING` (B-01).
  - **Locked recheck lost with this attempt still trailing** — B-02's recheck
    fails only because `runScopeFingerprint(locked.scope)` no longer equals the
    `PENDING` event's `scopeFingerprint`, while the trailing event is still this
    `attemptId` in state `PENDING`: the attempt ends through the same writer with
    the new `trigger: "completion-cas-lost"`.
  - **The trailing event is no longer this attempt's `PENDING` event** — a
    different `attemptId` trails, or this `attemptId` trails in a different state,
    observed either by B-02's locked recheck or by the read that precedes a
    precondition delegation: completion appends nothing, restores nothing and calls
    no rollback, returning the module's existing refusal code
    `facts-changed-before-lock` (`:133-134`) naming this `attemptId` and the
    observed trailing `attemptId` and state. Decided here, not escalated, and
    recorded in this statement: delegating this shape is what would let a
    completion roll back an attempt it never admitted — after a `ROLLED_BACK`
    event `hasOpenRecoveryAttempt` is false (`:577-583`), so a fresh `PENDING`
    attempt can be trailing and the writer would restore *that* attempt's
    snapshot and append for it — and the alternative fix, teaching the writer an
    `attemptId`, is forbidden by P-02. This is not a lost exit under the PRD's
    failure matrix: whatever moved the lineage past this attempt already ended it
    (`ROLLED_BACK` after a verified restore), or, if the process dies with the
    lineage unresolved, the "Process death before completion commit" row applies
    and #334's launch reconciliation restores it. The one window this slice
    cannot close lives inside the unedited writer, between its own load and its
    locked recheck; it stays #333's behavior under P-02, and no write of this
    slice's own enters it.
- [behavior:B-04] `recoveryPreDispatchRefusal(state, ghIssue, sliceDir)` returns
  a refusal, code `completed-pair-drifted`, unless the target's trailing event is
  `COMPLETED` and a fresh `readLockedAcceptedPair(sliceDir)` returns a pair whose
  two fingerprints equal that event's replacement fingerprints; the message names
  the `attemptId` and both observed fingerprints. It is exported and wired into
  no dispatch site: the only generator-dispatch site in the tree is the single
  `runSliceExecute(ctx)` call at `src/wave.ts:536`, in a file this slice's
  non-goals forbid editing, so the wiring is #336's. `recoveryDispatchRefusal`
  (`src/preserve-work-recovery.ts:1470-1486`) is unchanged and keeps owning the
  `ROLLBACK_FAILED` hold; the two are separate predicates over separate trailing
  states.
- [behavior:B-05] With a target's trailing event `COMPLETED` and the current pair
  fingerprint-identical to that event's replacement fingerprints,
  `admitStaleRenegotiation` (`src/preserve-work-recovery.ts:644-811`) repeated
  with the same canonical target, the same canonical reason and an empty
  extension set is an idempotent no-op: it publishes no snapshot, appends no
  lineage event, rewrites no accepted-pair byte and writes no run-state
  document. The outcome is a new `AdmissionOutcome` member carrying code
  `replay-completed-no-op` and the completed `attemptId`.
- [behavior:B-10] The same repeat differing in canonical target or canonical
  reason (`CanonicalRecoveryRequest`, `src/preserve-work-recovery.ts:144-148`) is
  refused with code `replay-conflict`, publishing no snapshot and appending
  nothing, and the message names the completed attempt's `attemptId`.
- [behavior:B-11] When the current pair is a different valid `LOCKED` pair — its
  fingerprints differ from the completed replacement — admission proceeds
  unchanged: a fresh `attemptId`, a fresh
  `<sliceDir>/recovery-snapshots/<attemptId>` snapshot directory
  (`src/preserve-work-recovery.ts:504-574`) and one new `PENDING` event, so
  replay idempotence never blocks recovery of a newer lock.
- [behavior:B-12] `PersistedRecoveryLineageEvent` (`src/run-state.ts:284-341`)
  gains three fields that exist only on a `COMPLETED` event and are required
  there — `replacementContractFingerprint`, `replacementManifestFingerprint`,
  `lockProvenance` — enforced by `sanitizeRecoveryLineage`
  (`src/run-state.ts:1147-1238`) with the same per-state rule as
  `ROLLBACK_FAILURE_FIELDS` (`src/run-state.ts:356-360`): all three non-blank
  when `state === "COMPLETED"`, all three absent on every other state, and
  copied forward in the sanitizer's field-by-field copy so they round-trip.
  `lockProvenance` is persisted as one opaque non-blank string — the stamp text
  the caller's lock exit already produced (ADR 0055 §4, "every lock exit stamps,
  no special cases", `src/contract-transaction.ts:199-205`) — and this module
  neither formats nor parses it, so no `src/artifacts.ts` vocabulary is
  duplicated. Decided here, not escalated: the fields are purely additive and
  optional in the type, so `RUN_STATE_VERSION` stays 7 on the recorded #333
  precedent for exactly this shape (`src/run-state.ts:318-326`, "purely additive
  on disk, with no `RUN_STATE_VERSION` bump, on the `RunState.specsDir`
  precedent"), and they are read — B-04, B-05 and B-10 all read them, so no
  record here is decoration (ARCHITECTURE.md placement rules).

### Non-goals (explicit out-of-scope)

- Every reporting surface and every dispatch call site belong to **#336 (PRD9-S7:
  Recovery reporting and launch wiring)**: no `RunEventPayload` variant, no
  `src/run-events.ts` change, no run-snapshot field, no `afk status` change, and
  no wiring of `completeRecoveryAttempt` or `recoveryPreDispatchRefusal` into any
  launch, lock or dispatch seam. Attempt state stays readable from run state
  only.
- No edit to `src/cli-options.ts`, `src/orchestrator.ts`, `src/wave.ts`,
  `src/afk.ts`, `src/afk-claude.ts` or `src/afk-codex.ts`. #277's entry-point
  refusal of `--renegotiate-stale` stays in force with its tests unedited; the
  protocol becomes reachable from the command line in #336. The stale comment at
  `src/cli-options.ts:385-387` calling a guard deletion "the completion slice's
  change" predates the 2026-09-14 second cut and is not acted on.
- `--extend-scope` stays unimplemented (#278); the extension set on every event
  this slice writes is empty.
- No restore, rollback or reconciliation logic is written, moved or duplicated:
  #333's and #334's implementations are called, not reimplemented.
- No new spawned pipeline scenario: the end-to-end path extends the existing
  recovery fixture in `src/resume-integration.fixtures.ts`.

### Existing behavior to preserve

- [behavior:P-01] No path added by this slice invokes a merge, reset, rebase or
  any other ref-moving git operation, including every refusal and no-op path
  (ADR 0039; `src/preserve-work-recovery.ts:16-19`). The preserved worktree,
  slice branch, commits and resume counters are untouched.
- [behavior:P-02] `restoreAcceptedPairFromSnapshot`
  (`src/preserve-work-recovery.ts:1161-1252`), `rollBackRecoveryAttempt`
  (`:1369-1446`), `recoveryDispatchRefusal` (`:1470-1486`) and
  `reconcileRecoveryLineage` (`:1625-1714`) keep their current behavior and stay
  the single implementations of restore-and-verify, rollback, the
  `ROLLBACK_FAILED` hold and launch reconciliation. `rollBackRecoveryAttempt`
  keeps its signature too — it gains no `attemptId` parameter and no new
  recheck — which is why B-03's third shape, a trailing event that is no longer
  this attempt's `PENDING` event, is a write-nothing refusal rather than a
  delegation.
- [behavior:P-03] `readLockedAcceptedPair` stays the module's only accepted-pair
  reader and validator, `src/preserve-work-recovery.ts` gains no import of
  `./artifacts.js`, `./contract-transaction.js`, `./orchestrator.js` or
  `./wave.js`, and `admitStaleRenegotiation`, `executeRecoveryAttempt`
  (`:924-1073`) and `canonicalizeRecoveryRequest` (`:176-206`) keep their
  existing outcomes for every input that is not a replay against a `COMPLETED`
  trailing event — including trim-only reason canonicalization and the
  `attempt-already-pending` refusal.
- [behavior:P-04] #277's entry-point refusal of `--renegotiate-stale` stays in
  force after this slice merges: `src/cli-options.ts` and the tests #277 added
  for that refusal are unedited, and those tests pass untouched.
- [behavior:P-05] The launch and reporting path is unmodified:
  `src/orchestrator.ts`, `src/wave.ts`, `src/run-events.ts`,
  `src/run-snapshot.ts`, `src/status.ts` and the three provider entry points are
  unedited, so no `RunEventPayload` variant, run-snapshot field or status field
  is added and no live recovery launch reaches this slice's behaviors.

### Changes to existing behavior (only if the issue asks for it)

- `AdmissionOutcome` (`src/preserve-work-recovery.ts:585-598`) gains the
  `replay-completed-no-op` outcome and the `replay-conflict` refusal, so an exact
  repeat against a completed replacement no longer publishes a snapshot and mints
  a new attempt (#335 "Replay"; PRD "Replay and Conflicts").
- `RecoveryRefusalCode` (`:96-134`) gains `lock-gate-refused`,
  `completed-pair-drifted`, `replay-completed-no-op` and `replay-conflict`
  (#335 acceptance criteria 1, 5, 6, 7).
- `RecoveryFailureTrigger` (`:1255-1260`) gains `completion-cas-lost`, the
  trigger B-03 passes for a lost completion compare-and-swap (PRD: "and a lost
  completion compare-and-swap—restores from the immutable snapshot").
- `PersistedRecoveryLineageEvent` gains the three `COMPLETED`-only members named
  in B-12 (PRD: "Its terminal event records the replacement pair fingerprints
  and lock provenance").

## Files expected to change

- src/preserve-work-recovery.ts
- src/run-state.ts
- src/preserve-work-recovery.test.ts
- src/run-state.test.ts
- src/resume-integration.test.ts
- src/resume-integration.fixtures.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- None — uses existing patterns: injected structural probes
  (`RecoveryGitProbes`), `transactRunState` recheck-then-append, and additive
  state-scoped optional persisted fields on the `ROLLBACK_FAILURE_FIELDS`
  precedent. No new dependency and no `RUN_STATE_VERSION` bump.

## Test plan

- Given a target whose trailing event is `PENDING` and a valid `LOCKED`
  replacement pair, when `completeRecoveryAttempt` runs with a gate returning
  `null` and a provenance string, then one `COMPLETED` event is appended carrying
  both replacement fingerprints, that provenance and an empty `extensions`, and
  every unrelated run-state field is byte-identical to before (B-01, B-02).
- Given the same precondition, when the lock gate returns a refusal string, the
  `provenance` is blank, or the replacement pair is not a valid `LOCKED` pair,
  then no `COMPLETED` event is appended, the refusal carries `lock-gate-refused`
  or `accepted-pair-invalid`, and the attempt is ended rather than left `PENDING`:
  the lineage's new trailing event is the `ROLLED_BACK` (or, with the snapshot
  made unreadable, `ROLLBACK_FAILED`) event `rollBackRecoveryAttempt` appended for
  the same `attemptId`, and the returned failure carries trigger
  `lock-gate-refusal` or `deterministic-validation-refusal` (B-01, B-03).
- Given the target's persisted scope is edited so `runScopeFingerprint` no longer
  equals the `PENDING` event's `scopeFingerprint` while that event is still
  trailing, when `completeRecoveryAttempt` runs, then no `COMPLETED` event is
  appended and the rollback writer is reached with trigger `completion-cas-lost`,
  its `ROLLED_BACK` event carrying this same `attemptId` (B-02, B-03).
- Given the trailing event is no longer this attempt's `PENDING` event — planted
  as a `ROLLED_BACK` event for this attempt, and separately as a fresh `PENDING`
  event for a second `attemptId` admitted after it, each also driven through the
  existing `beforeLockAcquired`-style interleave seam so the change lands after
  the pair read — when completion runs, then it refuses `facts-changed-before-lock`
  naming both `attemptId`s, the lineage gains no event at any index, both
  accepted-pair files are byte-identical, and no snapshot directory's contents are
  read back onto disk — in particular the second attempt's snapshot is not
  restored and no event is appended for it (B-03).
- Given a `COMPLETED` trailing event, when the slice directory's pair is
  reopened, mutated or unlocked and `recoveryPreDispatchRefusal` runs, then it
  refuses with `completed-pair-drifted` naming the attempt; with the pair
  untouched it returns `undefined` (B-04).
- Given a `COMPLETED` trailing event and the replacement pair on disk, when
  `admitStaleRenegotiation` repeats the exact target and reason, then the
  outcome is `replay-completed-no-op`, the run-state document is unchanged, no
  new snapshot directory exists and both pair files are byte-identical (B-05).
- Given the same state, when the repeat names a different target or a
  differently-trimmed reason, then it is refused `replay-conflict` with the
  completed `attemptId` in the message and nothing is written (B-10).
- Given the same state with a different valid `LOCKED` pair on disk, when
  admission runs, then a new `attemptId`, a new snapshot directory and one new
  `PENDING` event appear (B-11).
- Given a run-state document holding a `COMPLETED` event, when it is loaded,
  then the three `COMPLETED`-only fields round-trip; a `COMPLETED` event missing
  one, or a `PENDING`/`ROLLED_BACK` event carrying one, is dropped by
  `sanitizeRecoveryLineage`; and a v7 file with no `COMPLETED` event still loads
  unchanged (B-12).
- Given the existing recovery fixture in `src/resume-integration.fixtures.ts`,
  when its lineage is driven `PENDING -> COMPLETED` through the exported seams,
  then the end-to-end path is proven without a spawned pipeline scenario and
  without a live recovery launch (B-02, B-04, P-05).
- Given the suites over the preserved surfaces, when they run unedited, then
  #277's `--renegotiate-stale` entry-point refusal tests and the
  restore/rollback/reconciliation tests all pass (P-01 through P-05).

## Definition of done

- [ ] Each behavior above has at least one test whose name contains its anchor id
      (`B-01` … `P-05`), so `acceptance:behaviors` can select it.
- [ ] `pnpm run typecheck` passes.
- [ ] `pnpm vitest run src/preserve-work-recovery.test.ts src/run-state.test.ts`
      passes.
- [ ] `pnpm run test:fast` passes, plus the heavy suite this slice touches
      (`pnpm run test:heavy:resume`).
- [ ] The slice's diff touches only the seven paths listed under "Files expected
      to change"; in particular `src/cli-options.ts`, `src/orchestrator.ts`,
      `src/wave.ts`, `src/run-events.ts`, `src/run-snapshot.ts`, `src/status.ts`,
      `src/afk.ts`, `src/afk-claude.ts` and `src/afk-codex.ts` are unchanged.
- [ ] `src/preserve-work-recovery.ts` contains no import of `./artifacts.js`,
      `./contract-transaction.js`, `./orchestrator.js` or `./wave.js`, and no
      `**Lock-Provenance:**` literal.
- [ ] `RUN_STATE_VERSION` is still 7 and no migration file was added.
- [ ] The `Preserved-work recovery` row in ARCHITECTURE.md names the `COMPLETED`
      outcome and replay (#335) and the file stays within its 150-line cap.
