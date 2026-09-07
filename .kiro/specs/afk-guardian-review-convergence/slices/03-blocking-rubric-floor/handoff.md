## What shipped

- B-01: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-02: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-03: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-04: `src/artifacts.ts:parseGuardianReview`, `src/ship-gate.ts:runShipGate`, and `src/run-state.ts:sanitizeGuardianRounds`
- P-01: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- P-02: `src/artifacts.ts:parseGuardianReview` and `src/run-state.ts:sanitizeGuardianFinding`
- P-03: `src/guardian-convergence.ts:advanceGuardianFindingLineage`
- P-04: `src/ship-gate.ts:runShipGate`
- New migration files: 0

## Decisions made during implementation

- Favorable legacy architect v1 artifacts remain readable with null authority evidence, while a v1 `FIX-BEFORE-SHIP` artifact is unparseable because it cannot prove v2 blocking authority.

## Gotchas / learnings

- New architect artifacts must use structured findings v2; the v1 compatibility path exists only for favorable historical records.
