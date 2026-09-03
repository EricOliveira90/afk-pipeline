## What shipped

- `B-01`: `src/context-envelope.ts:assemblePlannerInitialEnvelope`
- `B-02`: `src/context-envelope.ts:assemblePlannerRevisionEnvelope`
- `B-03`: `src/context-envelope.ts:assembleContractEvaluatorInitialEnvelope`
- `B-04`: `src/context-envelope.ts:assembleContractEvaluatorRevisionEnvelope`
- `B-05`: `src/orchestrator.ts:runSliceNegotiate`
- `B-06`: `src/run-events.ts:RunEventPayload`
- `P-01`: `prompts/planner.md:Contract rules`
- `P-02`: `src/orchestrator.ts:runSliceNegotiate`
- `P-03`: `src/orchestrator.ts:runFocusedScopeRevision`
- `P-04`: `src/context-envelope.ts:assembleGeneratorEnvelope`

## Decisions made during implementation

- Treat a round-one planner call with a pending lock objection as a revision because an existing contract pair and concrete control-plane defect already exist.
- Keep role byte budgets in the versioned context manifests with optional pipeline overrides, matching the existing envelope configuration seam.
- Use an initial evaluator envelope until evaluator findings exist, even when a mechanical planner revision preceded that evaluation.

## Gotchas / learnings

- `renderPrompt` rejects missing and extra arguments, so each initial and revision assembler must pass an exact template-specific argument set.
- Focused scope fixtures identify the control situation by stable wording; keep that wording inside the separate revision control block.
- Locked slice review artifacts share this directory and remain untracked; stage `handoff.md` explicitly.
