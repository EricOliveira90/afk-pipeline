## What shipped

- `B-01`: `src/orchestrator.ts:makeSliceContext`
- `B-02`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-03`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-04`: `src/context-envelope.ts:ContextEnvelopeConfigurationError`
- `B-05`: `src/agent-provider.ts:ContextEnvelopeInvocationEvidence`
- `B-06`: `src/logger.ts:Logger.writeSummary`
- `P-01`: `src/context-envelope.ts:assertEnvelopeBudget`
- `P-02`: `src/context-envelope.ts:assemblePlannerRevisionEnvelope`
- `P-03`: `src/context-envelope.ts:assembleGeneratorEnvelope`
- `P-04`: `src/logger.ts:Logger.writeSummary`
- `P-05`: `src/agent-provider.ts:AgentProvider.invoke`

## Decisions made during implementation

- Journal envelope evidence after a successful provider invocation so exposed token counts attach to the same event without duplicate pre-dispatch evidence.
- Preserve provider token-count field names verbatim and omit the map when a provider exposes none.

## Gotchas / learnings

- `includedArtifactClasses` and `includedArtifactIds` are ordered parallel arrays; consumers must preserve their index relationship.
- Vitest 3.2.4 can emit a post-run `onTaskUpdate` worker timeout on Windows even when the command exits zero; both fast-suite runs reproduced it after all test cases completed.
