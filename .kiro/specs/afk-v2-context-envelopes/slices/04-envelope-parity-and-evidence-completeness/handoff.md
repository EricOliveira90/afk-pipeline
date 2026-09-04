## What shipped

- `B-01`: `src/orchestrator.ts:invokeAgent`
- `B-02`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-03`: `src/context-envelope.ts:assembleContextEnvelope`
- `B-04`: `src/context-envelope.ts:assertEnvelopeBudget`
- `B-05`: `src/orchestrator.ts:invokeAgent`
- `B-06`: `src/logger.ts:writeSummary`
- `P-01`: `src/context-envelope.ts:assertEnvelopeBudget`
- `P-02`: `src/context-envelope.ts:assemblePlannerRevisionEnvelope`
- `P-03`: `src/context-envelope.ts:assembleGeneratorEnvelope`
- `P-04`: `src/logger.ts:writeSummary`
- `P-05`: `src/agent-provider.ts:AgentProvider`

## Decisions made during implementation

- Planner revision keeps the existing resolved-history heading with `(none)` while excluding all resolved content and evidence, preserving prompt-template compatibility.
- Provider parity uses a fresh assembly for each named stub so repeated-assembly divergence cannot hide behind a shared object.
- Invocation byte evidence is compared with the exact prompt captured at the dispatch seam so the assertions stay exact when legitimate prompt text changes.

## Gotchas / learnings

- `resolvedFindings` remains accepted as an input property for legacy callers but planner revision assembly intentionally ignores it.
- The generator stub exposes `cache_read_input_tokens`; token evidence must preserve provider-exposed names verbatim.
