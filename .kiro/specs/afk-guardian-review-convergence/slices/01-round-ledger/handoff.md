## What shipped

- B-01: `src/run-state.ts:saveReviewPhase`
- B-02: `src/ship-gate.ts:completedRound`
- B-03: `src/guardian-convergence.ts:advanceGuardianFindingLineage`
- B-04: `src/artifacts.ts:parseGuardianReview`
- B-05: `src/run-state.ts:sanitizeGuardianRounds`
- B-06: `src/run-state.ts:sanitizeGuardianRecord`
- P-01: `src/ship-gate.ts:guardianRecord`
- P-02: `src/ship-gate.ts:runGuardianReview`
- P-03: `src/ship-gate.ts:CapturedReviewArtifact`
- P-04: `src/run-state.ts:adaptLoadedState`
- P-05: `src/ship-gate.ts:buildPrCreationPlan`

## Decisions made during implementation

- Normalize guardian fingerprints by trimming, collapsing whitespace, and lowercasing class plus clear condition so formatting-only changes retain lineage.

## Gotchas / learnings

- Cache-backed findings are valid only when the latest earlier round with a matching post-review HEAD carries provenance to an invoked record.
- New migration files: 0
