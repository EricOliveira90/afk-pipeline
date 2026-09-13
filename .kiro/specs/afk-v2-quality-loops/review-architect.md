# Architecture review — round 3 (verification)

**Verdict:** FIX-BEFORE-SHIP

## Scope and the central fact of this round

This round was scoped to `git diff c44b47b..HEAD` — the fix diff. That diff
is **empty**: `git rev-parse HEAD` returns
`c44b47b6f3bebe345e6bed9d6223187d772047e8`, the very commit round 2 was
reviewed at, and `git log --oneline c44b47b..HEAD` prints nothing. The
working tree is clean and level with `origin/feat-claude-code/afk-v2-quality-loops`.

So no repair round landed between round 2 and this one. I did not resample
the branch for new findings; I re-read each open finding's cited site to
confirm the code still reads the way round 2 described it, and every one
does. All five findings are `REPEATED`, none is `RESOLVED`, and no finding
is new.

## Findings

### [A-01] INTEGRITY — REPEATED (blocking)

- **File / location:** `src/orchestrator.ts`, the restore branch
  `if (restoreStageId === CLEANER_STAGE_ID)` and the re-dispatch that follows
  it (approximately lines 8025–8121).
- **What I read:** I read the whole branch as it stands today. The
  zero-rounds-remaining case is handled *before* dispatch: when
  `cleanerRoundsRemaining({spent: cleaner.roundsSpent, limit: cleanerLimit}) === 0`
  the code resets via `resetCleanerRangeTo(ctx.worktreeDir, acceptedCommitSha)`,
  records `"EXHAUSTED"` through `recordQualityStageOutcome`, logs, and
  `continue`s. That path is intact and is not the finding. The finding is the
  path taken when a round *is* available: `const restored = await
  dispatchCleanerStage({roundsAlreadySpent: cleaner.roundsSpent, repair:
  {findings: restoreFindings}})`, then the documented three-field merge
  (`ran` sticky, `inputTreeId` pinned to the accepted tree, `roundsSpent`
  monotonic), then a bare `continue;`. Nothing between the merge and that
  `continue` inspects `restored.outcome`.
- **Why that is a defect and not a style note:** the same two terminal
  outcomes *are* acted on with full authority on the first dispatch —
  `cleaner.outcome === "ESCALATED" && cleaner.escalation` at
  `src/orchestrator.ts:7177` (reset to the accepted commit, baseline
  invalidation, generator failure set, retry note) and
  `cleaner.outcome === "EXHAUSTED"` at `:7224`, which builds its still-red
  gate list through `cleanerExhaustionReason` (imported at `:198`). Those
  two blocks sit upstream of the final-evaluation loop, so a `continue` from
  inside that loop cannot reach them. The merge deliberately makes `restored`
  the standing result, which means the loop's next iteration proceeds with a
  cleaner whose stage run ended EXHAUSTED or ESCALATED as though it had
  merely finished a round. A required clean gate the restore round left red,
  with the round budget spent, is therefore never converted into a
  `finishStuck`, and a `BASELINE_IS_WRONG` escalation the restore round wrote
  is dropped on the floor rather than routed to the generator.
- **Authority basis (round ≥2, prior-lineage branch):** this finding is
  matched to the round-2 stable finding A-01. Its disposition is not
  `RESOLVED`, and its `reachableTrigger` remains a non-blank
  normal-operation trigger — on a project declaring `gatePolicy.clean`, the
  final evaluation returns an all-`RESTORE` review, the restore is routed to
  the cleaner with a round in hand, and that round leaves a required clean
  gate red or writes a valid `cleaner-escalation.json`. The run then continues,
  the evaluator can PASS the restored tree, and the slice merges. Under the
  prior-lineage branch, class and `introducedByReviewedDiff` do not remove
  the continuing authority; for the record, the control flow in question was
  introduced by this branch (`991acb7`, `08e4f70`), so attribution holds
  independently.
- **Clear condition (unchanged):** after the re-dispatch, the merged stage
  result's terminal outcomes must be acted on with the same authority as the
  first dispatch — `EXHAUSTED` ends the slice through `finishStuck` with
  `cleanerExhaustionReason`'s still-red gates (or resets the cleaner range to
  `acceptedCommitSha`), and `ESCALATED` takes the `:7177` route. Pin it with a
  test beside `[behavior:#97:B-04] [behavior:#97:B-13] refuses a restore for
  want of a cleaner round, reverts the cleaner's range, and reuses the
  accepted tree` (`src/qa-orchestration-gates.test.ts:1699`), which today
  covers only the pre-dispatch refusal.

