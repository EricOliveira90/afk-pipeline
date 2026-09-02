## What shipped

- `B-01`: `src/context-envelope.ts:validateExplorerEvidenceMap`
- `B-02`: `src/context-envelope.ts:projectGeneratorPatternsAndHarness`
- `B-03`: `src/context-envelope.ts:buildExplorerRepositoryContext`
- `B-04`: `prompts/explorer.md` and `src/context-envelope.ts:assembleExplorerEnvelope`
- `B-05`: `src/orchestrator.ts:negotiateAttempt`
- `B-06`: `src/context-envelope.ts:assembleExplorerEnvelope`
- `P-01`: `src/orchestrator.ts:negotiateAttempt`
- `P-02`: `src/orchestrator.ts:negotiateAttempt`
- `P-03`: `src/prompt-template.test.ts`
- `P-04`: `src/context-envelope.ts:projectGeneratorPatternsAndHarness`

## Decisions made during implementation

- Explorer manifest version `1` uses a 65,536-byte default inline budget, matching the established generator-envelope precedent.
- Evidence maps use exact level-two headings, with optional `Data and integration` placed between `Patterns and test harness` and required `Unknowns`.
- Duplicate ADR numbers remain separate deterministic index lines keyed by filename; ADR headings enter the prompt, while ADR bodies do not.

## Gotchas / learnings

- The generator projector keeps the legacy full-context fallback only when the new `Patterns and test harness` heading is absent; valid new evidence maps project that complete section byte-for-byte.
