# Architecture review — afk-v2-quality-loops (round 2, verification)

## Scope of this round

`git diff d5fe47b37eb71aca3b30252900780898e6b1c13a..HEAD` is **empty**.
`git rev-parse HEAD` returns `d5fe47b37eb71aca3b30252900780898e6b1c13a`, which
is the exact base this round was asked to diff against, and `git status -sb`
reports a clean tree at `origin/feat-claude-code/afk-v2-quality-loops` with no
local commits ahead. `git cherry -v main HEAD` ends at `d5fe47b`
("docs(afk-v2-quality-loops): add post-impl guardian reviews"), the round-1
review artifact commit itself.

No fix was produced for any of the five open findings. I therefore re-verified
each clear condition directly against the current tree rather than against a
diff, and every one of them still fails on the same code round 1 read. All five
dispositions are `REPEATED`.

## A-01 — INTEGRITY — REPEATED (blocking)

**Clear condition not met.** The condition requires that after the RESTORE
re-dispatch the merged stage result's terminal outcomes be acted on with the
same authority as the first dispatch, pinned by a test beside "refuses a restore
for want of a cleaner round".

What I read:

- `src/orchestrator.ts:8088-8121`. `const restored = await
  dispatchCleanerStage({ roundsAlreadySpent: cleaner.roundsSpent, repair: {
  findings: restoreFindings } })` is followed only by the three-field merge into
  `cleaner` (`ran` sticky, `inputTreeId` held at the first dispatch's,
  `roundsSpent` monotonic) and then `continue`. There is no read of
  `restored.outcome` anywhere between line 8088 and the `continue` at 8120.
  `EXHAUSTED` and `ESCALATED` are simply dropped.
- `src/orchestrator.ts:7174-7237` is the first dispatch, and it is the
  asymmetry. `if (cleaner.outcome === "ESCALATED" && cleaner.escalation)` at
  7177 calls `invalidateFinalEvaluationBaseline` (7187), builds
  `generatorFailureSet` from the escalation (7193-7206), sets `retryNote`
  (7207-7211) and either `continue`s into another implementation attempt or
  `finishStuck`s (7217-7222). `if (cleaner.outcome === "EXHAUSTED")` at 7224
  pushes the remaining failures' log artifact ids into `stuckReferences` and
  returns `finishStuck(cleanerExhaustionReason({...}))` (7229-7236). Both
  handlers sit at the top of the slice body, outside the final-evaluation
  attempt loop, so the `continue` at 8120 cannot reach either: it continues the
  attempt loop, whose next iteration re-runs the final evaluator on the restored
  tree.
- Consequence on the reachable trigger. A restore round that leaves a required
  clean gate red and spends its last round returns `EXHAUSTED`; the merge keeps
  `roundsSpent` and discards the outcome; the attempt loop grades the tree
  again; a `PASS` from the final evaluator merges a tree a required clean gate
  rejected. On the `ESCALATED` branch a valid `BASELINE_IS_WRONG` written by the
  restore round is discarded entirely — no baseline invalidation, no
  `generatorFailureSet`, no `retryNote` — so the claim "the approved candidate
  itself has to change" is silently lost. Contrast the pre-dispatch path at
  8036-8073, which does handle the no-round-left case correctly (reset the whole
  cleaner range to `acceptedCommitSha`, record `EXHAUSTED`, `continue`); the
  post-dispatch path has no equivalent.
- The pinning test does not exist. `Select-String` for "refuses a restore for
  want of a cleaner round" matches exactly one site,
  `src/qa-orchestration-gates.test.ts:1699`, and its single `EXHAUSTED`
  assertion is at line 1756. That test exercises the *pre*-dispatch branch
  (`cleanerRoundsRemaining(...) === 0`, orchestrator 8036-8073). Nothing in that
  file between 1650 and 1900 asserts anything about a terminal outcome returned
  *by* the re-dispatch.

Authority (round 2, prior-lineage branch): A-01 is matched to prior stable
lineage from round 1, its disposition is `REPEATED` and not `RESOLVED`, and
`reachableTrigger` still names a non-blank normal-operation trigger — a project
declaring `gatePolicy.clean` whose final evaluation returns an all-RESTORE
review routed to the cleaner, where the restore round leaves a required clean
gate red with its budget spent. Under that branch the finding's class and
`introducedByReviewedDiff` value do not remove the continuing authority, and the
evidence above is my own reading of the current tree, not a restatement of round
1 or of the concurrent PM review. This is a durable-authority defect: a required
gate's refusal stops governing the merge, and there is no recovery step
downstream that restores it.

## A-02 — AUTHORITY — REPEATED (note)

**Clear condition not met.** `src/scope-gate.ts:151-156` still pre-filters:
`additional.length === 0 ? changed.paths : changed.paths.filter((path) =>
!additional.some((glob) => matchesGlob(glob, path)))`. The filtered
`changedPaths` is what reaches `outOfScopeChangedPaths` at 157-166, so a path
matched by an `additionalWriteScope` glob never enters classification at all and
the unwaivable accepted-pair / `ORCHESTRATOR_OWNED_SLICE_FILENAMES` carve-out
inside that function cannot run on it. The widening therefore can still remove
orchestrator-owned filenames from classification, which is what P-10 says must
be impossible. Ordering fix, not a behavioral rewrite: pass `additional` into
`outOfScopeChangedPaths` and apply it after the carve-out. Note-only —
`reachableTrigger` was not established in round 1 and I did not establish one
now, and it is not introduced by the reviewed diff.

