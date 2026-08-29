# `afk adopt` Codebase Context

## Relevant Files

- **FACT** `src/afk.ts:34-79` is the Kiro CLI entry point; it advertises and dispatches bare `status`, `stop`, and `clean-failed` subcommands before pipeline-option parsing.
- **FACT** `src/afk-claude.ts:34-54` and `src/afk-codex.ts:34-54` duplicate the bare-subcommand usage/dispatch pattern for the other two package binaries (`package.json:6-10`).
- **FACT** `src/clean-failed.ts:266-284` is the nearest mutating subcommand pattern: an exported CLI runner parses arguments, resolves the repository/PRD, prints errors, and returns an exit code.
- **FACT** `src/run-state.ts:18-48,198-217,296-313,365-463` defines, loads, validates, saves, and tests completion of `.afk/state/<prdSlug>.json`.
- **FACT** `src/git.ts:684-714,832-875,947-953` owns migration-aware merge attempts, scratch/registered-worktree merging, conflict details, and ref-to-commit resolution.
- **FACT** `src/orchestrator.ts:265-286` exports `resolveBaseGateDeclarations()`, which maps the shared sanity plan to `typecheck`, `lint`, and `tests` declarations.
- **FACT** `src/gate-runner.ts:23-105,274-588` defines gate/evidence shapes and `runGates()`, which executes gates in a supplied checkout and writes evidence plus logs.
- **FACT** `src/preship.ts:21-43,105-128` discovers package-manager sanity commands and the optional frozen-lockfile preparation command used by base gates.
- **FACT** `src/logger.ts:213-321` builds and writes stable and per-run `run-summary.md` files from the journal's in-memory slice results.
- **FACT** `src/ship-gate.ts:80-138,556-571` centrally builds the draft-PR title/body and passes that body to `gh pr create`.
- **FACT** No production source currently defines `adopt`, `adopter`, or adoption metadata (`rg -n --glob '!**/*.test.ts' "adopt|adopter|adoption" src`, exit 1).

## Existing Behavior In Touched Files

- **FACT** CLI usage and subcommand dispatch are currently repeated in all three entry modules; `afk` alone also dispatches `status`, while all three dispatch `stop` and provider-aware `clean-failed` (`src/afk.ts:34-79`, `src/afk-claude.ts:34-54`, `src/afk-codex.ts:34-54`).
- **FACT** A missing state file loads as version 1 with `featureBranch: feat/<slug>` and no slices; v0 `status` records are upgraded, malformed phases throw, and optional scope/review/resume/migration data survive loading (`src/run-state.ts:198-291`).
- **FACT** A slice is complete only when its persisted entry has `phase === "PASS"` and `mergedToFeature === true`; restored completions are recorded and omitted from dispatch (`src/run-state.ts:459-463`, `src/orchestrator.ts:4294-4309,4354-4364`).
- **FACT** `saveSliceState()` re-reads state before replacing one slice record, preserving parallel slice updates; `clearSliceStateForDispatch()` removes the whole prior outcome but preserves non-outcome maps (`src/run-state.ts:365-422`).
- **FACT** `mergeSliceBranch()` leaves the feature branch unchanged on conflict by aborting the scratch-worktree merge, but performs the real feature-branch merge before returning success (`src/git.ts:832-875`).
- **FACT** `runGates()` records gate ID, status, failure kind, exit code, tree ID, details, evidence hash, and per-gate logs; it restores the candidate checkpoint before execution (`src/gate-runner.ts:31-105,274-318,588-628`).
- **FACT** Summary rows preserve existing lifecycle labels/branch dispositions and include base-gate attempts; summary output is written to both stable and run-specific paths (`src/logger.ts:235-321`, `src/slice-lifecycle.ts:189-286`).
- **FACT** Draft-PR planning preserves guardian-verdict and explicit override behavior and appends `Closes #...` lines (`src/ship-gate.ts:88-138`).

## Patterns In Use

- **FACT** Mutating subcommands expose a testable runner rather than testing `process.argv` directly: `runStopCli(args, repoRoot, deps)` returns `{ output, exitCode }`, while `runCleanFailedCli(args, provider?)` returns an exit code (`src/stop-command.ts:200-291`, `src/clean-failed.ts:266-288`).
- **FACT** Persisted state uses typed optional fields plus load-time sanitization/adaptation; save helpers serialize the complete version-1 object with two-space JSON indentation (`src/run-state.ts:18-109,208-313,369-379`).
- **FACT** Git operations return discriminated outcomes such as `{ status: "merged" } | { status: "conflict", details }`, and conflict paths attempt `git merge --abort` (`src/git.ts:13-21,778-795,832-875`).
- **FACT** Gate execution is separated from gate discovery: `resolveBaseGateDeclarations(cwd)` supplies declarations to `runGates(options)` (`src/orchestrator.ts:265-286`, `src/gate-runner.ts:52-105,274`).

## Test Infrastructure

