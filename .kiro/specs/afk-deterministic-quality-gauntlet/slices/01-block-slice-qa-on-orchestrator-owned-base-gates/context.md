# Slice 01 Context: Orchestrator-Owned Base Gates

GH issue #49 requires AFK to checkpoint each generated candidate, run discovered baseline commands against that exact tree, and block behavioral evaluation and merge on required gate failure. The parent spec defines gate results as `PASS | FAIL | INFRASTRUCTURE | SKIPPED` with identity, stage, timestamps, duration, exit code, tree identity, and log identity (`docs/specs/afk-deterministic-quality-gauntlet.md:145-168,183-192`).

## Relevant Files

- `src/orchestrator.ts:103-200` - Discovers `typecheck`, `lint`, and `test:run`/`test`; currently executes them only in the post-merge sanity gate.
- `src/orchestrator.ts:748-932` - `SliceContext`, `makeSliceContext()`, provider invocation wrapper, resolved test command, sanity-command prompt block, cancellation, and retry wiring.
- `src/orchestrator.ts:1880-2210` - `runQAStage()` and `runSliceExecute()` implement generator/evaluator retries, QA report archives, optional shared-preview UAT, and the pre-merge PASS decision.
- `src/command-runtime.ts:16-95` - `runHeartbeatCommand(command, options): Promise<void>` streams stdout/stderr, resets inactivity on either channel, handles cancellation, and kills the process tree.
- `src/git.ts:200-208,702-729` - Worktree dirty check and commit helper; `resolveCommit()` and `resolveTree()` expose commit/tree identities.
- `src/wave.ts:409-526` - Calls `runSliceExecute()`, then validates the slice branch and commits-ahead before serialized merge and worktree removal.
- `src/run-events.ts:25-132` - Version-1 discriminated union for run, agent phase, shipping phase, outcome, and warning events.
- `src/run-journal.ts:35-232` - Sole write seam for typed events, lifecycle progress, persisted terminal outcomes, logs, and summaries.
- `src/logger.ts:25-49,120-238` - Current `SanityGateResult { ok, failures }`, per-invocation log naming, and `run-summary.md` rendering.
- `src/run-state.ts:18-82` - Version-1 persisted slice state and tree-keyed post-merge sanity/reviewer cache.
- `src/artifacts.ts:145-181` - Parses QA verdict/failure class and archives each QA attempt.
- `prompts/evaluator-qa.md:10-69` - Tells the evaluator to run baseline commands, collect independent failures, classify them, and review behavior/craft.
- `prompts/generator.md:10-24,38-72` - Preserves contract scope, existing behavior, test command, dependency handoffs, and retry obligations.
- `src/command-runtime.test.ts`, `src/qa-orchestration.test.ts`, `src/orchestrator.test.ts` - Focused command tests, QA-loop tests, and full temporary-repository orchestration tests.

## Existing Behavior in Touched Files

- `resolveSanityCommands()` reads consumer `package.json` once per context and returns ordered `pnpm run typecheck`, `pnpm run lint`, then `pnpm run test:run` or fallback `pnpm run test`; absent scripts and unreadable/missing `package.json` produce no command (`src/orchestrator.ts:120-161`).
- `runPreShipSanity()` runs every defined step even after failures and returns all failed step names; absent steps are skipped without a recorded result (`src/orchestrator.ts:175-200`).
- Each of at most three generator rounds invokes the generator, then deterministic evaluator QA immediately. Shared-preview UAT runs only after deterministic QA passes (`src/orchestrator.ts:2024-2140`).
- Evaluator infrastructure failures retry up to `infrastructureRetries` without another generator invocation. Every report is copied to `qa-report-r<round>-a<attempt>.md`; later generators receive all prior report paths (`src/orchestrator.ts:1904-2010,2072-2074`).
- `evalRounds` advances only after deterministic/shared-preview QA completes. Passing QA commits remaining work, optionally validates migrations, and returns slice PASS (`src/orchestrator.ts:2142-2160`).
- On the third implementation failure, the fallback generator writes `stuck.md`; cancellation returns `CANCELLED`; other thrown execution failures return `ERROR` (`src/orchestrator.ts:2163-2210`).
- A slice PASS is not yet merged. `runWave()` requires an existing slice branch with commits ahead, performs migration collision/merge checks under the merge mutex, removes the worktree, then records terminal PASS (`src/wave.ts:422-513`).
- Current evaluator authority is Markdown: `readQAVerdict()` accepts the last matching verdict marker, and PASS from `runQAStage()` controls advancement (`src/artifacts.ts:145-169`; `src/orchestrator.ts:1991-2010`).
- Existing public behavior remains generator/evaluator rounds, shared-preview isolation, resumption, cancellation, lane continuation, `MERGE-PENDING`, and the post-merge sanity/guardian ship gate (`README.md:77-121,451-480`; `CONTEXT.md:202-211,285-298,348-363`).

## Patterns in Use

