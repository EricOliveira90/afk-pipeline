# Handoff — slice 03, changed trees face final evaluation; ROI evidence (#97)

- New migration files: 0

## What shipped

Four repairs against the round-1 QA findings, all inside the locked file scope.

**QA-01 — a second restore went to the stub, and the restore round's bytes were
billed to it** (`src/orchestrator.ts`). The final-evaluation loop captured the
cleaner's result once (`const cleaner`) and derived `stageInputTreeId` once, then
discarded the `CleanerStageResult` the restore re-dispatch returned. From the
second restore onward `buildWritingStageIds` compared the fresh
`currentFinalTreeId` against a stale input tree, appended
`POST_APPROVAL_WRITING_STAGE_ID`, and B-01's last-id rule handed the restore to a
stage that writes nothing; `writeFinalChangeSummary` tiled the same stale numbers
and named the stub as the author of the cleaner's `README.md` change. `cleaner` is
now a `let` reassigned from the re-dispatch, and the route and the summary tiling
both read two derived helpers — `cleanerWrote()` and `stageInputTreeId()` — over
the same three tree ids, so they cannot disagree about who wrote. The merge keeps
`ran` sticky, keeps the standing accepted tree as `inputTreeId`, and takes
`Math.max` on `roundsSpent` so the ADR 0050 bound can only tighten. The attempt's
loose `final-review.json` / `final-report.md` are removed before the re-dispatch.

**QA-02 — the attempt event's `inputTreeId` was the graded tree**
(`src/orchestrator.ts`). `buildQualityStageAttemptEvent` for
`final-evaluation` now takes the cited approved-baseline tree as `inputTreeId`
(falling back to the accepted tree when the attempt cites no baseline), matching
B-08 and the manifest. The comment that argued the contract's rule was wrong is
gone.

**QA-03 — a raw NUL made `src/logger.ts` binary to git** (`src/logger.ts`). The
pooling key in `deriveQualityStageOutcomes` joined `ghIssue` and `stage` with a
`0x00` byte; it is now `|`. Applied as byte surgery at offset 7336 — the Edit
tool cannot address a NUL. `git diff main -- src/logger.ts` renders lines again
(204 insertions, 2 deletions) and the file holds no `0x00`.

**QA-04 — a restore round reported a tree no round of it read**
(`src/cleaner-stage.ts`). A repair dispatch now resolves its start tree from the
worktree via `resolveCandidateTreeId` instead of reusing
`input.acceptedTreeId`; `baselineTreeId` still carries the approval's tree. The
round attempt, the recorded round, the dispatch input and the returned
`inputTreeId` all name that start tree, so the per-round chain on the stream is
continuous. Exit path 4 resets to that dispatch's own start commit and logs it.

Tests: the S1 spawned scenario now pins both tree slots of the final-evaluation
attempt; a new S4 `it` on the shared `finalEvaluationFixture` drives two
consecutive `RESTORE` verdicts with the cleaner as the only writing stage and
asserts three cleaner prompts, exactly one stub call with no `repair`, an
output-to-input cleaner chain, and a per-attempt change summary whose
`post-approval-writing` span is empty; a unit `it` in
`runCleanerStage restore rounds` pins the repair start tree against a real
pre-cleaner baseline.

## Decisions made during implementation

- The stage's `inputTreeId` is per-dispatch truth (the tree that dispatch read);
  the orchestrator keeps the *standing* accepted tree as the cleaner range's
  input. "Did the cleaner write?" has to be a question about the whole range,
  because that is what both the route and the summary tiling need — a
  per-dispatch answer would make a restore that changed nothing look like a
  cleaner that never wrote.
- The restore re-dispatch is the *same* stage, so the merged record is a
  widening, not a replacement: sticky `ran`, first-dispatch `inputTreeId`,
  non-decreasing `roundsSpent`.
- QA-01's fix removes the *cause* of the discontinuity rather than compensating
  for it: the evaluator's copied-back loose artifacts are deleted before the
  re-dispatch (the next loop iteration already did this, and each attempt's
  artifacts are archived), so `resolveCandidateTreeId` at re-dispatch time
  returns the graded tree.
- A restore round that takes exit path 4 (escalation) gets no new routing — the
  contract does not specify one. It resets to its own start commit and reports
  that tree, which is the truthful reading of "this attempt changed nothing".
- The three commits are grouped by cause, not one per behavior: QA-01 and QA-02
  are the same file and the same captured-state root, and splitting them would
  have produced a commit whose tests do not pass.

## Gotchas / learnings

- A NUL byte in a source file does more than break diffs on Windows: git treats
  the file as binary and therefore skips `core.autocrlf` normalization, so the
  committed blob carried CRLF. Removing the byte restores LF normalization, which
  is why the diff against `main` shrank to the lines this slice actually added.
- `resolveCandidateTreeId` hashes tracked *and* untracked paths. Anything the
  previous stage left loose in the worktree — including the evaluator's own
  `final-review.json` — lands in the candidate tree. An intermediate attempt that
  used `git rev-parse HEAD^{tree}` instead made the chain continuous but let the
  loose review file fall inside the round's diff, reddening a required gate and
  burning one of three rounds; deleting the artifacts is the fix that does not
  trade one defect for another.
- The pre-existing restore-round unit tests pass the cleaner's own tree as
  `acceptedTreeId`, which is why QA-04 was invisible at unit level. The new pin
  uses a real pre-cleaner baseline so the two tree facts can differ.
- `pnpm test:fast` on this host emits `[vitest-worker]: Timeout calling
  "onTaskUpdate"` unhandled errors under load. They are reporter RPC timeouts,
  not test failures — the file and test counts are unaffected.
