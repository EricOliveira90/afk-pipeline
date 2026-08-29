# Handoff

## What shipped
- Verified manual adoption: `src/adopt-command.ts:runAdoptCli` verifies a detached candidate merge with every base gate before merging and persisting PASS state with provenance.
- Failed-gate refusal: `src/adopt-command.ts:firstFailedGate` names the failed gate and refuses before any live ref or state mutation.
- Merge-conflict refusal: `src/git.ts:createCandidateMerge` detects conflicts in a detached candidate worktree and cleans it up without changing live refs or state.
- Required adoption reason: `src/adopt-command.ts:parseArgs` rejects missing, empty, and whitespace-only reasons before any Git or state operation.
- Adoption provenance projections: `src/logger.ts:Logger.writeSummary` and `src/ship-gate.ts:buildPrCreationPlan` render adopter, reason, branch, and commit for adopted slices.

## Decisions made during implementation
- The command syntax is `afk adopt <prd-slug> <slice> --branch <branch> --reason <reason> [--adopter <name>]`.
- Adopter identity resolves from `--adopter`, then `GITHUB_ACTOR`, then Git `user.name`.
- Gate evidence is written under `.afk/logs/<prd-slug>/adoptions/<attempt-id>`.
- The command rechecks both branch tips after verification and confirms the final feature tree matches the verified candidate tree.

## Gotchas / learnings
- `adopt` is exposed only by `afk`; the contract excludes `afk-claude adopt` and `afk-codex adopt`.
- `src/slice-lifecycle.ts` changed outside the locked expected-file list because restored PASS lifecycle records must carry persisted adoption metadata into run summaries.
- No migration files were added.

## Status
Tests passing locally. No regressions.
