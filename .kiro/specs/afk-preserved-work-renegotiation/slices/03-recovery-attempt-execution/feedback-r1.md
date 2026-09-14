# Contract review — round 1 (slice 03, recovery attempt execution)

## What already holds up

This contract is unusually well anchored. Every line citation I checked
resolves: `hasOpenRecoveryAttempt` at `src/preserve-work-recovery.ts:551`,
`publishAcceptedPairSnapshot` at `:478-548`, `clearExactStageCheckpoint` at
`src/exact-stage-resume.ts:179`, `inspectExactStageCheckpoint` at `:133` with
`action: "reevaluate"` a real member of `ExactStageResumeDecision` (`:29-30`),
`loadContractFindingLineage` / `saveContractFindingLineage` /
`emptyContractFindingLineage` at `src/contract-convergence.ts:561` / `:609` /
`:78`, and the `--renegotiate-stale` refusal at `src/cli-options.ts:393-399` on
the one shared `parsePipelineRuntimeOptions` path. P-02 cites the right guard
rather than the three entry files, which is the more durable pin.

Three judgment calls are the right ones and are recorded rather than left
implicit:

- Resolving the explorer's open question about where the six-file history lives
  by reusing the attempt's existing directory identity
  (`recovery-snapshots/<attemptId>/negotiation/`) instead of inventing a second
  locator, and mirroring the temporary-sibling-plus-`renameSync` publish that
  the accepted-pair snapshot already uses, with the deletion strictly after the
  byte-verified copy. B-02's observable binds both the success path and the
  seam-driven failure path (no live file deleted, no partial directory), which
  is what makes the ordering testable rather than aspirational.
- Ruling `clearSliceStateForDispatch` out by name, with the reason. That
  function deletes `state.slices[ghIssue]` wholesale and is the coarser dispatch
  clear; reaching for it would have quietly violated B-06.
- Declaring the orchestrator dispatch of the explorer and planner/evaluator
  roles a non-goal. The explorer could not locate an entry point for that pair,
  and the entry-point refusal keeps this path unreachable from a live run, so
  delivering the *state* those roles start from is the honest scope. That said,
  see the note on B-07 below — the narrowing is disclosed in the non-goals but
  B-07's `then` still reads as though the roles running is what gets proven.

Scope, gates and size all look right: the two `preservation: true` clears are
wrapped rather than edited, no migration is claimed, no run-state field or
schema bump is added, no ref is touched, and the work is one module plus tests
plus an ARCHITECTURE.md row — comfortably one session. Nothing here changes a
parser's accepted input language, so no fixture-surface obligation applies.

## What has to change before this can lock

**The "contract-stage checkpoint" does not exist as a thing this repository can
hold.** `ExactStageCheckpoint.completedStage` is
`CompletedCandidateStage = "deterministic-qa" | "shared-preview-uat"`
(`src/exact-stage-resume.ts:14-16, 20-26`), and `inspectExactStageCheckpoint`
takes an `expectedCompletedStage` and only ever decides whether to resume one of
those two deterministic stages. The explorer flagged exactly this as an open
question; the contract answered it by naming a checkpoint variant instead of
resolving it.

That leaves the generator with two materially different slices and no way to
tell which one is wanted:

- If a checkpoint entry can exist for the target, its `completedStage` is
  `deterministic-qa` or `shared-preview-uat`. Then B-05 clears *QA-stage resume
  state* for the target — and B-06 asserts "implementation and QA state ...
  unchanged", with an observable that admits a difference only in
  `stageCheckpoints[target]` and `contractConvergence[target]`. Those two read
  as contradicting each other unless B-06 says explicitly that the target's
  stage checkpoint is the QA-stage entry being deliberately dropped.
- If no checkpoint entry can exist for a contract-stage target, the clear is a
  defensive no-op, B-05's Given cannot seed what it says it seeds, and B-07's
  `action: "reevaluate"` is true before execution as well as after — a test that
  cannot fail.

Adding a `CompletedCandidateStage` member is not an escape: the Definition of
done requires `src/exact-stage-resume.ts` to stay unmodified. So pick the
reading, say which entry the test seeds and with what `completedStage`, narrow
B-06's preservation clause so it no longer collides, and give B-07's observable
the pre-execution value it is measured against so it can fail for the right
reason.

Two smaller things, neither of which blocks a lock:

- P-02's `acceptance:behaviors` gate needs a test whose name carries `P-02`. The
  refusal is pinned today by `src/cli-options.test.ts:458` as
  `[behavior:#277:B-12]`, and that file is not in `fileScope`. Say where the
  P-02-named assertion lands, and put that file in scope.
- The invariant B-02 leans on is written in `src/preserve-work-recovery.ts:472-476`
  as a property of the published *directory*, not of the pair files. Execution
  adds a `negotiation/` child into a published attempt directory, so that
  docstring should be narrowed to the pair files as part of this slice — or the
  history should sit outside the published directory.
