# Handoff

## What shipped
- Focused initial envelope: `src/context-envelope.ts:assembleGeneratorEnvelope`
- Six-section locked contract projection: `src/context-envelope.ts:projectGeneratorContractView`
- Focused repair failure set: `src/context-envelope.ts:formatGeneratorFailureSet`
- Killed and STUCK repair-template resume: `src/orchestrator.ts:runSliceExecute`
- Fail-closed UTF-8 prompt budget: `src/context-envelope.ts:assembleGeneratorEnvelope`
- Immediately preceding prompt-assembly evidence: `src/orchestrator.ts:runSliceExecute`
- Deterministic prompt and evidence assembly: `src/context-envelope.ts:assembleGeneratorEnvelope`
- Plan-level escalation rules without full ADR bodies: `prompts/generator.md` and `prompts/generator-repair.md`

## Decisions made during implementation
- Set generator context manifest version to `1` and the default inline budget to 65,536 UTF-8 bytes.
- Fall back to the complete contract for legacy partial contracts; project complete standard contracts to the six locked sections.
- Allow `PipelineConfig.generatorInlineSizeBudgetBytes` to apply a stricter or larger effective budget.

## Gotchas / learnings
- Repair envelopes include only open finding fields and failed required-gate evidence; resolved findings and passing evidence stay omitted.
- Resume dispatch uses `generator-repair.md`; `generator-resume.md` no longer exists.
- Prompt-template line endings follow the checkout, while formatted failure-set content uses LF; assertions at that boundary must preserve the rendered template bytes.
- Vitest can report `[vitest-worker]: Timeout calling "onTaskUpdate"` after all fast tests pass while still exiting successfully.
- QA orchestration fixtures that enter generation must seed both locked `contract.md` and version-2 `acceptance-manifest.json` inputs.

## Status
Tests passing locally. No regressions.