- ESM TypeScript uses NodeNext and `.js` relative imports; strict mode and `noUncheckedIndexedAccess` are enabled (`tsconfig.json`).
- Orchestration state uses discriminated unions and named factories, e.g. `SliceLifecycle` plus `lifecycle.pass/stuck/error` (`src/slice-lifecycle.ts:32-55,75-150`).
- Observable transitions pass through `RunJournal`: `phase()` writes `run.log` plus an optional event; `event()` appends timestamped JSONL (`src/run-journal.ts:52-80`).
- Artifact attempts are append/preserve oriented: agent logs use `slice-<number>-<role>-r<n>.log`; QA archives include round and attempt and are not overwritten (`src/logger.ts:123-135`; `src/orchestrator.ts:1983-1991`).
- Optional configuration fields use local defaults: command inactivity 600,000 ms, heartbeat 30,000 ms, infrastructure retries 2, and slow-role wall clock 7,200,000 ms (`src/orchestrator.ts:64-101,526-554`).
- Independent checks collect all failures: current sanity execution continues across steps, and the QA prompt explicitly says not to stop at the first independent failure (`src/orchestrator.ts:185-199`; `prompts/evaluator-qa.md:54-57`).

## Test Infrastructure

- Vitest discovers `src/**/*.test.ts`; it uses the thread pool, two workers, and a 15-second default timeout (`vitest.config.ts:3-11`).
- Repository commands are `pnpm test` (`vitest run`), `pnpm typecheck` (`tsc --noEmit`), and `pnpm build`; Node.js 22+ is required. No repository `lint` script exists (`package.json:11-19,32-34`).
- `src/orchestrator.test.ts:382-510` creates real temporary Git repositories and a stub `AgentProvider` that writes contracts, implementation files, QA reports, and `stuck.md`.
- Existing baseline tests cover missing scripts, ordered discovery/execution, multiple failures, and `test:run` fallback (`src/orchestrator.test.ts:67-221`).
- QA-loop tests cover infrastructure retry without a generator round, preservation/injection of all QA reports, and centralized preview commands (`src/qa-orchestration.test.ts:92-195`).
- Event integration tests read real `events.jsonl` and assert timestamped phase pairs, verdicts, terminal outcomes, and infrastructure warnings (`src/orchestrator.test.ts:2793-3023`).

## Artifact and State Model

- Slice artifacts live under `.kiro/specs/<slug>/slices/<number>-<title>/`; run evidence lives under `.afk/logs/<run-slug>/run-<timestamp>/`; terminal state lives at `.afk/state/<run-slug>.json` (`README.md:254-272`; `CONTEXT.md:49-75`).
- `RunState.version` is `1`; slice records contain phase, branch, merge flag, error, and optional collision prefixes. Only the post-merge sanity PASS currently stores a tree SHA (`src/run-state.ts:18-82`).
- No database tables, migrations, routes, or access-control rules are involved in this slice.

## Integration Boundaries

- `runSliceExecute(ctx)` consumes `PipelineConfig`, `SliceContext`, the provider, Git helpers, artifact parsers, prompt rendering, command runtime, and `RunJournal`; it exports only a terminal pre-merge outcome (`src/orchestrator.ts:2016-2019`).
- `runWave()` owns merge authority; agent/evaluator code cannot merge directly (`src/wave.ts:409-513`).
- `PipelineConfig.signal`, `commandTimeoutMs`, `heartbeatIntervalMs`, `infrastructureRetries`, and `maxAgentDurationMs` are populated from CLI options and shared by all providers (`src/orchestrator.ts:502-587`; `src/cli-options.ts:26-41,134-188`).
- `runHeartbeatCommand()` currently resolves with no value and rejects on spawn error, inactivity/cancellation kill, or nonzero exit; it has no wall-clock option or structured timing/exit/log result (`src/command-runtime.ts:16-95`).

## Potential Conflicts

- Commit `75d9fd9` (2026-08-23) centralized terminal outcomes and observable writes in `RunJournal`, changing `orchestrator.ts`, `wave.ts`, `logger.ts`, tests, and the event vocabulary.
- Branch `refactor/ship-gate` commit `3f4a5d7` extracts current sanity discovery/execution from `src/orchestrator.ts` into `src/preship.ts`; it overlaps `src/orchestrator.ts:103-200`.
- Commit `63b7968` introduced the current coupling where `resolveSanityCommands()` supplies evaluator prompt commands; GH #49 changes command authority from evaluator prose to orchestrator evidence.
- Commit `c4aae77` introduced the current tree-first verified termination behavior in `runHeartbeatCommand()`.
- Repository history and source comments also use `#49` for the older STUCK-resume feature (`src/orchestrator.ts:778-792`; `src/run-events.ts:108-122`), so bare issue-number searches include unrelated results.
- No relevant TODO/FIXME exists in `src/` or `prompts/`. This spec currently has no sibling slice directories, branches, worktrees, or `handoff.md` files.
