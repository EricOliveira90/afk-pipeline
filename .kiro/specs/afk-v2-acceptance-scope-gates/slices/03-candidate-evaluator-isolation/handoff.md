# Handoff — 03 candidate evaluator isolation (#91)

- New migration files: 0

## What shipped

- B-01: `src/orchestrator.ts:createReviewIsolation` (disposable worktree from
  the candidate checkpoint commit via `git.createWorktree`, removed with
  `git.removeWorktreeOrWarn` on every exit path from `runQAStage`)
- B-02: `src/orchestrator.ts:REVIEW_SEED_ARTIFACTS` /
  `createReviewIsolation.seed` (per-attempt seeding of `contract.md` and
  `acceptance-manifest.json`, returning the seed manifest)
- B-03: `src/post-qa-gates.ts:QA_WINDOW_ARTIFACT_NAME` (exported; the
  copy-back allowlist in `createReviewIsolation.copyBack`)
- B-04: `src/qa-review.ts:scanReviewWorktreeWrites`, called once from
  `src/orchestrator.ts:collectReviewerWrites` inside the QA attempt loop
- B-05: `src/change-summary.ts:buildChangeSummary` and
  `src/change-summary.ts:writeCandidateChangeSummary`
- B-06: `src/orchestrator.ts:writeApprovedBaseline`,
  `src/run-state.ts:recordApprovedBaseline`,
  `src/run-state.ts:approvedBaselineFor`, `src/run-state.ts:RUN_STATE_VERSION`
  (4), `src/run-events.ts` `approved-baseline` variant
- B-07: `src/context-envelope.ts:CANDIDATE_EVALUATOR_CONTEXT_MANIFEST`
- B-08: `prompts/evaluator-qa.md` (`# Where you are working`,
  `# What you are judging`, `# Probes`)
- B-09: `src/logger.ts:Logger.writeSummary` (`## Candidate Review Isolation`)
- P-01: `src/qa-orchestration.test.ts` — red required pre-QA gate scenario,
  extended to assert no review worktree and no change summary
- P-02: `src/qa-orchestration.test.ts` — `scopeGateDeclaration`'s single
  post-QA call site, asserted on the existing red-scope scenario
- P-03: `src/qa-orchestration.test.ts` — attempt/round accounting on the
  checkpoint-evidence scenario
- P-04: `src/qa-orchestration.test.ts` — shared-preview UAT still invoked with
  `ctx.worktreeDir`
- P-05: `src/qa-orchestration.test.ts` — PASS with an open blocking finding
  still rejected by `src/qa-review.ts` validation

## Decisions made during implementation

- `runQAStage` was split rather than re-indented: the existing ~600-line
  attempt loop became `runQAStageAttempts`, and a thin `runQAStage` wrapper
  owns the isolation lifecycle (`try { … } finally { await isolation.dispose() }`).
  A whole-loop `try` would have rewritten every line in the diff for no
  behavior change.
- The review worktree needs the checkpoint *commit*, which `runQAStage` never
  received. A new `QAStageOptions.candidateCommitSha` carries it from the
  pre-QA call site; when a caller omits it (the ~20 direct-call tests),
  `reviewCandidateCommit` derives one with
  `createCandidateCheckpoint(..., { materialize: false })` so those runs still
  get isolation instead of silently falling back to the generator worktree.
- The worktree branch carries a UUID (`afk/qa-review/<label>-<uuid>`) because
  `git.createWorktree` → `createBranch` reuses an existing branch name; the
  branch is deleted after removal.
- `dispose()` deliberately passes no AbortSignal, so a cancelled run still
  tears its worktree down; `removeWorktreeOrWarn` warns instead of throwing.
- `seed()` deletes allowlisted basenames in the review slice dir before
  copying the pair in, so a stale report carried in the checkpoint tree cannot
  be copied back as this attempt's verdict.
- The copy-back allowlist is passed into `scanReviewWorktreeWrites` as a
  parameter instead of imported, keeping `post-qa-gates` and `qa-review`
  acyclic.
- The seed manifest and the copy-back allowlist are separate lists on purpose:
  the manifest exists only so orchestrator writes stay out of B-04's scan, and
  the allowlist is the boundary that decides what leaves the worktree.
