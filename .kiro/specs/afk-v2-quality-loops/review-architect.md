# Architect Review — PRD 5: Quality loops (cleaner only, default off)

**Round:** 1 (whole feature branch, `git diff main...HEAD`)
**Scope read:** `src/cleaner-stage.ts` (new, 1083 lines), the accept-seam block and
final-evaluation loop in `src/orchestrator.ts` (:6795-8210), `src/final-evaluation.ts`,
`src/escalation.ts`, `src/scope-gate.ts`, `src/artifacts.ts`, `src/run-events.ts`,
`src/logger.ts`, `src/ship-gate.ts`, `ARCHITECTURE.md`, and the three slice contracts
under `.kiro/specs/afk-v2-quality-loops/slices/`.

## What this branch gets right structurally

The shape is the one this repository asks for. `src/cleaner-stage.ts` is a new module
with one orchestrator call site (ARCHITECTURE.md "Hubs"), and every orchestrator-owned
concern — dispatch, archiving, run-state writes, ROI measurement — arrives as an
optional seam on `CleanerStageContext`, so the round loop is callable against a fixture
worktree. The loop's continuation is `cleanerRoundsRemaining({ spent, limit }) > 0`
rather than an incremented counter (ADR 0050), and `roundsAlreadySpent` is read back out
of `RunState` so the bound survives a process death. The new event family is additive and
both payloads have exactly one pure builder (`buildQualityStagePolicyEvent`,
`buildQualityStageAttemptEvent`), and `deriveQualityStageOutcomes` in `src/logger.ts` is
the single derivation the summary rows and the draft-PR section both read — the
`readAdvisoryGateOutcomes` precedent, followed. `outOfScopeChangedPaths` grows one
optional argument with today's value as the default, keeping every existing caller's
behavior (P-10), and `PostApprovalWritingStage` moved to `src/final-evaluation.ts`
without changing its signature or its default (P-02). `ARCHITECTURE.md` carries the new
module row, the seam bullet and the `GateFindings.suppressions` version pin.

One finding blocks: the restore re-dispatch #97 added is missing the fail-closed and
escalation authority the first dispatch has.

## FIX-BEFORE-SHIP

### A-01 — a cleaner stage that ends `EXHAUSTED` or `ESCALATED` *inside a restore round* is ignored, and the slice merges a tree a required clean gate rejected

**File / location.** `src/orchestrator.ts:8088-8121` (the `RESTORE` re-dispatch inside the
final-evaluation attempt loop) against `src/orchestrator.ts:7177-7237` (the first
dispatch's `ESCALATED` and `EXHAUSTED` handling); the stage side is
`src/cleaner-stage.ts:1027-1057` (`finish("EXHAUSTED")`) and `:828-863`
(`finish("ESCALATED")`).

**What I read/ran.** I read both orchestrator regions and then grepped the hub for every
consumer of the stage result:
`Select-String -Path src/orchestrator.ts -Pattern "cleaner\.outcome|restored"` returns
exactly two `cleaner.outcome` tests, `:7177` (`ESCALATED`) and `:7224` (`EXHAUSTED`), both
*above* the final-evaluation loop, plus the re-dispatch at `:8088` and the merge of its
result at `:8111-8119`. That merge keeps `ran`, `inputTreeId` and `roundsSpent` and takes
everything else from `restored` — including `outcome` — then `continue`s the attempt loop
with no test on it. Reading forward (`:8129-8210`): the next iteration re-checkpoints,
`decideFinalReuse` answers `evaluate` because the restored tree differs from the baseline,
`decideFinalVerdict` is computed from `postQaDeclarations` only — the clean gates are not
in that set — so a `PASS` sets `passedFinalEvaluation` and the slice proceeds to the merge.
On the stage side I confirmed both terminal outcomes are reachable from a repair run:
`runCleanerStage` with `repair` skips round 0 (`src/cleaner-stage.ts:650`), the loop tail
records `EXHAUSTED` when `blocking.length > 0` and `cleanerRoundsRemaining` is 0
(`:1027-1057`), and a valid escalation written by a restore round returns
`finish("ESCALATED")` after resetting only to `startCommit` — which on a re-dispatch is the
cleaner's own newest commit, not the accepted commit (`:585-590`, `:828-835`, whose comment
says so: "the earlier rounds range is the orchestrator's to undo").