### [A-02] AUTHORITY — REPEATED (note)

`src/scope-gate.ts:145–166` still filters `changed.paths` by
`additionalWriteScope` globs *before* calling `outOfScopeChangedPaths`. In
`src/escalation.ts` the `orchestratorOwned` carve-out is built from
`ORCHESTRATOR_OWNED_SLICE_FILENAMES` and tested first in the loop, with the
comment "Refused even if the manifest declares it" — but a path removed by the
pre-filter never reaches that loop, so a policy glob covering the slice
artifact directory silently un-does an exemption the module documents as
unwaivable (P-10). The in-code comment ("a pre-filter cannot turn an
internally exempted path into one") asserts the opposite of what the two
functions compose to. Note, not a blocker: no reachable trigger was recorded
and it is not introduced by the reviewed diff.

### [A-03] CONVENTION — REPEATED (note)

`src/cleaner-stage.ts:367–371` still defines a private `resetHardTo` that runs
`git reset --hard <commit>` followed by an unqualified `git clean -fd`, while
`src/git.ts:697–716` already provides `resetWorktreeToHead` with an
`excludePaths` parameter whose docstring exists precisely so artifacts survive
a sweep. The docstring at `:311–317` explains why the *export* lives here, not
why the sweep needs no exclusions. Note.

### [A-04] MAINTAINABILITY — REPEATED (note)

`src/orchestrator.ts:8010–8016` still reads
`routes[0] && routes[0].route.target === "writing-stage" ? routes[0].route.stageId : ...`
directly above a comment ending "`at(-1)` reads that agreed target off the
first route" — which names a read the code does not perform and contradicts
itself in the same sentence. Note.

### [A-05] EVIDENCE — REPEATED (note)

`src/logger.ts:217` still defaults with `enabled: policyFor(attempt.stage) ?? true`,
and `policyFor` returns `undefined` when no `quality-stage-policy` event
describes the stage (`:197–202`). The field's own docstring at `:157` says
"From `quality-stage-policy`; `false` for a stage the run declared none of",
so the summary row and PR table print an asserted `yes` for a stage the stream
never described. Note.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Restore re-dispatch ignores the cleaner stage's EXHAUSTED and ESCALATED outcomes, so a tree a required clean gate rejected can merge and a BASELINE_IS_WRONG escalation is discarded","class":"INTEGRITY","clearCondition":"After the RESTORE re-dispatch at src/orchestrator.ts:8088-8121 the merged stage result's terminal outcomes are acted on with the same authority as the first dispatch: EXHAUSTED ends the slice through finishStuck with cleanerExhaustionReason's still-red gates (or resets the cleaner range to acceptedCommitSha), and ESCALATED takes the :7177 route (reset to the accepted commit, invalidateFinalEvaluationBaseline, generatorFailureSet, retryNote), pinned by a test beside 'refuses a restore for want of a cleaner round'.","disposition":"REPEATED","reachableTrigger":"On a project declaring gatePolicy.clean, the final evaluation returns an all-RESTORE review routed to the cleaner and the restore round leaves a required clean gate red with its round budget spent (or writes a valid cleaner-escalation.json); the run continues, the evaluator PASSes the restored tree and the slice merges.","introducedByReviewedDiff":true},{"id":"A-02","title":"additionalWriteScope pre-filter runs ahead of the unwaivable accepted-pair carve-out in outOfScopeChangedPaths","class":"AUTHORITY","clearCondition":"The additionalWriteScope widening cannot remove ORCHESTRATOR_OWNED_SLICE_FILENAMES from classification, so the orchestratorOwned refusal stays unwaivable as P-10 states.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"cleaner-stage re-implements a hard reset and untracked sweep instead of using git.ts's resetWorktreeToHead and its excludePaths","class":"CONVENTION","clearCondition":"The cleaner's reset either routes through src/git.ts or documents at the sweep site why no untracked slice artifact can be destroyed by it.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment at src/orchestrator.ts:7999-8006 describes the routes[0] read the code makes.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"Quality-stage rows print enabled=yes from a default when no quality-stage-policy event describes the stage","class":"EVIDENCE","clearCondition":"A stage with no quality-stage-policy event renders an unknown marker rather than a defaulted 'yes' in the summary row and the PR table.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
