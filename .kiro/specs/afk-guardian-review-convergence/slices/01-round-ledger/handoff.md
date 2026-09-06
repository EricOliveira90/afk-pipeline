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
- When both known aliases of one prior identity appear in a later artifact, prefer the canonical stable-ID claimant and fold the duplicate current-alias entry so no new lineage is minted.
- Persist a completed pair once across every post-review exit; artifact-commit error paths use the latest resolvable HEAD and do not populate favorable cache fields.
- Mark round persistence complete only after the synchronous state writer returns so a failed first write remains eligible for the existing catch-path retry.

## Gotchas / learnings

- Cache-backed findings are valid only when the latest earlier round with a matching post-review HEAD carries provenance to an invoked record.
- A prior finding's stable and current aliases can both appear in one later artifact; lineage allocation must reserve stable identities one-to-one across both aliases.
- Fatal review-worktree drift keeps its block and records the drifted HEAD, while artifact commit failures retain their existing exception path after recording the pair.
- A successful catch-path retry records one round and still rethrows the original state-write error; draft-PR handling does not begin.
- New migration files: 0
