# Slice Contract — Recovery attempt execution

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #332
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

Run the recovery attempt that #277's `PENDING` event admitted, for exactly the
two steps `prd.md` "Attempt Execution and Failure Semantics" fixes: preserve
then clear the target's live negotiation state. Given a committed `PENDING`
lineage event for the target, one new exported entry point in
`src/preserve-work-recovery.ts` byte-copies the current bytes of `context.md`,
`contract-review.json`, `contract-response.json`,
`contract-negotiation-outcome.json`, `planner-escalation.md` and every
`feedback-r<N>.md` into that attempt's immutable history, deletes only those
live copies, and then clears only the target's own `stageCheckpoints` entry and
its `contractConvergence` entry through wrappers over the focused run-state APIs
that own them — leaving the state a fresh explorer plus planner/evaluator
negotiation would find. It appends no lineage event, mutates no ref, touches no
accepted-pair byte, and removes no refusal, so `--renegotiate-stale` stays
refused and no live run reaches this code path (`prd.md` "Delivery slices").

### In scope

- [behavior:B-01] `src/preserve-work-recovery.ts` exports one execution entry
  point that reads run state first and refuses unless the target's recovery
  lineage ends on a committed `PENDING` event, reusing the existing
  `hasOpenRecoveryAttempt` read (`src/preserve-work-recovery.ts:551`). A
  refusal returns a stable `RecoveryRefusalCode` member added by this slice and
  writes nothing at all — no byte under the target's slice directory, no
  run-state field (GH #332 AC1).
- [behavior:B-02] With a committed `PENDING` event, the six live negotiation
  file kinds above, when present, are byte-copied into the attempt's immutable
  history — a `negotiation/` directory beneath the attempt's already-published
  snapshot directory `recovery-snapshots/<attemptId>/`
  (`RECOVERY_SNAPSHOT_DIRNAME`, `src/preserve-work-recovery.ts:76`) — and the
  copy is byte-verified by re-reading it and atomically published through a
  temporary sibling plus one `renameSync`, following
  `publishAcceptedPairSnapshot` (`src/preserve-work-recovery.ts:478-548`),
  before any live file is deleted. *Decision recorded here:* `prd.md`
  Admission step 3 gives an attempt exactly one immutable directory identity,
  keyed by `attemptId` beneath the target's artifact directory, so this history
  reuses that identity instead of inventing a second one; a subdirectory keeps
  the published pair's two files unmodified. *Decision recorded here:* because
  `publishAcceptedPairSnapshot`'s docstring today states the invariant as a
  property of the published *directory* ("A published directory is never
  overwritten", `src/preserve-work-recovery.ts:472-476`), this slice narrows that
  wording in place to the published pair files — the two pair bytes and their
  fingerprints are never overwritten, and the `attemptId` directory still refuses
  a second publish (`:495-501`, unchanged). The history lands inside the attempt
  directory rather than outside it so an attempt keeps exactly one immutable
  locator; the narrowed wording, not a second directory, is what removes the
  apparent contradiction (GH #332 AC2, `prd.md` "Attempt Execution", ADR 0039's
  reasoning applied to artifacts: no immutable record of what was accepted is
  clobbered).
- [behavior:B-03] Exactly the files copied in B-02 are then deleted from the
  live slice directory: every `feedback-r<N>.md` round present, and no other
  path. A named file that is absent is skipped without error and without
  failing execution (GH #332 AC3).
- [behavior:B-04] Across execution, the `reviews/` subdirectory's contents,
  every implementation and QA artifact under the target's slice directory, and
  the published `contract.md` / `acceptance-manifest.json` bytes inside
  `recovery-snapshots/<attemptId>/` stay byte-identical (GH #332 AC4).
- [behavior:B-05] Execution clears exactly two run-state entries for the target
  and nothing else: its `state.stageCheckpoints[ghIssue]` entry, whatever that
  entry's `completedStage` value is, and its `contractConvergence` entry. Each
  clear goes through a thin wrapper in `src/preserve-work-recovery.ts` over the
  focused API that owns it — `clearExactStageCheckpoint`
  (`src/exact-stage-resume.ts:179`) and `saveContractFindingLineage` with
  `emptyContractFindingLineage()` (`src/contract-convergence.ts:609`, `:78`).
  Neither owning module is modified, and `clearSliceStateForDispatch`
  (`src/run-state.ts:1567`) is not used: it is the coarser dispatch clear, not a
  per-attempt one. *Decision recorded here:* the only checkpoint this repository
  can hold is an `ExactStageCheckpoint` whose `completedStage` is
  `"deterministic-qa"` or `"shared-preview-uat"`
  (`src/exact-stage-resume.ts:14-16, 20-26`); there is no contract-stage variant,
  and adding one is forbidden by this slice's Definition of done. `prd.md`
  "Attempt Execution and Failure Semantics" resolves which reading is meant:
  leaving these controls live "would let a stale outcome or exact-stage
  checkpoint bypass the required fresh explorer and negotiation on the next
  attempt" (`prd.md:171-175`). So the entry this slice removes is a real
  post-QA-stage checkpoint, and the test seeds
  `state.stageCheckpoints[<target ghIssue>] = { version: 1, completedStage:
  "deterministic-qa", candidateTreeId: <40-hex>, nextPendingStage:
  "post-qa-deterministic", round: 1 }` — a value `parseCheckpoint` accepts
  (`src/exact-stage-resume.ts:67-109`). The observable of the clear is the
  absence of that key afterwards, with the second slice's key still present
  (GH #332 AC5).
- [behavior:B-06] Execution leaves every other persisted fact unchanged:
  resume counters and attempts, slice outcomes, migration claims, guardian
  history, `scope`, `reviewPhase`, the recovery lineage itself, and every other
  slice's entry in `stageCheckpoints` and `contractConvergence`. Implementation
  and QA state is preserved with one named exception, which B-05 deliberately
  drops: the target's own `stageCheckpoints[ghIssue]` entry — a post-QA-stage
  resume checkpoint — is removed, so "implementation and QA state unchanged"
  here means the target's implementation and QA *artifacts*, its
  `slices[ghIssue]` record, its round and attempt counters, its worktree and its
  branch, not its exact-stage resume checkpoint. Nothing else under
  `stageCheckpoints` or in any QA-related field changes (GH #332 AC6, narrowed
  against `prd.md:166-175`).
- [behavior:B-07] The clear is proven against a measured pre-execution value,
  not asserted in isolation. Before execution, with the B-05 checkpoint seeded
  and `currentCandidateTreeId` equal to its `candidateTreeId`,
  `inspectExactStageCheckpoint` (`src/exact-stage-resume.ts:133`) called with
  `expectedCompletedStage: "deterministic-qa"` returns `action: "resume"`
  carrying that checkpoint, and `loadContractFindingLineage`
  (`src/contract-convergence.ts:561`) reports the seeded non-empty lineage.
  After execution, the same two calls return `action: "reevaluate"` (with
  `reason` "no exact-stage checkpoint was recorded for this slice", the branch at
  `:147-152`) and an empty lineage. So exact-stage resume can return no resume
  decision for the target and the ordinary path runs explorer fact collection and
  then the planner/evaluator negotiation — which this slice does not dispatch
  (see non-goals); it delivers the state those roles start from (GH #332 AC7,
  `prd.md` "Exact-stage resume cannot skip either role").
- [behavior:B-08] No code path added by this slice invokes a git merge, reset
  or rebase, or writes to the preserved worktree, slice branch or feature
  branch: the target's worktree, slice branch, commits, implementation-round
  count and resume-attempt count are unchanged by execution (GH #332 AC8,
  ADR 0039: recovery must never lose unmerged commits).
- [behavior:B-09] Execution appends no lineage event of any state: after it
  returns, the target's lineage is byte-identical to the admitted lineage and
  still ends on the same `PENDING` event. No `COMPLETED`, `ROLLED_BACK` or
  `ROLLBACK_FAILED` is written — verified restore is #333 (GH #332 AC10,
  `prd.md` "Delivery slices").

### Non-goals (explicit out-of-scope)

- Verified restore of the accepted pair and the `ROLLED_BACK` /
  `ROLLBACK_FAILED` events, plus the fail-closed dispatch hold — #333.
- Launch-time reconciliation of an unresolved attempt — #334.
- The `COMPLETED` terminal event, the pre-dispatch fingerprint check, replay
  identity, attempt-state reporting, and removing the `--renegotiate-stale`
  refusal — #335.
- `--extend-scope` and any persisted-scope mutation — #278.
- A second recovery command, a second admission rule, or any change to
  `admitStaleRenegotiation`'s eligibility or refusal set.
- Wiring an orchestrator dispatch of the explorer or planner/evaluator roles:
  the refusal keeps this path unreachable from a live run, so this slice
  delivers the state those roles start from (B-07), not a call into them.
- A new persisted run-state field or schema version bump: the attempt's
  history is located from the existing `snapshotPath` locator, so nothing new
  is recorded.

### Existing behavior to preserve

- [behavior:P-01] `admitStaleRenegotiation`
  (`src/preserve-work-recovery.ts:618`) still appends exactly one `PENDING`
  event as its only mutation, with its existing sequence, refusal codes and
  test seams unchanged (`prd.md` Admission Protocol step 5).
- [behavior:P-02] The `--renegotiate-stale` refusal on the one shared parse
  path all three entry points use (`src/cli-options.ts:393-399`,
  `parsePipelineRuntimeOptions`) is still in force after this slice merges, and
  `parseStaleRenegotiationRequest`'s validation messages are unchanged. The
  `P-02`-named assertion is added to `src/preserve-work-recovery.test.ts`
  (already in this slice's file scope), importing `parsePipelineRuntimeOptions`
  and `parseStaleRenegotiationRequest` from `src/cli-options.js`, so the
  `acceptance:behaviors` gate's `--testNamePattern P-02` matches a test inside
  the declared scope. `src/cli-options.test.ts` is deliberately **not** added to
  the file scope: its existing pins — the refusal at
  `src/cli-options.test.ts:458` (`[behavior:#277:B-12] throws a refusal naming
  #335 ...`) and the `parseStaleRenegotiationRequest` message assertions beside
  it — stay untouched, and P-02 re-pins the same two facts from this slice's own
  test file rather than editing #277's (GH #332 AC10, `prd.md` "Until #335
  merges").
- [behavior:P-03] `clearExactStageCheckpoint` and `saveContractFindingLineage`
  keep their current signatures and semantics for their existing callers,
  including `runPendingDeterministicStage`'s checkpoint consumption
  (`src/exact-stage-resume.ts:210-234`) (GH #332 AC5).
- [behavior:P-04] Execution changes no byte of the live `contract.md` or
  `acceptance-manifest.json`. The replacement pair reaches `LOCKED` only
  through the accepted-pair validation, mechanical lock gate and lock
  provenance a first negotiation already uses; this slice adds no second
  validation path, no bypass, and no writer of `**Status:** LOCKED`
  (GH #332 AC9, ADR 0008 orchestrator owns contract Status, ADR 0055
  accepted-pair validation, lock gate and provenance).

### Changes to existing behavior (only if the issue asks for it)

- `RecoveryRefusalCode` (`src/preserve-work-recovery.ts:86-114`) gains one
  member for "no committed `PENDING` attempt for this target", which B-01
  requires as a stable identity (GH #332 AC1).
- `publishAcceptedPairSnapshot`'s docstring
  (`src/preserve-work-recovery.ts:472-476`) has its never-overwritten invariant
  narrowed from the published *directory* to the published *pair files*, because
  B-02 adds a `negotiation/` child inside an already-published attempt
  directory. Comment wording only: the refusal at `:495-501`, its code
  `snapshot-already-published`, and its message are unchanged, so no caller and
  no test of that refusal is affected (F-03).

## Files expected to change

- src/preserve-work-recovery.ts
- src/preserve-work-recovery.test.ts
- src/resume-integration.fixtures.ts
- src/resume-integration.test.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- None — uses existing patterns: the `publishAcceptedPairSnapshot` temporary-
  sibling-plus-`renameSync` publish, the module's existing exported test seams,
  and the two focused run-state clear APIs behind wrappers.

## Test plan

- Given run state with no lineage for the target, when execution runs, then it
  refuses with the new code and the slice directory and run-state file are
  byte-identical afterwards.
- Given a target whose lineage ends on a terminal event, when execution runs,
  then it refuses the same way — only a committed `PENDING` admits execution.
- Given a slice directory holding all six live negotiation file kinds including
  `feedback-r1.md` and `feedback-r2.md`, when execution runs, then
  `recovery-snapshots/<attemptId>/negotiation/` holds each file's exact bytes
  and none of the six remains live.
- Given a slice directory where three of the six are absent, when execution
  runs, then execution succeeds, copies and deletes only the present ones, and
  reports which kinds it moved.
- Given the copy step fails byte verification (driven through the exported
  seam), when execution runs, then no live file has been deleted and no
  partial history directory is published.
- Given `reviews/`, a QA report and an implementation artifact in the slice
  directory, when execution runs, then all of them and the published pair
  snapshot are byte-identical afterwards.
- Given `state.stageCheckpoints` holding, for the target, `{ version: 1,
  completedStage: "deterministic-qa", candidateTreeId: <40-hex>,
  nextPendingStage: "post-qa-deterministic", round: 1 }` and a second entry for
  another slice, plus a non-empty contract-convergence lineage for both, when
  execution runs, then the target's `stageCheckpoints` key is absent and its
  lineage is empty, while the second slice's checkpoint entry and lineage are
  byte-identical.
- Given the same seeded state, when `inspectExactStageCheckpoint` is called for
  the target with `expectedCompletedStage: "deterministic-qa"` and a matching
  `currentCandidateTreeId` *before* execution, then it returns `action:
  "resume"` — so the same call after execution returning `action: "reevaluate"`
  proves the clear rather than passing vacuously.
- Given run state carrying resume attempts, a slice outcome, migration claims
  and guardian history (built on the existing resume/negotiation fixture in
  `src/resume-integration.fixtures.ts`, extended rather than replaced — no
  spawned pipeline scenario, because the state is reachable without one), when
  execution runs, then every one of those fields is unchanged.
- Given execution has completed, when `inspectExactStageCheckpoint` is called
  for the target with the same inputs, then it returns `action: "reevaluate"`
  with reason "no exact-stage checkpoint was recorded for this slice", and
  `loadContractFindingLineage` reports an empty lineage.
- Given the same seeded run state, when execution completes, then the target's
  `slices[ghIssue]` record, its implementation-round and resume-attempt counters
  and every QA artifact under its slice directory are unchanged — the only
  QA-related loss is the target's `stageCheckpoints` entry.
- Given a preserved worktree with commits ahead, when execution runs, then the
  slice branch tip, feature branch tip and worktree status are unchanged and no
  merge, reset or rebase was invoked.
- Given a committed `PENDING` event, when execution completes, then the
  target's recovery lineage is unchanged and still ends on that `PENDING`
  event.
- Given a well-formed `--renegotiate-stale` / `--recovery-reason` pair, when
  `parsePipelineRuntimeOptions` parses it, then it still throws the #335
  refusal — asserted by a `P-02`-named test in
  `src/preserve-work-recovery.test.ts`, alongside the unchanged
  `parseStaleRenegotiationRequest` validation messages, leaving
  `src/cli-options.test.ts` untouched and out of scope.

## Definition of done

- [ ] All nine `B-` behaviors and all four `P-` behaviors above are proven by
      tests in the files listed under Files expected to change.
- [ ] `src/exact-stage-resume.ts` and `src/contract-convergence.ts` are
      unmodified; the adaptation of each clear lands as a wrapper in
      `src/preserve-work-recovery.ts`.
- [ ] Execution is driven through exported seams only; no new spawned pipeline
      scenario is added, and the existing resume/negotiation fixture is
      extended for the run-state assertions.
- [ ] No lineage event, no accepted-pair byte, no ref and no refusal is written
      or removed by any path this slice adds.
- [ ] `publishAcceptedPairSnapshot`'s docstring states the never-overwritten
      invariant over the published pair files; its
      `snapshot-already-published` refusal, code and message are unchanged.
- [ ] The `P-02` assertion lives in `src/preserve-work-recovery.test.ts` and
      `src/cli-options.test.ts` is unmodified.
- [ ] ARCHITECTURE.md's "Preserved-work recovery" module row names attempt
      execution alongside admission.
- [ ] `pnpm run typecheck` and the touched suites are green.
