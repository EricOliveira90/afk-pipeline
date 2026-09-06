## What shipped

- B-01: `src/ship-gate.ts:persistCompletedRound`
- B-02: `src/ship-gate.ts:persistCompletedRound`
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
- Persist a completed pair once across every post-review exit; failed artifact paths use the latest resolvable HEAD and do not populate favorable cache fields.
- Mark round persistence complete only after the synchronous state writer returns so a failed first write remains eligible for the existing catch-path retry.

## Gotchas / learnings

- Cache-backed findings are valid only when the latest earlier round with a matching post-review HEAD carries provenance to an invoked record.
- Fatal review-worktree drift keeps its block and records the drifted HEAD, while artifact commit failures retain their existing exception path after recording the pair.
- A successful catch-path retry records one round and still rethrows the original state-write error; draft-PR handling does not begin.
- New migration files: 0
