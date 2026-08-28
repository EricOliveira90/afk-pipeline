# Handoff

## What shipped
- Versioned machine scope artifact: `src/acceptance-manifest.ts:parseAcceptanceManifest` validates and normalizes both file-scope states, and `prompts/planner.md` requires the companion artifact.
- Pre-evaluator refusal: `src/orchestrator.ts:runSliceNegotiate` spends planner rounds on missing or invalid manifests without invoking the evaluator.
- Manifest-driven lanes: `src/wave.ts:runWave` populates lane declarations from validated manifest paths, preserving explicit no-repository-change as known empty scope.
- Manifest-driven migrations: `src/migration-claims.ts:claimContractMigrations` uses manifest count and paths for claims, while `src/wave.ts:migrationPrefixGate` uses the same paths for legacy collisions.
- Stable migration claims: `src/migration-claims.ts:claimContractMigrations` returns a planner-facing lock objection when a later manifest changes a persisted claim count.
- Fail-closed resume: `src/orchestrator.ts:runSliceNegotiate` reopens prior locked contracts whose companion manifest is missing or invalid.

## Decisions made during implementation
- Version 1 objects reject missing and unknown keys so later schema additions require an explicit version change.
- Normalized paths are stored in the parsed manifest result and reused by every downstream consumer.
- Planner rounds and evaluator attempts have separate counters; rejected planner output creates no evaluator feedback number.
- A persisted claim remains authoritative across rounds; count disagreement does not release or reallocate prefixes.

## Gotchas / learnings
- `contract.md` file and migration sections remain required human-readable views, but no longer drive lanes, claims, or collision checks.
- Planner fixtures for unrelated integration scenarios must write a valid acceptance manifest or the fail-closed gate correctly prevents those scenarios from reaching generation.
- Migration-count corrections must keep the already claimed prefix count; the lock objection states that required count.

## Status
Tests passing locally. No regressions.
