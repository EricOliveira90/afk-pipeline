# Contract review — round 2

Slice: `03-recovery-attempt-execution` (GH #332)

## What the revision fixed

**The checkpoint question (F-01) is settled, and settled correctly.** The pair
now picks reading (a) and says so out loud. B-05's Given names the object the
test seeds — `{ version: 1, completedStage: "deterministic-qa",
candidateTreeId: <40-hex>, nextPendingStage: "post-qa-deterministic",
round: 1 }` — and that object checks out against the code: it is exactly
`ExactStageCheckpoint` as declared (`src/exact-stage-resume.ts:20-26`), and
`parseCheckpoint` accepts it (`:67-109`, with `nextPendingStage` pinned to
`"post-qa-deterministic"` at `:97` and `round >= 1` at `:100-107`). Nothing in
the Given requires a new `CompletedCandidateStage` member, so the Definition of
done's "`src/exact-stage-resume.ts` unmodified" survives.

The B-05/B-06 collision is gone because B-06 now names the exception instead of
implying there is none: the target's own post-QA-stage checkpoint is
deliberately dropped, and "implementation and QA state unchanged" is scoped to
the artifacts, the `slices[ghIssue]` record, the counters, the worktree and the
branch. Worth noting a second-order thing the revision got right by accident or
design: because B-05's Given seeds a *second* slice's checkpoint,
`clearExactStageCheckpoint`'s behaviour of deleting the whole `stageCheckpoints`
key when the map empties (`:196-200`) cannot fire, so B-06's "the only differing
paths are `stageCheckpoints[target]` and `contractConvergence[target]`" is
literally true rather than approximately true.

B-07 is now a differential assertion rather than a standalone one: `action:
"resume"` before, `action: "reevaluate"` with reason "no exact-stage checkpoint
was recorded for this slice" after. That reason string is verbatim the branch at
`src/exact-stage-resume.ts:150`, so the assertion is both real and specific, and
it can no longer pass on a target that never held a checkpoint.

**P-02 has a home (F-02).** The `P-02`-named assertion goes in
`src/preserve-work-recovery.test.ts`, already in `fileScope`, importing
`parsePipelineRuntimeOptions` and `parseStaleRenegotiationRequest` from
`src/cli-options.js`. Both are genuinely exported (`src/cli-options.ts:318` and
`:163`) and the refusal being pinned is the one at `:393-399`, so
`--testNamePattern P-02` will match a test that can actually be written inside
the declared scope. Deciding to re-pin the two facts from this slice's own test
file rather than editing #277's is the right call, and the Definition-of-done
item that requires `src/cli-options.test.ts` to stay unmodified makes it
checkable.

**The invariant wording (F-03) is now asked for explicitly.** `Changes to
existing behavior` carries the docstring narrowing at
`src/preserve-work-recovery.ts:472-476` as a comment-only edit, holding the
`snapshot-already-published` refusal, its code and its message unchanged. That
matches the code: the refusal is a plain directory-existence check
(`:495-501`) with no dependence on how the docstring phrases the rule, so
narrowing the prose to the published pair files cannot move any behaviour. The
file is already in scope and a Definition-of-done item covers it.

## Two things to tidy, neither of them a blocker

**B-05's observable asks its test to prove something a test cannot see.** The
clause "asserts by module-level spy or import shape that
`src/exact-stage-resume.ts` and `src/contract-convergence.ts` are unmodified" is
a diff-level fact, not a runtime one — the prior wording ("git shows no
modification to ...") had it right. A spy can prove the wrapper delegates to the
two focused APIs and that `clearSliceStateForDispatch` is never invoked; it
cannot prove those files were not edited. The fact itself is not at risk, since
P-03's observable and the second Definition-of-done item both carry it. Best fix
is to leave the runtime-checkable clauses in B-05 and let the "unmodified"
claim live where it already lives.

**B-02's success-case atomicity assertion names the wrong temporary path.**
"no `.<attemptId>.partial` remains" points at
`publishAcceptedPairSnapshot`'s own temporary sibling under
`recovery-snapshots/` (`src/preserve-work-recovery.ts:502`) — a path #277's
admission creates and consumes, and one this slice never writes. The negotiation
history's temporary sibling would sit next to `negotiation/` inside
`recovery-snapshots/<attemptId>/`, and it is currently unnamed. As written the
assertion cannot fail. The seam-driven failure case in the same observable is
sound and does the real work (nothing deleted, no partial history directory), so
either name the new temp path and assert its absence, or drop the success-case
clause and rest on the failure case.

## Judgement

Both blocking concerns from round 1 are resolved, and the resolutions hold up
against the code they cite rather than merely restating the requirement. The
contract is implementable as written. The two advisories above are small
observable-precision cleanups the generator can fold in while writing the
tests; neither changes the shape of the slice.
