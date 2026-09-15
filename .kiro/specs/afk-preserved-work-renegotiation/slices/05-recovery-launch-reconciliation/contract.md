# Slice Contract — Recovery launch reconciliation

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #334
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 1

## Scope lock

A launch resolves an unresolved recovery attempt before it does anything else.
One new exported routine in `src/preserve-work-recovery.ts` reads the run's
recovery lineage, and for every target whose trailing event is `PENDING` or
`ROLLBACK_FAILED` calls #333's already-exported `restoreAcceptedPairFromSnapshot`
on the snapshot that event names, appending `ROLLED_BACK` when the restore
verifies and `ROLLBACK_FAILED` when it does not, under the ADR 0056 run-state
lock. One call site at the top of `runPipeline` — the single function all three
provider entry points converge on — runs it before run-scope resolution, before
ordinary resume decides anything, and before any agent dispatch. Because #277's
entry-point refusal of `--renegotiate-stale` stays in force, every reachable
launch carries no exact recovery request, so a launch that reconciled anything
stops there: it writes one operator-facing `run.log` line per target naming the
target, the appended outcome and the retry the operator needs, and returns an
unsuccessful `PipelineResult` without dispatching. This slice adds no second
restore implementation, no second verification rule, and removes no refusal.

### In scope

- [behavior:B-01] `src/preserve-work-recovery.ts` exports
  `reconcileRecoveryLineage({ repoRoot, prdSlug, runSlug? })` returning one
  typed per-target outcome record (target `ghIssue`, `attemptId`, the appended
  event's state or the fact that nothing was appended, `snapshotPath`, and the
  failure message when the restore failed), ordered by `ghIssue` so the caller's
  log lines are deterministic. It reconciles every target in that run-state
  file's `recoveryLineage` whose trailing event is `PENDING` or
  `ROLLBACK_FAILED` (the same unresolved predicate `rollbackableEvent` already
  applies at `src/preserve-work-recovery.ts:1293-1302`), and no other target
  (PRD "Recovery State Machine"; issue AC2, AC3).
- [behavior:B-02] Each unresolved target is reconciled by calling the existing
  `restoreAcceptedPairFromSnapshot` (`src/preserve-work-recovery.ts:1161`) with
  the trailing event's `RecoveryAttemptLocator` fields, then — under
  `transactRunState` (ADR 0056) — rereading run state, rechecking that the
  trailing event is still the same `attemptId` in the same state, admitting the
  transition through `isLegalRecoveryTransition`, and appending exactly one
  event via `appendRecoveryLineageEvent`: `ROLLED_BACK` on a verified restore,
  `ROLLBACK_FAILED` carrying `rollbackError` and the observed fingerprints
  otherwise. Both append branches are obligations of this behavior, and the
  failing branch is the only place this slice writes `rollbackError`,
  `observedContractFingerprint` and `observedManifestFingerprint` — the three
  fields that exist for `ROLLBACK_FAILED` only (`src/run-state.ts:284-341`) —
  so a trailing-`PENDING` target whose restore fails appends exactly one
  `ROLLBACK_FAILED` event carrying the failure message as `rollbackError` and
  the fingerprints observed on disk, with an absent destination file recorded as
  the explicit absent marker #333 already writes rather than as a blank. This is
  #333's two-phase sequence (restore outside the lock, append inside it) reused,
  not a second one (issue AC4; PRD "Attempt Execution and Failure Semantics").
