# Handoff

## What shipped
- Strict canonical QA/UAT parsing: `src/qa-review.ts:parseQAReview`.
- Independent finding lifecycle enforcement: `src/qa-review.ts:advanceQAReviewHistory`.
- Raw, validation, and lifecycle evidence archives: `src/artifacts.ts:archiveQAReviewAttempt`, `archiveQAReviewValidation`, and `archiveQAReviewRecord`.
- Canonical verdict stage control and stage-specific history: `src/orchestrator.ts:runQAStage`.
- Failed-attempt evidence preservation before retries: `src/orchestrator.ts:runQAStage`.
- Unresolved-only evaluator and generator routing: `src/orchestrator.ts:formatUnresolvedQAFindings` and `runSliceExecute`.
- Canonical evaluator output contracts: `prompts/evaluator-qa.md` and `agents/evaluator.md`.
- Parser-validated canonical prompt example: `src/prompt-template.test.ts` and `prompts/evaluator-qa.md`.
- STUCK-resume lifecycle continuity: `src/qa-review.ts:loadQAReviewResumeState` and `src/orchestrator.ts:runSliceExecute`.

## Decisions made during implementation
- Each lifecycle finding's `artifactReferences` contains the canonical JSON archive and Markdown companion archive for that attempt.
- Archive collisions during `--resume-stuck` warn and preserve existing evidence, matching contract-review archive behavior.
- Generator retries receive findings from the stage that returned `FAIL/IMPLEMENTATION`; each evaluator receives only its own stage's current unresolved set.
- Failed evaluator invocations preserve and validate partial output but retain infrastructure retry accounting and do not advance lifecycle history.
- A STUCK resume replays strict code-derived records for each stage independently and fails closed if a preserved record is malformed.
- Resumed evidence uses the next round after every preserved QA/UAT raw, validation, record, or Markdown artifact, while retaining the three-attempt implementation cap for the resumed run.

## Gotchas / learnings
- A valid `PASS/NONE` attempt can retain unresolved advisory findings. Those findings remain in that stage's history without mixing into the other stage.
- Missing or invalid canonical data archives validation evidence but never creates a lifecycle record.
- Canonical validation must precede the Markdown-presence decision so a missing companion cannot hide invalid canonical evidence.
- Resume routing comes from the latest failing stage record; prior report filenames may still appear as historical commit-log entries, but they are not repair inputs.

## Status
Tests passing locally. No regressions.
