# What shipped

- B-01: `src/final-evaluation.ts:decideFinalReuse`, called once from `src/orchestrator.ts` at the accept seam
- B-02: `src/run-state.ts:recordFinalEvaluation`, `src/run-events.ts:final-evaluation-reuse`, `src/logger.ts:writeSummary` (`## Final Evaluation Reuse`)
- B-03: `src/final-evaluation.ts:POST_APPROVAL_WRITING_STAGE_ID`, injected via `src/orchestrator.ts:postApprovalWritingStage`
- B-04: `src/change-summary.ts:buildFinalChangeSummary`, `src/change-summary.ts:writeFinalChangeSummary`
- B-05: `src/qa-review.ts:QA_REVIEW_STAGES` (`final-evaluation`), `src/artifacts.ts:qaArchivePrefix`
- B-06: `src/context-envelope.ts:FINAL_EVALUATOR_CONTEXT_MANIFEST`, `prompts/evaluator-final.md`
- B-07: `src/post-qa-gates.ts:QA_WINDOW_ARTIFACT_NAME`
- B-06 dispatch: the bounded `evaluator-final` loop in `src/orchestrator.ts` (post-approval capture → scope gate on the final tree → `createReviewIsolation` → `invoke({ role: "evaluator-final" })`), with `src/run-events.ts:invocation-completed` carrying the role
- B-08: `src/final-evaluation.ts:parseFinalReview`, `src/final-evaluation.ts:validateFinalReview`, `src/final-evaluation.ts:routeFinalReviewFinding`
- B-09: `src/run-state.ts:invalidateFinalEvaluationBaseline`, `src/final-evaluation.ts:decideFinalReuse`, and the generator return in `src/orchestrator.ts` (`continue` on the implementation loop, so `logger.bumpGenRound` counts it)
- B-10: `src/bounds.ts:MAX_FINAL_EVALUATION_ATTEMPTS`, `src/bounds.ts:finalEvaluationAttemptsRemaining`, `src/run-state.ts:finalEvaluationAttemptsSpent`, `src/artifacts.ts:archiveQAReviewAttempt`
- B-11: `src/final-evaluation.ts:decideFinalVerdict`, called from `src/orchestrator.ts` once per final-evaluation attempt
- B-12: `ARCHITECTURE.md` module and prompt rows
- P-01: `src/wave.ts` untouched; the no-second-lock half asserted in `src/qa-orchestration.test.ts`, the mutex-serialized-merge half carried by `src/wave-migrations.test.ts` → `describe("a real conflict spends one scoped resolution round")` → `it("B-05: holds the merge mutex across the refused attempt, the round and the retry")`
- P-02: `src/artifacts.ts:qaArchivePrefix` keeps `qa`/`uat`
- P-03: `src/run-state.ts:recordApprovedBaseline` remains the only baseline writer; invalidation withdraws a citation without rewriting the artifact
- P-04: `src/change-summary.ts:buildChangeSummary` is still the single builder and `ChangeSummary` v1 is unextended
- P-05: `src/post-qa-gates.ts:reviewArtifactViolations`
- P-06: `src/run-state.ts:RUN_STATE_VERSION` 5 with `finalEvaluations` additive and `src/run-state.ts:adaptLoadedState` reading v4 unchanged; the current-version assertions in `src/run-state.test.ts` restamped to `5`

# Decisions made during implementation

- The reuse decision compares the final tree against the tree the baseline
  *authorizes*, not the tree it graded. #91 records the baseline at
  `checkpoint.treeId` — captured before the QA evaluator writes `qa-report.md`
  and `qa-review.json` — and those bytes are then committed into the accepted
  tree, so the two tree IDs are never string-equal and `reuse` would be
  unreachable in every real run. `FinalReuseBaseline` therefore carries an
  optional `approvedTreeId`, and `src/orchestrator.ts` offers the accepted tree
  there only after `reviewArtifactViolations` (the same window check, with the
  same audited scope-amendment blobs, that the accept seam itself uses) proves
  the QA window explains every differing path. Absent, the approval covers only
  the tree it graded and the run fails closed into a full final evaluation.
  This also removes the earlier `postApprovalWriteChangedTree` comparison:
  `decideFinalReuse` is now the single comparison that decides whether an
  evaluator is dispatched, so two tests of the same subject cannot disagree.
