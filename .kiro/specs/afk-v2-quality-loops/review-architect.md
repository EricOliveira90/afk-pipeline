# Architecture review — round 4 (verification)

Scope: `git diff dce9a718..HEAD` (8 commits, +1242/-893) and the five open
findings. No fresh sampling of the rest of the branch.

## [A-01] INTEGRITY — RESOLVED

The re-dispatch site no longer owns terminal policy at all. The cleaner
lifecycle moved into `src/cleaner-orchestration.ts`
(`createCleanerOrchestrationSession`, 3f3d22a), and both dispatches now go
through one `advance()`/`decide()` pair:

- `src/cleaner-orchestration.ts:367-429` — `decide()` maps `ESCALATED` (with
  a parsed escalation) to `RETURN_TO_GENERATOR` carrying the failure set and
  retry note, after `resetCleanerRangeTo(worktreeDir, accepted.commitSha)`
  (b50d50d, lines 368-374) and `invalidateFinalEvaluationBaseline`; it maps
  `EXHAUSTED` to `STUCK` with `cleanerExhaustionReason(...)` and the
  still-red gates' `logArtifactId`s.
- `src/cleaner-orchestration.ts:432-492` — `advance()` calls `decide()` on
  the merged standing result for `INITIAL` *and* `RESTORE`; the
  zero-rounds-remaining `RESTORE` branch (455-481) resets the cleaner range
  to the accepted commit, records `EXHAUSTED`, and returns `PROCEED`, which
  is the other half of the clear condition.
- `src/orchestrator.ts:6878-6897` (initial) and `7682-7699` (restore) — both
  act with the same authority: `RETURN_TO_GENERATOR` sets
  `generatorFailureSet`/`retryNote` and either `continue`s the
  implementation loop or breaks the final-evaluation loop with
  `returnToGenerator = true`; `STUCK` pushes `artifactReferences` into
  `stuckReferences` and `return finishStuck(reason)`. Nothing after the
  restore falls through to the evaluator on an exhausted or escalated tree.

Evidence I ran: `npx vitest run src/cleaner-orchestration.test.ts` — 2
passed. The B-08 case asserts `STUCK` with the exhaustion reason naming
`clean:format` and the log artifact; the B-13 case asserts, on a real git
fixture, that after a `RESTORE` escalation `HEAD`/`HEAD^{tree}` are back at
the accepted commit and tree, the cleaner's file content is reverted, the
untracked file is gone, the baseline citation is dropped, and the accepted
tree is appended to `invalidatedCandidateTreeIds`. That is the test "beside
`refuses a restore for want of a cleaner round`" the clear condition asked
for, plus the resume case in 96e6217.

The extraction also removes the duplicated closure the round-3 fix had left
in `runSliceExecute` and puts cleaner state (`standing`, `mergeStanding`)
next to the policy that reads it — a boundary improvement, not just a bug
fix.

## [A-02] AUTHORITY — REPEATED (note)

`src/scope-gate.ts:147-160` still widens by `additionalWriteScope` before
`outOfScopeChangedPaths` classifies, so a policy glob that happens to cover
an `ORCHESTRATOR_OWNED_SLICE_FILENAMES` path removes it from classification
and the unwaivable refusal never fires. The comment at 147-150 asserts a
pre-filter cannot exempt an internally exempted path; that argument covers
exemptions, not the orchestrator-owned refusal. Untouched by this diff, no
recorded normal-operation trigger — note, as in round 3.

## [A-03] CONVENTION — REPEATED (note)

`src/cleaner-stage.ts:367-371` still carries a local `resetHardTo` doing
`git reset --hard` plus `git clean -fd` through the file's private `git()`
helper, rather than `src/git.ts`'s `resetWorktreeToHead` and its
`excludePaths`. The one-line comment names the sweep but does not argue why
no untracked slice artifact can be destroyed by it. Unchanged by this diff.

## [A-04] MAINTAINABILITY — REPEATED (note)

`src/orchestrator.ts:7667-7674` — the comment above `restoreStageId` still
reads "`at(-1)` reads that agreed target off the first route" while the code
reads `routes[0]`. The clear condition asked for the comment to describe the
`routes[0]` read; the diff moved the block but not the sentence.

## [A-05] EVIDENCE — REPEATED (note)

`src/logger.ts:217` still computes `enabled: policyFor(attempt.stage) ?? true`,
so a stage with no `quality-stage-policy` event renders `yes` in the summary
row (`:784`) and the PR table from a default rather than an unknown marker.
The logger changes in this diff are the `recordQualityStagePolicy` /
`recordQualityStageAttempt` boundary move (adaf711) and their tests; the
default is untouched.

## Verdict rationale

A-01 is the only finding that ever carried blocking authority (prior stable
lineage with a reachable trigger); its clear condition is met with evidence I
read and a test I ran. A-02 through A-05 remain notes: none was introduced by
the reviewed diff and none has a recorded normal-operation trigger, so under
the round-2-or-later prior-lineage branch they continue as notes only. No new
findings raised — this round did not resample the branch.

**Verdict:** ACCEPT-WITH-NOTES

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Restore re-dispatch ignores the cleaner stage's EXHAUSTED and ESCALATED outcomes","class":"INTEGRITY","clearCondition":"After the RESTORE re-dispatch the merged stage result's terminal outcomes are acted on with the same authority as the first dispatch: EXHAUSTED ends the slice through finishStuck with the still-red gates (or resets the cleaner range to the accepted commit), and ESCALATED resets to the accepted commit, invalidates the baseline, and returns to the generator, pinned by a test.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"additionalWriteScope pre-filter runs ahead of the unwaivable accepted-pair carve-out in outOfScopeChangedPaths","class":"AUTHORITY","clearCondition":"The additionalWriteScope widening cannot remove ORCHESTRATOR_OWNED_SLICE_FILENAMES from classification, so the orchestratorOwned refusal stays unwaivable as P-10 states.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"cleaner-stage re-implements a hard reset and untracked sweep instead of using git.ts's resetWorktreeToHead and its excludePaths","class":"CONVENTION","clearCondition":"The cleaner's reset either routes through src/git.ts or documents at the sweep site why no untracked slice artifact can be destroyed by it.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment above restoreStageId describes the routes[0] read the code makes.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"Quality-stage rows print enabled=yes from a default when no quality-stage-policy event describes the stage","class":"EVIDENCE","clearCondition":"A stage with no quality-stage-policy event renders an unknown marker rather than a defaulted 'yes' in the summary row and the PR table.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
