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
- Ordinary preserved-tree resume continuity and unresolved routing: `src/orchestrator.ts:runSliceExecute` and `prompts/generator-resume.md`.
- Lifecycle records and carry-forward for valid output from failed evaluator invocations: `src/orchestrator.ts:runQAStage`.
- One-attempt STUCK-resume limit: `src/orchestrator.ts:runSliceExecute`.
- Global round cap across resumes (QA r3 finding 2): `src/orchestrator.ts:runSliceExecute` — an ordinary resume now receives only the implementation rounds still unspent under the three-round cap, computed from the restored `firstRound`; exhaustion asserted in `src/qa-orchestration.test.ts` ("caps an ordinary resume at the rounds left under the three-round budget").
- Fail-closed required archives (QA r3 finding 3): `src/orchestrator.ts:runQAStage` — raw canonical and lifecycle-record archive failures now throw instead of warning. The raw-archive throw rides the existing infrastructure-retry path and exhausts as ERROR; the record throw ends the slice as ERROR directly. Covered in `src/qa-orchestration.test.ts` ("fails closed when the raw canonical archive cannot be preserved", "refuses PASS when the lifecycle record cannot be archived").

## Decisions made during implementation
- Each lifecycle finding's `artifactReferences` contains the canonical JSON archive and Markdown companion archive for that attempt.
- Generator retries receive findings from the stage that returned `FAIL/IMPLEMENTATION`; each evaluator receives only its own stage's current unresolved set.
- Failed evaluator invocations retain infrastructure retry accounting. Schema-valid output creates a lifecycle record and binds the next attempt; malformed partial output creates validation evidence without advancing history.
- A STUCK resume replays strict code-derived records for each stage independently and fails closed if a preserved record is malformed.
- Every preserved-tree resume restores independent QA/UAT histories and uses the next round after every preserved raw, validation, record, or Markdown artifact.
- `--resume-stuck` grants exactly one implementation/QA attempt after the original three rounds; a failure immediately runs the fallback and returns STUCK.

## Gotchas / learnings
- An ordinary resume whose archived evidence already shows all three rounds spent gets zero implementation attempts: the loop falls through to the `STUCK` return without invoking `generator-stuck` (it already ran in the slice's previous life). Only `--resume-stuck` earns the documented single attempt beyond the cap.
- The two required-archive failure modes fail closed asymmetrically, deliberately: a raw canonical archive failure happens inside the invocation-evidence flow, so it is retried as infrastructure and exhausts as ERROR; a lifecycle-record failure happens after the review verdict is already known, so retrying would re-invoke the evaluator over a local write failure — it ends the slice ERROR immediately.
- The validation-evidence archive (`archiveQAReviewValidation`) still warns on failure. It was left out of the fail-closed change on purpose: QA r3 finding 3 named only the raw and record writes, and every path that reaches the validation archive already ends the attempt as artifact ERROR or infrastructure retry — it cannot precede a PASS.
- A valid `PASS/NONE` attempt can retain unresolved advisory findings. Those findings remain in that stage's history without mixing into the other stage.
- Missing or invalid canonical data archives validation evidence but never creates a lifecycle record.
- Canonical validation must precede the Markdown-presence decision so a missing companion cannot hide invalid canonical evidence.
- Resume routing comes from the latest failing stage record; prior report filenames may still appear as historical commit-log entries, but they are not repair inputs.
- A schema-valid artifact written before a provider disconnect is still a lifecycle attempt. Its resolved IDs cannot return, and its fresh open IDs must be dispositioned by the retry.

## Status
Tests passing locally. No regressions.