- An `evaluate` decision dispatches the final evaluator rather than grading a review nobody was asked to write. The loop in `src/orchestrator.ts` runs while the verdict has neither passed nor returned to the generator, and each iteration: checks `finalEvaluationAttemptsRemaining` *before* dispatching, deletes the two final artifacts, commits any post-approval dirt, captures the tree with `createCandidateCheckpoint(..., { materialize: false })`, writes the baseline → final change summary, dispatches, and validates. The bound is therefore paid before an evaluator read, and an exhausted bound is an ERROR naming `MAX_FINAL_EVALUATION_ATTEMPTS`, not a silent merge.
- The scope gate is re-run on the final tree through a second `runPostQAGates` call carrying only the non-executable `scopeGateDeclaration` and `qaApprovedTreeId: currentFinalTreeId`. The evidence from the accepted candidate is keyed to a tree the post-approval stage has already replaced, so reusing it would have made `scopeGateStatus` unreachable as PASS and the verdict permanently fail-closed. `decideFinalVerdict` accepts the status only when `finalScopeEvidence.treeId` equals the tree being graded, so stale evidence still cannot vouch for a new tree.
- A FAIL review is routed before `decideFinalVerdict` is consulted, because the verdict grades conditions and never reads the review's own verdict field. `RESTORE` re-enters the post-approval writing stage with `repair: "RESTORE"` (the flag is what lets a stage tell its own turn from its own repair) and costs a graded attempt; `RETURN_TO_GENERATOR` invalidates the baseline, records a `RETURNED_TO_GENERATOR` attempt entry, and `continue`s the enclosing implementation loop, which bumps the generator round and spends no evaluator attempt (D19).
- `PersistedFinalEvaluation.attempts` became one entry per attempt keyed to the tree it graded, replacing a bare count. `finalEvaluationFor` derives `invalidated` per entry so an attempt against a later-rejected tree reads back as invalidated, and a malformed entry degrades the whole record to absent — a dropped entry would understate the spent budget and buy a free extra dispatch.
- The evaluator is handed both tree IDs in `prompts/evaluator-final.md` and told to copy them verbatim. It stands in a disposable worktree whose HEAD commit is the checkpoint's, so `git rev-parse HEAD` would give it a commit where the verdict wants a tree; the orchestrator passes `finalCheckpoint.treeId` and `finalCheckpoint.commitSha` from the same capture so the two cannot disagree.
- Baseline invalidation withdraws the citation (`baselineTreeId` and `baselineArtifactPath` dropped from the `finalEvaluations` record) and appends the rejected tree to `invalidatedCandidateTreeIds`. It rewrites nothing under `approvedBaselines` and touches no `approved-baseline.json`, so P-03's single writer pair stays the only writer.
- `buildFinalChangeSummary` validates that the supplied stages tile the baseline → final range exactly (first `fromRef` at the baseline, last `toRef` at the final checkpoint, no gaps, no duplicate stage ids) rather than inferring stage boundaries, so a byte no stage is accountable for is a throw instead of an unattributed file.
- The final review's repair vocabulary is a typed literal union, and a `preservation` finding routes only to the single post-approval writing stage with `restore` as its only admitted repair; a `baseline-is-wrong` finding routes to the generator loop and consumes one generator round and zero final-evaluation attempts.
- Three spawned scenarios in `src/qa-orchestration.test.ts` share one `finalEvaluationFixture` helper: the one-invocation PASS (B-03), the generator return (B-09), and the refused fourth attempt (B-10). Each needs a different evaluator answer *and* a different pre-seeded state, which a shared result cannot express, and all three assert counters the orchestrator only moves inside a real run — the round counter across a return, and the absence of a dispatch under an exhausted bound. Everything else went to unit tests.

# Gotchas / learnings

- The approved baseline's `treeId` is the QA *checkpoint* tree, not the tree the
  slice merges. Anything downstream that wants to compare a later tree against
  the approval has to go through the QA-window check first, exactly as
  `baselineAuthorizedTreeId` in `src/orchestrator.ts` does; a bare
  `baseline.treeId === someLaterTree` is always false.