**Consequences, both durable.**

1. *Exhaustion does not fail closed.* A restore round whose gates leave a required clean
   gate red on the last available round returns `EXHAUSTED`; `recordOutcome` persists
   `EXHAUSTED` into `RunState.qualityStages`, and the run then merges that very tree. The
   durable record says the stage exhausted with a required gate red while the branch says
   the slice shipped.
2. *A valid `BASELINE_IS_WRONG` raised in a restore round is discarded.*
   `invalidateFinalEvaluationBaseline`, the `generatorFailureSet` and the `retryNote` at
   `:7177-7222` are the whole escalation route, and the re-dispatch reaches none of them.
   The worktree is left at the cleaner's newest commit rather than the accepted commit, the
   baseline citation stays valid, and the evaluator re-grades the same unrestored tree.

**Convention basis.** PRD D4 ("Rounds exhausted with a required `clean` gate red ⇒ outcome
`EXHAUSTED`: the slice ends through the existing `finishStuck` path"; "story 4 says a
configured required gate fails closed"), slice-01 contract B-08 and B-13, PRD D8 ("A valid
file ends the stage with outcome `ESCALATED` and the orchestrator does exactly what a
final-evaluation `RETURN_TO_GENERATOR` does"), and `ARCHITECTURE.md` "Post-approval writing
stages", added by this branch: "a `BASELINE_IS_WRONG` escalation returns the slice to the
generator with the baseline citation invalidated, and exhaustion goes stuck with every
still-red gate named." The asymmetry is the shape ADR 0051 names: the guarantee is enforced
on the first path and skipped on the second.

**Authority (round 1).** `reachableTrigger`: on a project whose `afk.config.json` declares
`gatePolicy.clean`, a final evaluation returns an all-`RESTORE` review, the cleaner is the
last stage that wrote so the restore is routed to it, and the restore round either leaves a
required clean gate red with its budget spent or writes a valid `cleaner-escalation.json`.
`introducedByReviewedDiff`: true — the re-dispatch is new in this branch (`3f8feba`,
`08e4f70`, `991acb7`), as is the stage it dispatches.

**Clear condition.** The merged stage result's terminal outcomes are acted on with the same
authority after a re-dispatch as before one: `EXHAUSTED` ends the slice through
`finishStuck` with `cleanerExhaustionReason`'s still-red gates (or resets the cleaner range
to `acceptedCommitSha` before the loop continues, as the no-round-left branch at `:8040`
already does), and `ESCALATED` takes the `:7177` route. Whatever the choice, a test in
`src/qa-orchestration-gates.test.ts` beside "refuses a restore for want of a cleaner round"
pins it.

## Notes, not blockers

### A-02 — `additionalWriteScope` is applied ahead of the unwaivable accepted-pair carve-out
`src/scope-gate.ts:143-160` filters the changed set with `matchesGlob` *before* calling
`outOfScopeChangedPaths`, whose `orchestratorOwned` refusal (`src/escalation.ts:290-296`)
is documented as unwaivable and is what slice-01 P-10 locks. A project-declared
`gatePolicy.clean.additionalWriteScope` glob that happens to cover
`<sliceDir>/contract.md` or `acceptance-manifest.json` therefore removes the path before
the carve-out can name it. The trigger is an operator-authored policy glob rather than
normal operation, so this is a note — but "widening only" and "unwaivable" are now stated
of the same code path. Applying the widening to the offender list, or excluding
`ORCHESTRATOR_OWNED_SLICE_FILENAMES` from the pre-filter, makes the two consistent.