- [behavior:B-03] The restore destination is derived from the trailing event's
  `snapshotPath`, and the derivation is guarded on the locator's real shape.
  `publishAcceptedPairSnapshot` builds the locator as `relative(repoRoot,
  join(sliceDir, RECOVERY_SNAPSHOT_DIRNAME, attemptId))` normalized to forward
  slashes (`src/preserve-work-recovery.ts:519-520,569`, with
  `RECOVERY_SNAPSHOT_DIRNAME` = `recovery-snapshots` at
  `src/preserve-work-recovery.ts:86`), so a well-formed locator always splits
  into at least three `/` segments whose penultimate segment is exactly
  `RECOVERY_SNAPSHOT_DIRNAME`. Reconciliation therefore accepts a
  `snapshotPath` only in the form `<sliceDir>/recovery-snapshots/<attemptId>`:
  at least three segments, every segment non-empty and neither `.` nor `..`,
  the penultimate segment equal to `RECOVERY_SNAPSHOT_DIRNAME`, and hence a
  non-empty derived `<sliceDir>` — the grandparent of the resolved snapshot
  directory, which is the target's artifact directory. Every other locator is
  rejected before any file is read or written: it is reconciled to no restore
  and no append, and reported as a failed reconciliation naming the rejected
  locator and the destination it would have derived. The rejected set
  explicitly includes a two-segment `recovery-snapshots/<attemptId>`, whose
  grandparent is the empty string and whose derived destination would collapse
  onto `repoRoot` and rewrite `contract.md` and `acceptance-manifest.json` at
  the repository root — a destination this slice never intends, and one B-07's
  "only the two accepted-pair files change" cannot catch, because those are two
  accepted-pair files. Decision recorded here rather than escalated: it is
  internal to this slice, keeps the recorded locator the single source of truth
  as `restoreAcceptedPairFromSnapshot`'s doc comment requires, and needs no run
  scope, DAG or worktree to be resolved first.
- [behavior:B-04] `runPipeline` (`src/orchestrator.ts:8217`) calls
  `reconcileRecoveryLineage` once, as the first statement inside its top-level
  `try` (currently `src/orchestrator.ts:8497-8508`) — before
  `assertWithinManifestScope`, before the `resolveRunScope` state write, before
  `prepareSliceWorktree`'s resume decision, and before any provider invocation.
  All three entry points (`src/afk.ts:295`, `src/afk-claude.ts:261`,
  `src/afk-codex.ts:261`) call `runPipeline` exactly once, so the one call site
  is every provider entry point (issue AC2, AC3, AC5).
