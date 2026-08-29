# Handoff

## What shipped
- B-01 deterministic diagnosis assembly: `src/artifacts.ts:renderStuckDiagnosis` and `src/artifacts.ts:writeStuckDiagnosis`, called by `src/orchestrator.ts:runSliceExecute`
- B-02 resolved/open lifecycle partitioning: `src/artifacts.ts:latestFindings` and `src/artifacts.ts:renderStuckDiagnosis`
- B-03 shared STUCK resume prompt: `prompts/generator-resume.md` and `src/orchestrator.ts:runSliceExecute`
- B-04 failed-resume diagnosis refresh: `src/orchestrator.ts:runSliceExecute`, verified through `src/resume-integration.fixtures.ts`
- B-05 retired prompt and documentation-preservation guard: `src/prompt-template.test.ts`

## Decisions made during implementation
- Findings use their latest archived state per QA stage and finding ID, then sort by ID and stage.
- Attempt evidence sorts numerically by round and attempt; additional artifact references sort lexically and omit references already carried by lifecycle records.
- Commit evidence uses the existing `git log <feature-branch>..HEAD --stat` representation.
- The retirement guard records slice base `770bb20eb6c1cae071b88a0596078675c26c86f4`.
- STUCK-resume assertions inspect the current unresolved-finding block separately from the preserved diagnosis because the diagnosis intentionally contains evidence from every prior round.

## Gotchas / learnings
- `stuck.md` is overwritten only after the final evaluator evidence is archived, including the one granted STUCK-resume attempt.
- Ordinary and STUCK resumes now share one template; their opposite worktree and refresh facts come from explicit situation blocks.
- Prior-round artifact references are expected inside the preserved diagnosis; only the current unresolved-finding block is latest-state repair input.

## Status
Tests passing locally. No regressions.
