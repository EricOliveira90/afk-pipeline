## What shipped

- `B-01`: `src/orchestrator.ts:makeSliceContext`
- `B-02`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-03`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-04`: `src/context-envelope.ts:ContextEnvelopeConfigurationError`
- `B-05`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-06`: `src/logger.ts:Logger.writeSummary`
- `P-01`: `src/context-envelope.ts:assertEnvelopeBudget`
- `P-02`: `src/context-envelope.ts:assemblePlannerRevisionEnvelope`
- `P-03`: `src/context-envelope.ts:assembleGeneratorEnvelope`
- `P-04`: `src/logger.ts:Logger.writeSummary`
- `P-05`: `src/agent-provider.ts:AgentProvider.invoke`

## Decisions made during implementation

- Journal envelope evidence after a successful provider invocation so exposed token counts attach to the same event without duplicate pre-dispatch evidence.
- Preserve provider token-count field names verbatim and omit the map when a provider exposes none.
- Declare artifact classes at each role/mode assembly call site so evidence keeps the prompt's exact order instead of inferring classes from reused file IDs.
- Treat the focused-scope contract evaluation as an initial evaluator envelope because only negotiation feedback selects the evaluator revision manifest.

## Gotchas / learnings

- `includedArtifactClasses` and `includedArtifactIds` are ordered parallel arrays; consumers must preserve their index relationship.
- Generator repair context belongs immediately after `repair-situation` in logical evidence because both are supplied before the locked contract and acceptance manifest.
- Repository artifact IDs in run evidence use forward slashes even when the host platform uses Windows path separators.
