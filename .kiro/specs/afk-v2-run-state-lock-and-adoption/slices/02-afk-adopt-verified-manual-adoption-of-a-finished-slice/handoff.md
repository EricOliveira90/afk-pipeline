# Handoff

## What shipped
- Verified manual adoption: `src/adopt-command.ts:runAdoptCli` verifies a detached candidate merge with every base gate before atomically installing it and persisting PASS state with provenance.
- Failed-gate refusal: `src/adopt-command.ts:firstFailedGate` names the failed gate and refuses before any live ref or state mutation.
- Merge-conflict refusal: `src/git.ts:createCandidateMerge` detects conflicts in a detached candidate worktree and cleans it up without changing live refs or state.
- Required adoption reason: `src/adopt-command.ts:parseArgs` rejects missing, empty, whitespace-only, and next-option values before any Git or state operation.
- Adoption provenance projections: `src/logger.ts:Logger.writeSummary` and `src/ship-gate.ts:buildPrCreationPlan` render adopter, reason, branch, and commit for adopted slices.
- Stable ordinary summaries: `src/logger.ts:Logger.writeSummary` preserves the pre-adoption bytes when no slice has adoption metadata.

## Decisions made during implementation
- The command syntax is `afk adopt <prd-slug> <slice> --branch <branch> --reason <reason> [--adopter <name>]`.
- Adopter identity resolves from `--adopter`, then `GITHUB_ACTOR`, then Git `user.name`.
- Gate evidence is written under `.afk/logs/<prd-slug>/adoptions/<attempt-id>`.
- Finalization uses `src/git.ts:updateBranchIfUnchanged`, backed by Git's ref-locking compare-and-swap, to move only the feature tip used to build the verified candidate.
- A competing feature update remains installed; adoption refuses without writing slice state.

## Gotchas / learnings
- `adopt` is exposed only by `afk`; the contract excludes `afk-claude adopt` and `afk-codex adopt`.
- Restored PASS lifecycle records carry persisted adoption metadata into run summaries through `src/slice-lifecycle.ts`.
- No migration files were added.

## Status
Tests passing locally. No regressions.
