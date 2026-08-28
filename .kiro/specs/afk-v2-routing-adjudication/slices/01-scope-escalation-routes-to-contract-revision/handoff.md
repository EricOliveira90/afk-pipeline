# Handoff

## What shipped
- Generator escalation instructions: `prompts/generator*.md` and `agents/generator.md` define the canonical stop-and-escalate payload.
- Strict escalation validation: `src/escalation.ts:parseScopeEscalation` rejects malformed, declared, migration, and non-declarable paths.
- Focused contract revision: `src/orchestrator.ts:runFocusedScopeRevision` routes exact evidence through planner and fresh evaluator review.
- Same-round generation resume: `src/orchestrator.ts:runSliceExecute` invokes the generator again under the accepted revised file scope without spending an implementation round.
- Immutable attempt archives: `src/artifacts.ts:archiveScopeEscalationAttempt` stores round-and-attempt-stamped raw artifacts with overwrite refusal.

## Decisions made during implementation
- `escalation.md` contains raw version-1 JSON despite its Markdown extension.
- Path display casing is preserved, while comparisons use acceptance-manifest normalization.
- Focused contract evaluations use the next free contract-review archive round and validate as fresh reviews.
- A fresh generator invocation increments the escalation attempt stamp but keeps the implementation round unchanged.

## Gotchas / learnings
- Focused revision must add every requested path to both `contract.md` and `acceptance-manifest.json` before evaluation can re-lock the contract.
- Malformed escalation evidence is archived before parsing, so raw failure evidence survives.

## Status
Tests passing locally. No regressions.