- **FACT** Vitest includes `src/**/*.test.ts`; fixture git processes are isolated from host git configuration, use at most two workers, and have 60-second test/hook ceilings (`vitest.config.ts:5-67`).
- **FACT** `src/run-state.test.ts:128-224,423-468` exercises state-file round trips, completion, optional fields, and atomic slice updates; `src/git.test.ts:457-524` exercises successful/conflicting scratch merges.
- **FACT** `src/gate-runner.test.ts:59-155,157-1067` provides temp-checkpoint and gate-result coverage without launching a pipeline.
- **FACT** `src/logger.test.ts:124-221,337-351` directly checks summary byte stability/projections and both output locations; `src/orchestrator.test.ts:4234-4348` directly checks `buildPrCreationPlan()`.
- **FACT** `src/clean-failed.test.ts:38-105` shows the existing real-temp-git fixture pattern for a mutating PRD subcommand; it creates branches/worktrees and writes `.afk/state/<slug>.json`.
- **FACT** `src/test-support.ts:1-180` contains shared artifact writers and bounded Windows cleanup; `src/orchestrator.fixtures.ts:1-110` and `src/wave.fixtures.ts:1-100` are shared spawned-pipeline fixtures.
- **FACT** `pnpm test:fast` excludes orchestrator, wave, resume, QA, clean-failed, and E2E suites; the relevant heavy commands are `pnpm run test:heavy:orchestrator` and `pnpm run test:heavy:clean` (`package.json:24-31`).
- **FACT** Slice-agent handoff requires `pnpm test:fast` plus touched heavy suites rather than full `pnpm test` (repository `AGENTS.md`, “Test loop discipline”).
- **FACT** Harness/config blast-radius files are `vitest.config.ts`, `package.json`, `suite-budgets.json`, and any reused `src/test-support.ts` or `src/*fixtures.ts`; the budget catalog has separate `fast`, `orchestrator`, and `clean-failed` entries (`suite-budgets.json:38-43,181-186`).

## Data Model

- **FACT** The affected data store is JSON, not a database table: issue #129 names `.afk/state/<prd-slug>.json`, and `RunState` contains `version`, `prdSlug`, `featureBranch`, `slices`, and optional `scope`, `reviewPhase`, `resume`, and `migrations` (`gh issue view 129`; `src/run-state.ts:34-109`).
- **FACT** `PersistedSliceState` currently has `phase`, optional `branch`, `mergedToFeature`, `error`, and `collidingPrefixes`; the v1 validator reconstructs only those fields (`src/run-state.ts:18-32,296-313`).
- **FACT** Issue #129 requires a successful entry to add adopter, non-empty reason, branch, and commit, and requires conflict/gate/reason refusals to leave state unchanged (`gh issue view 129`).

## Integration Boundaries

- **FACT** The CLI resolves PRD identity from `issues.md`/DAG parsing and provider-specific run slugs; slice identity includes number, GH issue, title, type, and dependencies (`src/issues-parser.ts:3-78`, `src/orchestrator.ts:500-524,645-650`).
- **FACT** State completion feeds retry selection and dependency dispatch through `isSliceComplete()` (`src/cli-run-scope.ts:112-127`, `src/orchestrator.ts:4294-4309,4354-4364`).
- **FACT** Merge code depends on git refs/worktrees; gate code depends on the discovered sanity plan and bounded command runner; reporting consumes `RunJournal` state and `buildPrCreationPlan()` inputs (`src/git.ts:832-875`, `src/gate-runner.ts:1-16`, `src/logger.ts:213-235`, `src/ship-gate.ts:88-138`).

## Potential Conflicts

- **FACT** Commit `0e04efc` recently added `AWAITING-ADJUDICATION` across orchestrator, run-state/lifecycle, status, logger, and tests; later commits `50d6abb` and `fe4ab67` changed dependent-summary rendering (`git log --oneline -- src/run-state.ts src/logger.ts src/orchestrator.ts`).
- **FACT** Slice 02's handoff says `src/status.ts` and `src/artifacts.test.ts` were missed by its original file list and that parked state is terminal, persisted, and branch-bearing (`slices/02-impasse-parks-the-slice-the-run-continues/handoff.md:11-19`).
- **FACT** No `TODO`, `FIXME`, or `XXX` marker exists in the traced CLI/state/git/gate/reporting source set (`rg -n "TODO|FIXME|XXX" <traced files>`, exit 1).

## Unknowns

- **UNKNOWN** Issue #129 does not specify CLI option names, how `adopter` is sourced, or the exact adoption-record JSON shape.
- **UNKNOWN** Issue #129 names only `afk adopt`; it does not say whether `afk-claude` and `afk-codex` expose the same command.
- **UNKNOWN** Issue #129 does not define the gate-evidence archive location, whether adoption creates/updates a run log, or how an already-open draft PR body is updated.
- **UNKNOWN** The required behavior when the slice is absent from persisted scope, already complete, or represented by a provider-suffixed run-state slug is not stated in issue #129.