- `finalEvaluationFixture` in `src/qa-orchestration.test.ts` takes
  `stageWrites: false` to run production's no-op writing stage. That is the only
  fixture shape that reaches a recorded `reuse`, and the `[behavior:B-02]`
  scenario reads all three stores out of the run rather than seeding them.
- P-01's "mutex-serialized merge" half cannot be asserted from this slice:
  `runSliceExecute` stops at the accepted candidate and `src/wave.ts` performs
  the merge. It is cited to the wave suite's `B-05` assertion by name instead,
  and the in-slice test is titled for what it actually checks — that no lock
  primitive identifier appears in any of this slice's modules. Prose in
  `src/run-events.ts` and `src/logger.ts` legitimately names the merge mutex, so
  that check matches identifiers (`mergeMutex`, `makeAsyncMutex`, …), not the
  word.
- `src/run-state.test.ts` asserts the stamped run-state version as the literal `4` in eight places, and P-06's required 4 → 5 bump makes those fail on the expected value alone. The operator widened the scope to that file, so the eight assertions now read `5` and the B-13 title was retitled. The four `version: 4` objects handed to `adaptLoadedState` (the #91 baseline-locator and #193 malformed-waiver fixtures) deliberately stay at `4`: they are the "a v4 file still loads" coverage P-06 exists to protect, and `adaptLoadedState` still accepts `3 | 4 | 5`.
- The B-13 upgrade loop in that file still iterates `[undefined, 1, 2, 3, 4]`; a future bump should add the new predecessor version to that list rather than only re-stamping the expected value.
- Run state lives at `.afk/state/<prd-slug>.json`, not `.afk/run-state-<slug>.json`; a hand-written fixture at the wrong path loads as an empty state and silently passes nothing.
- `saveRunState(repoRoot, state)` refuses to replace existing state, so seeding a fixture record goes through `updateRunState(repoRoot, slug, mutate)`.
- The waivers field on persisted state is `appliedWaivers` with `PersistedAppliedWaiver` entries (`riskClass`, `path`, `author`, `reason`), not `appliedProtectedChangeWaivers`.
- `QAReviewStageResumeState` carries `history`, `unresolved` and `lastImplementationRound` — there is no `lastAttempt` field to assert against; the attempt number lives in the archived filename (`final-review-r<round>-a<attempt>.json`).
- The heavy suite script for `src/qa-orchestration.test.ts` is `pnpm run test:heavy:qa`, not `test:heavy:qa-orchestration` (the suite label and the script name differ).
- The only `readdirSync(PROMPTS_DIR)` enumeration filters on `/merge|conflict|resol/i`, so adding `prompts/evaluator-final.md` breaks no prompt-inventory test.
- `recordApprovedBaseline` writes under the bare `config.prdSlug`, while a run with a run-slug (`<slug>-stub`, `<slug>-r2`, …) loads its state under that run-slug. Reading the baseline from the run-slug state alone therefore finds nothing and the change summary silently reports "not generated"; the orchestrator now reads the run-slug state and falls back to the bare-slug state.
- There is no helper returning the worktree's HEAD sha: `git.resolveCommit` is `string | null`. `createCandidateCheckpoint(dir, checkpointDir, { materialize: false })` returns `{ treeId, commitSha }` together and is the only way to get a commit for a review worktree and the tree the review is keyed to from one observation.
- `final-review.json` and `final-report.md` (including the `-r<n>-a<n>` report form) are already in `QA_WINDOW_ARTIFACT_NAME`, so copy-back out of the review worktree and the post-QA review-artifact window both admit them with no new constant.
- Post-QA gate evidence files are named `attempt-<uuid>.json`, so calling `runPostQAGates` a second time in the same round cannot collide with the first call's evidence.
- `InvokeOptions.role` is a plain `string`, so a new role needs no provider-side type change; only `completionEvidence.role` (two declarations in `src/orchestrator.ts`) and the `invocation-completed` event's role union are closed and had to widen.
- `decideFinalVerdict` deliberately ignores the review's own `verdict` field — it grades conditions. A caller that hands it a FAIL review without routing the findings first gets a verdict that ignores the failure, so the routing has to come first.