- [behavior:B-05] When the reconciliation reported at least one target,
  `runPipeline` writes one `logger.phase(...)` line per reported target naming
  the target `ghIssue`, the appended outcome (`ROLLED_BACK`,
  `ROLLBACK_FAILED`, or that nothing was appended and why) and the retry the
  operator needs, then returns `{ success: false, summary, consoleSummary,
  failureReason }` whose `failureReason` names the reconciled targets and says
  the launch stopped after reconciliation. It dispatches no agent, resolves no
  run scope, and moves no resume counter (issue AC5, AC6; PRD "Failure Matrix",
  process-death row). The named retry is fixed per outcome, so the line's
  promised content is derivable rather than left to the implementer:
  - `ROLLED_BACK` — relaunch the same command; the lineage is now terminal, so
    P-03's path runs the launch normally.
  - `ROLLBACK_FAILED` appended this launch — repair the snapshot directory the
    line names (its `contract.md` and `acceptance-manifest.json` must again read
    as a valid `LOCKED` pair matching the event's recorded fingerprints), then
    relaunch; the next launch retries from the same `snapshotPath` under
    `ROLLBACK_FAILED -> ROLLED_BACK`.
  - nothing appended — a trailing `ROLLBACK_FAILED` whose retry failed again
    (B-06), or a rejected locator (B-03). No relaunch can move the lineage on
    its own, so the line says the hold is intentionally terminal until #335
    supplies the completion path, and names what a human must fix first: for the
    retry-failed case the same snapshot repair as above, and for a rejected
    locator the fact that the recorded `snapshotPath` is unusable, so the target
    stays held until #335's attempt-state reporting can resolve it. In both
    cases the line names the run-state file and the `attemptId`, and says a
    relaunch alone will report the same target and stop again.
- [behavior:B-06] Reconciliation is append-only: it never edits or deletes a
  prior lineage event, never writes inside a published snapshot directory, and
  never rewrites a prior attempt's `attemptId`. A `ROLLBACK_FAILED` target
  whose retry fails again appends nothing, because
  `ROLLBACK_FAILED -> ROLLBACK_FAILED` is not a legal transition, so the
  existing hold stays in force; after a `ROLLED_BACK` append,
  `admitStaleRenegotiation` (`src/preserve-work-recovery.ts:644`) is no longer
  blocked by `hasOpenRecoveryAttempt` and mints a new `attemptId` and a new
  snapshot directory for a fresh attempt (issue AC7, AC8; PRD "No attempt
  changes from `ROLLED_BACK` or `ROLLBACK_FAILED` back to `PENDING`").
- [behavior:B-07] Reconciliation runs no git command and no `git.ts` helper: it
  writes only the two accepted-pair files in the target's artifact directory
  (through `restoreAcceptedPairFromSnapshot`) and the run-state file, leaving
  the preserved worktree, slice branch, feature branch and every commit
  unchanged — ADR 0039 as already cited for rollback at
  `src/preserve-work-recovery.ts:1361-1363` (issue AC9).

### Non-goals (explicit out-of-scope)

- Lifting or weakening #277's `--renegotiate-stale` entry-point refusal, or
  adding a `staleRenegotiation` field to `PipelineConfig` — the completion path
  that makes the flag usable is #335.
- The completion path, the pre-dispatch fingerprint check, replay identity and
  attempt-state reporting (#335), and `--extend-scope` (#278).
- Wiring `recoveryDispatchRefusal` into per-slice dispatch: launch-time
  reconciliation is what this slice adds, and the existing fail-closed hold
  remains unwired at any dispatch site.
- Any change to `restoreAcceptedPairFromSnapshot`, `rollBackRecoveryAttempt`,
  the transition table, or the persisted lineage event shape.
- Reconciling lineage belonging to another run-state file, or any git merge,
  reset, rebase, restart, adoption or cleanup.

### Existing behavior to preserve

- [behavior:P-01] `src/cli-options.ts:390-399`
  (`parsePipelineRuntimeOptions`) still refuses any `--renegotiate-stale`
  invocation with its current message, and the tests asserting it
  (`src/cli-options.test.ts:347-433,563-564`, `src/cli-entries.test.ts:79-83`,
  `src/preserve-work-recovery.test.ts:1592-1622`) stay green and unedited
  (issue AC10; PRD "Delivery slices").
- [behavior:P-02] `restoreAcceptedPairFromSnapshot`,
  `rollBackRecoveryAttempt`, `recoveryDispatchRefusal`,
  `isLegalRecoveryTransition` and `appendRecoveryLineageEvent` keep their
  current signatures and behavior; the new routine calls them and adds no
  parallel restore or verification path (issue "adds no second restore
  implementation").
- [behavior:P-03] A launch whose run state carries no `recoveryLineage` (or
  whose every target's trailing event is terminal) behaves exactly as today:
  `reconcileRecoveryLineage` reports no target, `runPipeline` writes no extra
  `run.log` line, refuses nothing, and continues into the run it would have run
  before this slice (issue AC1).

### Changes to existing behavior (only if the issue asks for it)

- `runPipeline` gains one early exit: a launch that reconciled an unresolved
  attempt returns unsuccessfully instead of running, authorized by issue AC6
  ("A launch carrying no exact recovery request exits after reconciliation").

## Files expected to change

- src/preserve-work-recovery.ts
- src/orchestrator.ts
- src/preserve-work-recovery.test.ts
- src/resume-integration.test.ts
- src/resume-integration.fixtures.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- None — uses existing patterns: `transactRunState` (ADR 0056),
  `appendRecoveryLineageEvent`, `RunJournal.phase`, and #333's exported
  restore-and-verify routine. No run-state schema change, so
  `sanitizeRecoveryLineage` needs no new field.

## Test plan

- Given run state whose target's trailing event is `PENDING` and whose snapshot
  holds the accepted pair, when `reconcileRecoveryLineage` runs, then the pair
  files are byte-restored, exactly one `ROLLED_BACK` event is appended for the
  same `attemptId`, and the prior events are unchanged.
- Given run state whose trailing event is `ROLLBACK_FAILED` and whose snapshot
  now verifies, when reconciliation runs, then `ROLLED_BACK` is appended from
  the same `snapshotPath` and the `recoveryDispatchRefusal` hold clears.
- Given a trailing `ROLLBACK_FAILED` whose snapshot is still unreadable, when
  reconciliation runs, then nothing is appended, the outcome reports the failure
  message, and the hold stays in force.
- Given a trailing `PENDING` whose snapshot files were deleted, when
  reconciliation runs, then exactly one `ROLLBACK_FAILED` event is appended for
  the same `attemptId` carrying `rollbackError` and both observed fingerprints,
  and the destination pair is left as it was.
- Given a trailing `PENDING` whose `snapshotPath` is the two-segment
  `recovery-snapshots/<attemptId>`, when reconciliation runs, then no file is
  read or written under the repository root, `contract.md` and
  `acceptance-manifest.json` at the repository root are unchanged (or still
  absent), nothing is appended, and the outcome names the rejected locator and
  the destination it would have derived. Same for a locator whose penultimate
  segment is not `recovery-snapshots`, and for a single-segment locator.
- Given the operator line for each of the three reported outcome families, when
  a reconciled launch writes it, then the line carries the retry B-05 fixes for
  that outcome, and the append-nothing line says the hold is terminal until
  #335 and names the run-state file and `attemptId`.
- Given run state with no `recoveryLineage`, and given one whose trailing event
  is `ROLLED_BACK`, when reconciliation runs, then it reports no target and the
  run-state file bytes are unchanged.
- Given a target reconciled to `ROLLED_BACK`, when `admitStaleRenegotiation`
  runs for the same target, then it admits a new attempt with a different
  `attemptId` and a new snapshot directory, and the prior attempt's snapshot
  directory contents are untouched.
- Given a target reconciled to `ROLLED_BACK`, when the slice branch, feature
  branch and worktree are compared before and after, then every ref, commit and
  worktree file is identical.
- Process-death case, through the orchestrator seam: given the recovery fixture
  with a trailing `PENDING` event planted in run state and no live process, when
  `runPipeline` is invoked once with a recording stub provider, then the run
  returns `success: false` with a `failureReason` naming the target, `run.log`
  carries the operator line with the appended outcome and the retry, the
  provider recorded zero invocations, and `resume[ghIssue].attempts` is
  unchanged. One spawned `runPipeline` is used because the claim is dispatch
  order at the orchestrator seam and no existing spawned scenario carries
  unresolved lineage; the run exits before any agent invocation or worktree
  creation, so it costs no agent round.
- Given the same fixture with no lineage planted, when `runPipeline` is invoked,
  then `run.log` carries no reconciliation line.

## Definition of done

- [ ] `reconcileRecoveryLineage` is exported from
  `src/preserve-work-recovery.ts` and is the only new reconciliation entry
  point; it calls `restoreAcceptedPairFromSnapshot` and appends through
  `appendRecoveryLineageEvent` inside `transactRunState`.
- [ ] `src/orchestrator.ts` has exactly one call to it, before
  `assertWithinManifestScope`, the `resolveRunScope` write, resume and dispatch.
- [ ] A reconciled launch writes one `run.log` line per reported target naming
  target, appended outcome and the retry B-05 fixes for that outcome, and
  returns `success: false` with a `failureReason` naming the targets.
- [ ] A `snapshotPath` not of the form `<sliceDir>/recovery-snapshots/<attemptId>`
  — including the two-segment `recovery-snapshots/<attemptId>` — restores
  nothing, appends nothing, and never writes at the repository root.
- [ ] A trailing-`PENDING` target whose restore fails appends exactly one
  `ROLLBACK_FAILED` event carrying `rollbackError` and both observed
  fingerprints.
- [ ] A launch with no unresolved lineage adds no `run.log` line and no refusal.
- [ ] Every behavior anchor above has a test named with its
  `[behavior:#334:<id>]` tag; `pnpm run typecheck` and the touched suites pass.
- [ ] `--renegotiate-stale` is still refused at all three entry points, with
  its existing tests unedited.