- `approved-baseline.json` is written at the pre-QA call site, not inside
  `runQAStage`, because only there are `checkpoint.commitSha`,
  `checkpoint.treeId`, and `gateArtifacts` all in scope.
- Two declared `observableResult` halves are recorded here as deviations rather
  than asserted, because where they sit they would be vacuous. B-06's "an
  evaluator FAIL writes none" and P-05's "no `approved-baseline.json` is
  written": `writeApprovedBaseline` is only reachable from the `runSliceExecute`
  pre-QA call site (`src/orchestrator.ts:6191`), which no direct `runQAStage`
  scenario enters, so `expect(existsSync(baselinePath)).toBe(false)` there would
  pass with the writer deleted. The positive half is asserted on the spawned
  scenario that does reach it (`src/qa-orchestration.test.ts:1199`), and B-03's
  scenario asserts an *evaluator-authored* `approved-baseline.json` is discarded
  instead.
- P-01's `observableResult` names `src/orchestrator.test.ts` and the
  `slice-outcome` event's `evalRounds`; it is asserted in
  `src/qa-orchestration.test.ts` on the per-run evaluator dispatch count, for
  the resumed-lineage reason recorded under Gotchas.
- `RunState.version` is typed `3 | 4` rather than `4`: fixtures outside this
  slice's write boundary (`adopt-command.test.ts`, `cli-run-scope.test.ts`,
  `run-snapshot.test.ts`) hold literal-3 records and must keep compiling.
  Nothing reads a `3` back out of a loaded state — `adaptLoadedState` always
  returns `RUN_STATE_VERSION`.

## Gotchas / learnings

- `renderPrompt` throws both for a referenced-but-unsupplied arg and for a
  supplied-but-unreferenced one, so adding `{{CHANGE_SUMMARY_PATH}}` to
  `prompts/evaluator-qa.md` forced all four existing `evaluator-qa` render
  call sites in `src/prompt-template.test.ts` to supply it.
- Copy-back has to happen before `archiveAttemptEvidence()` on both the success
  and failure paths, so it lives in the invoke promise's `.finally` alongside
  `closeAgentLog`. `collectReviewerWrites` never throws, which keeps the
  evaluator's own error as the rejection cause.
- Bumping `RUN_STATE_VERSION` broke four in-boundary assertions that pinned
  version 3 (`run-state.test.ts` lines 150/167/244/256); they now read
  `RUN_STATE_VERSION` or 4.
- `PERSISTED_PHASES` rejects `"QA"` as a persisted slice phase — a run-state
  fixture needs one of the terminal phases (`PASS`, `STUCK`, …).
- `git status --porcelain` alone never lists `.afk`, which is gitignored, so
  the reviewer-write scan needs a second `--ignored` status scoped to that
  path; both reads pass `-c core.quotePath=false` so non-ASCII paths are not
  escaped. `--ignored` only names ignored files individually when
  `--untracked-files=all` is also passed; without it git collapses them to
  `!! .afk/`.
- Both halves of B-04 are easy to cover vacuously, and the coverage has to be
  built deliberately: the checkpoint tree already holds the seeded pair's bytes,
  so a scenario that seeds *identical* bytes reports nothing for the pair
  whether or not the seed manifest is subtracted. The B-01/B-02 scenario
  therefore has its first attempt rewrite `contract.md` and
  `acceptance-manifest.json` in `ctx.absSliceDir` — the amendment case — so the
  second attempt's seed is a real `M` line that only `seededPaths` suppresses.
  Likewise the `.afk/` write has to be made by a stub, or the second status read
  can be deleted with the suite still green.
- A working directory's slice identity is read off the *tail* of its path
  (`-s01`): `sliceFromCwd` in `src/orchestrator.fixtures.ts` matches
  `-s<number>` only at the end or before a `/`. The review worktree name must
  therefore keep the slice suffix last, or every pipeline fixture's stub
  evaluator resolves no slice and writes no verdict artifact.
- The resumed-final-round scenario used for P-01 restores prior progress
  counters from seeded lineage, so "no eval round" has to be asserted on the
  per-run evaluator dispatch count, not on `getSliceProgress`.
