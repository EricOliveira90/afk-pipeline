# Handoff — 01-required-input-budget (#273)

## What shipped

- B-01: `src/context-envelope.ts:GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes` (98,304), asserted in `src/context-envelope.ts:assertEnvelopeBudget`
- B-02: `src/context-envelope.ts:assembleGeneratorEnvelope` (commit-log room, reserved before `boundRepairSituationCommitLog`) and `src/context-envelope.ts:mergeResolutionBlockRoom`
- B-03: `src/context-envelope.ts:measureRequiredReferencedArtifacts`, `src/context-envelope.ts:GeneratorEnvelopeInput.requiredReadRoot`, `src/context-envelope.ts:ContextArtifactReference.requiredInFull`
- B-04: `src/context-envelope.ts:measureRequiredReferencedArtifacts` (the `readFileSync` refusal) and `src/orchestrator.ts:assembleGeneratorRoundEnvelope`
- B-05: `src/context-envelope.ts:measureRequiredReferencedArtifacts` (the `counted` set and the inlined-locator skip)
- B-06: `src/run-events.ts` `prompt-assembly` variant, `src/context-envelope.ts:RequiredInputEvidence`, `src/context-envelope.ts:assembleContextEnvelope` (evidence construction)
- B-07: `src/context-envelope.ts:assertEnvelopeBudget` and `src/context-envelope.ts:envelopeArtifactByteBreakdown`
- B-08: `src/context-envelope.ts:assembleContextEnvelope` (`effectiveBudget`) and `src/context-envelope.ts:assembleGeneratorEnvelope` (the repair round's `budget`)
- B-09: `docs/adr/0069-the-generator-budget-counts-required-input.md`
- B-10: `src/logger.ts:renderPromptPreparationRefusal`, `src/logger.ts:promptPreparationRefusalSection`, `src/logger.ts:Logger.writeSummary`, `src/orchestrator.ts:assembleGeneratorRoundEnvelope`
- P-01: `src/context-envelope.ts:assembleGeneratorEnvelope` (`requiredPairArtifacts` keep `CONTRACT_PAIR_BY_REFERENCE` and no locator)
- P-02: `src/context-envelope.ts:assertEnvelopeBudget` (the `requiredReferenced === undefined` branch, byte-identical to before)
- P-03: `src/context-envelope.ts:assembleGeneratorEnvelope` (only the commit-log block yields; overflow refuses)
- P-04: `src/context-envelope.ts:ContextEnvelopeConfigurationError` (unchanged) reached through both new refusal paths
- P-05: `src/run-events.ts` (all five fields optional), `src/context-envelope.ts:assembleContextEnvelope` (fields spread only when measured), `src/logger.ts:Logger.writeSummary` (`total.promptBytes += event.assembledByteSize`, unchanged)

Tests: `src/context-envelope.test.ts` (B-01–B-09, P-01–P-05), `src/logger.test.ts` (B-10), `src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts` (P-05).

## Decisions made during implementation

- **The filesystem read lives in one place, and it is not `assembleContextEnvelope`.** `measureRequiredReferencedArtifacts` does the reading, deduplication and fail-closed refusal; `assembleContextEnvelope` takes pre-measured weights and does pure accounting. This is what makes B-02 possible at all: the repair round's room calculation and the budget assertion consume the same measurement, so they cannot disagree about what the pair weighs.
- **`requiredReadRoot` is optional, and its absence means "counted nothing".** Callers outside this slice's write boundary (`src/resume.test.ts`) call `assembleGeneratorEnvelope` with no worktree. Making the root required would have needed an out-of-scope edit; making it optional turns those callers into the inline-only path, which is exactly the pre-#273 behavior P-02 and P-05 ask to preserve. Both orchestrator seams supply it.
- **`inlineSizeBudgetBytes` keeps its name.** Six other roles read the same field as an inline-only budget and share the stricter-only override rule. Renaming it for one role would have touched every manifest and the override plumbing; only the generator's accounting changed, and ADR 0069 carries the meaning.
- **`assertEnvelopeBudget` has two messages, not one.** With `requiredReferenced` omitted it emits the pre-#273 inline-size refusal byte for byte; only the generator's path emits the four-term required-input message. A single unified message would have changed every other role's refusal text.
- **The `contextEnvelope` invocation evidence was widened by intersection at the call site.** `ContextEnvelopeInvocationEvidence` lives in `src/agent-provider.ts`, outside the boundary, so the two `invoke` signatures in `src/orchestrator.ts` declare `ContextEnvelopeInvocationEvidence & RequiredInputEvidence` instead. No escalation was needed.
- **A pointer is not a requirement.** `repair-context` references (`stuck.md`, `handoff.md`) are deliberately left unmarked by `requiredInFull`, so an absent `stuck.md` stays an ordinary pointer rather than a hard CONFIGURATION failure.
- **P-05 reuses existing spawned fixtures.** Both integration tests derive the pre-slice event by stripping the five new fields from the run's own real `prompt-assembly` event, so the "before" shape is the real one and no new pipeline scenario was added.

## Gotchas / learnings

- Raising the budget to 98,304 broke four existing assertions in `src/context-envelope.test.ts` that encoded 65,536 as a premise: the direct `toBe(65_536)`, a test name quoting it, a "pair plus other blocks overflows" arithmetic that no longer overflows, and a 70,000-byte overflow probe that now fits. All four were stale premises, not regressions; the overflow probes now use 100,000–120,000 bytes.
- `boundRepairSituationCommitLog` drops whole commits, so a reservation of N bytes does not shrink the prompt by exactly N — it shrinks by N rounded to a commit boundary, and the drop note's width changes with the dropped count. B-02 asserts the shrink is within one commit entry of the reserved weight rather than equal to it.
- `git log` is newest-first and the bound keeps from the front, so the *newest* commit survives a bounded log. A test asserting the oldest commit is retained will fail for the right reason.
- To land exactly on a byte boundary, probe with a one-byte free block and pad from the reported total. Probing with the default fixture block and then padding leaves the probe block's bytes in the sum and lands you short by its length — that cost one red assertion at 69,981 of 70,000.
- `RunJournal`'s `slices` map is private, so a summary-section unit test builds `SliceLifecycle` values with `lifecycle.error(...)` directly rather than reading them back out of a journal.
- The generator's inline weight at the 98,304 boundary is *below* the old 65,536 for any pair over ~32,768 bytes: the boundary is now made of the pair. Any assertion phrased as "inline is near the budget" is measuring the wrong thing.
