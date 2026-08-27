# Handoff

## What shipped
- Strict canonical QA/UAT parsing: `src/qa-review.ts:parseQAReview`.
- Independent finding lifecycle enforcement: `src/qa-review.ts:advanceQAReviewHistory`.
- Raw, validation, and lifecycle evidence archives: `src/artifacts.ts:archiveQAReviewAttempt`, `archiveQAReviewValidation`, and `archiveQAReviewRecord`.
- Canonical verdict stage control and stage-specific history: `src/orchestrator.ts:runQAStage`.
- Unresolved-only evaluator and generator routing: `src/orchestrator.ts:formatUnresolvedQAFindings` and `runSliceExecute`.
- Canonical evaluator output contracts: `prompts/evaluator-qa.md` and `agents/evaluator.md`.

## Decisions made during implementation
- Each lifecycle finding's `artifactReferences` contains the canonical JSON archive and Markdown companion archive for that attempt.
- Archive collisions during `--resume-stuck` warn and preserve existing evidence, matching contract-review archive behavior.
- Generator retries receive findings from the stage that returned `FAIL/IMPLEMENTATION`; each evaluator receives only its own stage's current unresolved set.

## Gotchas / learnings
- A valid `PASS/NONE` attempt can retain unresolved advisory findings. Those findings remain in that stage's history without mixing into the other stage.
- Missing or invalid canonical data archives validation evidence but never creates a lifecycle record.

## Status
Tests passing locally. No regressions.
