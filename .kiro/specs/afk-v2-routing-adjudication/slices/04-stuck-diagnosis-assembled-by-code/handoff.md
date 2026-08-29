# Handoff

## What shipped
- B-01 deterministic diagnosis assembly, including zero-round ordinary resumes: `src/artifacts.ts:renderStuckDiagnosis`, `src/artifacts.ts:writeStuckDiagnosis`, and `src/orchestrator.ts:runSliceExecute`
- B-02 resolved/open lifecycle partitioning: `src/artifacts.ts:latestFindings` and `src/artifacts.ts:renderStuckDiagnosis`
- B-03 shared STUCK resume prompt: `prompts/generator-resume.md` and `src/orchestrator.ts:runSliceExecute`
- B-04 failed-resume diagnosis refresh with prior additional-artifact retention: `src/artifacts.ts:readStuckDiagnosisAdditionalArtifactReferences` and `src/orchestrator.ts:runSliceExecute`
- B-05 retired prompt and documentation-preservation guard: `src/prompt-template.test.ts`
- Shared renderer/pipeline byte fixture: `src/stuck-diagnosis.fixtures.ts`, consumed by `src/artifacts.test.ts` and `src/qa-orchestration.test.ts`

## Decisions made during implementation
- Findings use their latest archived state per QA stage and finding ID, then sort by ID and stage.
- Attempt evidence sorts numerically by round and attempt; additional artifact references sort lexically, omit references already carried by lifecycle records, and render `(none)` only when both sets are empty.
- A resumed run preserves only code-owned `Additional artifact` lines from the prior diagnosis; lifecycle, escalation, and commit sections are rebuilt from current archived evidence.
- Every STUCK exit uses one finalizer, including an ordinary resume whose archived evidence has already spent the implementation cap.
- Commit evidence uses the existing `git log <feature-branch>..HEAD --stat` representation.
- The retirement guard records slice base `770bb20eb6c1cae071b88a0596078675c26c86f4`.
- STUCK-resume assertions inspect the current unresolved-finding block separately from the preserved diagnosis because the diagnosis intentionally contains evidence from every prior round.

## Gotchas / learnings
- `stuck.md` is overwritten only after the final evaluator evidence is archived, including the one granted STUCK-resume attempt.
- Ordinary and STUCK resumes now share one template; their opposite worktree and refresh facts come from explicit situation blocks.
- `src/stuck-diagnosis.fixtures.ts` was not named in the locked file list; QA-03 required one shared seeded archive and expected Markdown value across the renderer and exhausted-pipeline tests.

## Status
Tests passing locally. No regressions.
