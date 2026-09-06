## What shipped

- B-01: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-02: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-03: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- B-04: `src/ship-gate.ts:runShipGate` and `src/run-state.ts:sanitizeGuardianRounds`
- P-01: `src/guardian-blocking-authority.ts:guardianFindingMayBlock`
- P-02: `src/artifacts.ts:parseGuardianReview` and `src/run-state.ts:sanitizeGuardianFinding`
- P-03: `src/guardian-convergence.ts:advanceGuardianFindingLineage`
- P-04: `src/ship-gate.ts:buildPrCreationPlan`

## Decisions made during implementation

- Prior-lineage membership means the resolved stable ID appears in an earlier architect round, preserving the existing one-to-one collision rules.
- Missing legacy authority evidence normalizes to `null`; only an architect ledger that still claims impossible blocking authority is rejected.
- A `RESOLVED` architect finding never contributes blocking authority, including malformed round-1 or later-new combinations.

## Gotchas / learnings

- Architect artifacts now require structured findings v2, while PM artifacts remain v1 and persist null authority evidence.
- New migration files: 0