### A-03 — a second private hard-reset helper, without the excludes the shared one exists for
`src/cleaner-stage.ts:359-371` re-implements the hard reset plus untracked sweep with a
local `execFileSync` wrapper. `src/git.ts:695-718` (`resetWorktreeToHead`) is the module
that owns exactly this operation, and its docstring records why it takes `excludePaths`:
untracked slice artifacts must outlive the sweep. The cleaner passes no excludes, so its
safety rests on facts held at the call site (the `feat(#…)` commit sweeps artifacts in, and
the restore branch removes `final-review.json` / `final-report.md` before dispatching).
True today, and undocumented in the helper. Either route the reset through `src/git.ts` or
state the invariant where the sweep lives. `ARCHITECTURE.md:22` names `src/git.ts` as the
owner of git operations.

### A-04 — the `restoreStageId` comment describes code that is not there
`src/orchestrator.ts:7999-8006` reads `routes[0] && routes[0].route.target === ...` while
its comment says "`at(-1)` reads that agreed target off the first route". Two readings of
one line, one of them wrong.

### A-05 — `enabled` defaults to `true` when no policy event is on the stream
`src/logger.ts` `deriveQualityStageOutcomes` uses `policyFor(attempt.stage) ?? true`. For a
`final-evaluation` row — a stage no `quality-stage-policy` event describes — the summary and
the PR table always print `enabled: yes` from a default rather than a recorded fact.
Harmless for the ROI read, but PRD D10's own reasoning ("a PR that says nothing cannot be
read as evidence of either state") argues for an unknown marker there.

**Verdict:** FIX-BEFORE-SHIP

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"A restore re-dispatch ignores the cleaner stage's EXHAUSTED and ESCALATED outcomes, so a tree a required clean gate rejected can merge and a BASELINE_IS_WRONG escalation is discarded","class":"INTEGRITY","clearCondition":"After the RESTORE re-dispatch at src/orchestrator.ts:8088-8121 the merged stage result's terminal outcomes are acted on with the same authority as the first dispatch: EXHAUSTED ends the slice through finishStuck with cleanerExhaustionReason's still-red gates (or resets the cleaner range to acceptedCommitSha), and ESCALATED takes the :7177 route (reset to the accepted commit, invalidateFinalEvaluationBaseline, generatorFailureSet, retryNote), pinned by a test beside 'refuses a restore for want of a cleaner round'.","disposition":"OPEN","reachableTrigger":"On a project declaring gatePolicy.clean, the final evaluation returns an all-RESTORE review routed to the cleaner and the restore round leaves a required clean gate red with its round budget spent (or writes a valid cleaner-escalation.json); the run continues, the evaluator PASSes the restored tree and the slice merges.","introducedByReviewedDiff":true},{"id":"A-02","title":"additionalWriteScope pre-filter runs ahead of the unwaivable accepted-pair carve-out in outOfScopeChangedPaths","class":"AUTHORITY","clearCondition":"The additionalWriteScope widening cannot remove ORCHESTRATOR_OWNED_SLICE_FILENAMES from classification, so the orchestratorOwned refusal stays unwaivable as P-10 states.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"cleaner-stage re-implements a hard reset and untracked sweep instead of using git.ts's resetWorktreeToHead and its excludePaths","class":"CONVENTION","clearCondition":"The cleaner's reset either routes through src/git.ts or documents at the sweep site why no untracked slice artifact can be destroyed by it.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment at src/orchestrator.ts:7999-8006 describes the routes[0] read the code makes.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"Quality-stage rows print enabled=yes from a default when no quality-stage-policy event describes the stage","class":"EVIDENCE","clearCondition":"A stage with no quality-stage-policy event renders an unknown marker rather than a defaulted 'yes' in the summary row and the PR table.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false}]}
