# Contract review — round 2

The pair is ready to build. Every prior finding is closed: three by the
revision, one because the planner was right and I was wrong about the
repository.

## The restore route now composes (F-08)

Round 1's gap was that the selection rule and the list the call site built
pointed in opposite directions: the cleaner runs first, so a list that named
both stages always put `post-approval-writing` last, and the cleaner branch
that B-03, B-04 and S3 all assert on could never be entered.

The revision fixes this at the right level — on the parameter, not in a
special case. `writingStageIds` is now declared to hold *only the stages that
actually changed the tree, in the order they ran*, which makes production's
`noopPostApprovalWritingStage` contribute nothing and makes a committed
cleaner's id the last one even though the cleaner ran first. B-02 builds to
that contract: `CLEANER_STAGE_ID` when the cleaner's output tree differs from
its input tree, then `POST_APPROVAL_WRITING_STAGE_ID` only when
`currentFinalTreeId !== stageInputTreeId`. So the committed-cleaner case under
production is exactly `[CLEANER_STAGE_ID]`, and the last-id rule names the
cleaner.

What matters as much as the rule is that the four places that read it now say
the same thing: the test-plan bullet asserts `"cleaner"` for
`[CLEANER_STAGE_ID]` and `"post-approval-writing"` for the two-id list (right,
because an injected stub that writes after the cleaner did write last), the
manifest's B-01 asserts the same three values, S3 expects `"cleaner"`, and the
DoD line is now falsifiable — it names the list shape rather than the
satisfiable-but-empty "passes the cleaner's id exactly when the cleaner
committed". The new unit bullet on the extracted list builder is a good
addition: it pins the composition directly instead of leaving it inferable only
from a spawned run.

## Model time: the finding was mine to withdraw (F-09)

I held that `stage-duration` was an unwritten record, on the strength of the
explorer's grep for duration-shaped field names. The planner contested it and
is correct. I verified in the tree:

- `src/run-events.ts:347-371` declares the member `{ type: "stage-duration";
  ghIssue; sliceNumber?; agent; round?; durationMs; history; ratioToMedian? }`.
  The grep missed it because the member is identified by its literal `type`
  string, not by a field named `elapsed` or `durationMs` in a searched context.
- `RunJournal.observeStageDuration` (`src/run-journal.ts:133-169`) appends the
  line to the stream after pairing each `phase-ended` with the newest unmatched
  `phase-started`.
- The agent roles this slice needs are already emitted: `agent: "cleaner"` at
  `src/orchestrator.ts:6861` and `:6927`, `agent: "evaluator-final"` at
  `:7558`.

So the column has a real source, the seeded-stream unit test is writable, and
dropping the field would have contradicted PRD D11 rather than fixing anything.
The revision also does the useful part of the original request anyway: B-09 now
cites both source sites, states the matching key (`ghIssue` plus `agent`, with
the two literal roles), and states the missing-`phase-ended` case as model ms
`0`; B-10 names B-09's sum as the column's source; and the non-goal is restated
as "`src/stage-durations.ts` is not edited" while its events are read — which is
the posture every other reader in `src/logger.ts` already takes toward the
stream.

## The artifact path is pinned where the evidence reaches (F-10)

B-13, the S3 bullet and the DoD line now pin the file *stem*
`cleaner-log-r1-a3.log` — with `r1` the first generator round and `a3` the
third cleaner round, the slots `src/orchestrator.ts:6962-6972` passes — and
resolve the directory from the run's own artifact tree, saying plainly that the
segment beneath `.afk/artifacts/<run-slug>/slice-<n>/` is not pinned because the
builder composing it lives in the out-of-scope `src/artifacts.ts`. That is the
right split: the counters are the thing this slice is claiming, and a directory
detail can no longer make a correct implementation fail the DoD.

## Two halves, one session, stated order (F-11)

The Scope lock now records the decision rather than leaving it implicit: the
restore path (B-01–B-05, B-12) first because #97 AC1 and the merge behavior
depend on it, then the ROI family (B-06–B-11, B-13); one shared seam; each half
green on its own tree, so the ROI half is the separable one if the session runs
short; and the split is declined here because S1 and S3 both extend the single
`finalEvaluationFixture`, so splitting would pay the fixture cost twice in the
heaviest suite. That is a reasonable trade and it is now written down where a
later reader will find it.

## Notes for the generator, not gaps

- The `fileScope` spelling of `architecture.md` is a case-only difference from
  the repository's `ARCHITECTURE.md`. Manifest paths are case-insensitive
  comparison keys, so this changes nothing; do not "fix" it in either direction
  as part of the work.
- B-02 describes the list as built at the orchestrator call site while its unit
  bullet asserts a pure builder from `src/final-evaluation.test.ts`. Both files
  are in scope; export the builder from `src/final-evaluation.ts` so the unit
  test imports it without reaching into the orchestrator.