## A-03 — CONVENTION — REPEATED (note)

**Clear condition not met** on both of its alternatives.
`src/cleaner-stage.ts:56` imports only `commitAll, diffTreePaths,
hasUncommittedChanges` from `./git.js`; the reset is local at
`resetHardTo` (367-371), which is `git reset --hard <commit>` followed by a bare
`git clean -fd` with no exclusions. `src/git.ts:711-716` already offers
`resetWorktreeToHead(..., excludePaths: string[] = [])` building `-e` arguments
for exactly this purpose. The comment at 310-316 answers only why the *export*
lives here ("resetting a cleaner range is this stage's concern"), which is a
reasonable module-boundary argument; it does not document at the sweep site why
no untracked slice artifact can be destroyed by `clean -fd`, which is the other
half the condition asks for. Note.

## A-04 — MAINTAINABILITY — REPEATED (note)

**Clear condition not met.** `src/orchestrator.ts:8011-8013` still reads
"`at(-1)` reads that agreed target off the first route", while the code
immediately below at 8014-8017 performs `routes[0] && routes[0].route.target
=== "writing-stage" ? routes[0].route.stageId : POST_APPROVAL_WRITING_STAGE_ID`.
The comment names an operation the code does not perform, and "`at(-1)` ... off
the first route" is self-contradictory besides. One-line comment fix. Note.

## A-05 — EVIDENCE — REPEATED (note)

**Clear condition not met.** `src/logger.ts:217` is still `enabled:
policyFor(attempt.stage) ?? true`, and `policyFor` (197-202) returns `undefined`
when no `quality-stage-policy` event names the stage. The field is typed
`enabled: boolean` at 153-158, so there is no representation for "unknown" to
render: a stage with no policy event prints `yes` in the summary row and the PR
table from a default rather than an unknown marker, which reports policy the run
never declared. Widening the field to `boolean | null` (or `| "unknown"`) and
rendering the third state is the shape of the fix. Note.

## Assessment

The branch's structure is otherwise the one round 1 described, and I did not
resample it for new findings. The single blocker is narrow and local: the
restore re-dispatch at `src/orchestrator.ts:8088-8121` needs the two terminal
outcomes the first dispatch at 7174-7237 already handles, plus a test beside
`src/qa-orchestration-gates.test.ts:1699` covering the post-dispatch case rather
than only the pre-dispatch one. A-02 through A-05 are notes and can ship; A-02
is the one I would fix soonest after, because it is an authority carve-out that
the code claims is unwaivable and is not.

**Verdict:** FIX-BEFORE-SHIP

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Restore re-dispatch ignores the cleaner stage's EXHAUSTED and ESCALATED outcomes, so a tree a required clean gate rejected can merge and a BASELINE_IS_WRONG escalation is discarded","class":"INTEGRITY","clearCondition":"After the RESTORE re-dispatch at src/orchestrator.ts:8088-8121 the merged stage result's terminal outcomes are acted on with the same authority as the first dispatch: EXHAUSTED ends the slice through finishStuck with cleanerExhaustionReason's still-red gates (or resets the cleaner range to acceptedCommitSha), and ESCALATED takes the :7177 route (reset to the accepted commit, invalidateFinalEvaluationBaseline, generatorFailureSet, retryNote), pinned by a test beside 'refuses a restore for want of a cleaner round'.","disposition":"REPEATED","reachableTrigger":"On a project declaring gatePolicy.clean, the final evaluation returns an all-RESTORE review routed to the cleaner and the restore round leaves a required clean gate red with its round budget spent (or writes a valid cleaner-escalation.json); the run continues, the evaluator PASSes the restored tree and the slice merges.","introducedByReviewedDiff":true},{"id":"A-02","title":"additionalWriteScope pre-filter runs ahead of the unwaivable accepted-pair carve-out in outOfScopeChangedPaths","class":"AUTHORITY","clearCondition":"The additionalWriteScope widening cannot remove ORCHESTRATOR_OWNED_SLICE_FILENAMES from classification, so the orchestratorOwned refusal stays unwaivable as P-10 states.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"cleaner-stage re-implements a hard reset and untracked sweep instead of using git.ts's resetWorktreeToHead and its excludePaths","class":"CONVENTION","clearCondition":"The cleaner's reset either routes through src/git.ts or documents at the sweep site why no untracked slice artifact can be destroyed by it.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment at src/orchestrator.ts:7999-8006 describes the routes[0] read the code makes.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"Quality-stage rows print enabled=yes from a default when no quality-stage-policy event describes the stage","class":"EVIDENCE","clearCondition":"A stage with no quality-stage-policy event renders an unknown marker rather than a defaulted 'yes' in the summary row and the PR table.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
