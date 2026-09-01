# Slice 02 Context: Impasse Parks the Slice

## Issue Contract

- FACT: GH #81 requires exhausted `CONTESTED` negotiation to park the slice as awaiting adjudication, preserve the finding and both positions/evidences verbatim, continue siblings, block DAG dependents, preserve current non-contest escalation, and keep cancellation resumable (`gh issue view 81`).
- FACT: The parent PRD calls this phase run-state-backed "park-as-dependency"; human adjudication and bounded live waiting belong to later slice #89, while this slice covers stories 3, 6, 10, 15, and 16 (`.kiro/specs/afk-v2-routing-adjudication/prd.md:14-16`, `.kiro/specs/afk-v2-routing-adjudication/issues.md:8-9`).

## Relevant Files

- FACT: `src/contract-review.ts` defines finding/response schemas, attempt records, and exhaustion classification (`ContractReviewFinding`, `ContractResponseEntry`, `ContractReviewAttemptRecord`, `buildContractNegotiationOutcome`; lines 47-127, 687-735).
- FACT: `src/artifacts.ts` archives raw review attempts and writes `contract-negotiation-outcome.json`, `stuck.md`, and archive copies (`archiveContractReviewAttempt`, `preserveNegotiationFailure`; lines 290-371, 601-714).
- FACT: `src/orchestrator.ts` runs the two-round negotiation, derives the exhaustion record, currently preserves it and returns `ESCALATE`, then schedules DAG waves and reports unresolved dependencies (`runSliceNegotiate`; lines 2203-2546; `runPipeline`; lines 4225-4633).
- FACT: `src/wave.ts` converts non-locked negotiation results into wave outcomes, allows DAG-independent lane successors to continue, and reports outcomes immediately (`runWave`; lines 229-271, 334-456; `negotiateOutcome`; lines 590-605).
- FACT: `src/slice-lifecycle.ts`, `src/run-state.ts`, and `src/run-journal.ts` are the shared phase vocabulary, persisted projection, and single terminal-outcome projection seam (`SliceLifecycle`; lines 23-71; `projectForPersistence`; lines 320-360; `TerminalOutcome`/`terminalLifecycle`; lines 33-45, 455-482).
- FACT: `src/logger.ts` renders and writes `run-summary.md`; rows currently contain lifecycle status but no dependency column (`Logger.writeSummary`; lines 183-268).
- FACT: `src/status-future.ts` derives blocker status and "waits on" output, while `src/status-pipeline.ts` maps lifecycle buckets to `done/failed/blocked` matrix states (`buildFutureSection`; lines 124-247; `inferSliceState`; lines 219-233).
- FACT: `src/run-events.ts` serializes `SliceLifecycle` in `slice-outcome` events, and `src/run-snapshot.ts` folds those events with persisted state for status views (`src/run-events.ts:9-13,173`; `src/run-snapshot.ts:227-236,388-399`).

## Existing Behavior in Touched Files

- FACT: Final unresolved blocking records are `IMPASSE` when any is `CONTESTED`; otherwise they are `NON_CONVERGENCE`, and only unresolved blocking findings enter the outcome (`src/contract-review.ts:718-735`).
- FACT: Each attempt record carries finding ID, severity/state, unresolved flag, planner position/evidence, and evaluator evidence; the builder copies evidence strings directly (`src/contract-review.ts:103-127,687-715`).
- FACT: Exhaustion currently writes the classified outcome and a formatted "Exhaustion record," archives it, logs `ESCALATE`, and returns `{ phase: "ESCALATE", cause }` for both classifications (`src/orchestrator.ts:2514-2546`; `src/artifacts.ts:643-705`).
- FACT: Manifest/gate refusal, malformed response/review, infrastructure failure, and unlocked-contract fallbacks have separate `ESCALATE`, `ERROR`, or `STUCK` paths that do not necessarily carry a classified exhaustion record (`src/orchestrator.ts:2300-2326,2350-2366,2466-2483,2550-2583`).
- FACT: Only `completed` IDs unblock DAG dependents; all ordinary non-PASS wave outcomes enter `failed`, while independent lane members continue after ordinary failures (`src/orchestrator.ts:4380-4383,4556-4567`; `src/wave.ts:338-347,452-456`).
- FACT: At run end, an unrun dependent emits a typed `not-run-hold` warning with `blockedBy`; `afk status` renders blocker references from snapshot plus `issues.md` (`src/orchestrator.ts:4594-4633`; `src/status-future.ts:180-218,249-252`).
- FACT: Cancellation records every unsettled AFK slice as `CANCELLED` and retains its branch; `RUNNING` and `PENDING` are never persisted (`src/orchestrator.ts:4352-4364,4571-4585`; `src/run-state.ts:11-31,320-360`).
- FACT: Persisted non-complete phases are retried on the next invocation; dispatch clears their stale per-attempt state (`src/orchestrator.ts:4281-4314`; `src/run-state.ts:381-420`).
- FACT: Summary status currently collapses `ESCALATE` and `ERROR` to `STUCK`; `MERGE-PENDING` is the existing persisted, terminal-this-run, preserved-branch deferred phase (`src/slice-lifecycle.ts:177-266,280-286`).

## Patterns in Use

- FACT: Phase handling is exhaustive through the discriminated `SliceLifecycle` union, `PHASE_TRAITS`, named `lifecycle.*` factories, and switches without a default (`src/slice-lifecycle.ts:32-71,75-155,177-266`; `src/run-state.ts:324-360`).
- FACT: `RunJournal.recordTerminal` is the single projection seam for lifecycle, atomic run-state save, human log, and typed `slice-outcome` event (`src/run-journal.ts:313-343`).
- FACT: Artifact control flow validates structured JSON fail-closed, archives each raw attempt before acting, and treats audit-copy failure as a warning (`src/orchestrator.ts:2423-2483`; `src/artifacts.ts:290-325`).
- FACT: Lane order models file/resource overlap, not DAG dependency; ordinary failed members do not cancel lane successors (`src/wave.ts:334-373`).
- FACT: Status reads events, cumulative run state, and the issues DAG without mutating them (`src/status-future.ts:1-26`; `src/status.test.ts:377-449`).

## Test Infrastructure

- FACT: Pure schema/classification coverage lives in `src/contract-review.test.ts`; it already asserts verbatim planner/evaluator evidence and `IMPASSE` classification (`src/contract-review.test.ts:920-1036`).
- FACT: Negotiation integration coverage lives in `src/orchestrator.test.ts`; existing exhaustion cases assert `NON_CONVERGENCE`, `ESCALATE`, `stuck.md`, and `contract-negotiation-outcome.json` (`src/orchestrator.test.ts:2408-2658`).
- FACT: Multi-run persistence/cancellation coverage lives in `src/orchestrator-runs.test.ts`; its stop-sentinel fixture already has an in-flight slice and a DAG dependent (`src/orchestrator-runs.test.ts:240-364`).
- FACT: `src/orchestrator.fixtures.ts` supplies real temporary git repos and a deterministic `buildStubProvider`; describe-lifetime fixtures use one `beforeAll` run for multiple assertions (`src/orchestrator.fixtures.ts:1-16,106-133,222-320`).
- FACT: Wave continuation tests and their shared helpers are split across `src/wave.test.ts`, `src/wave-migrations.test.ts`, and `src/wave.fixtures.ts` to use both workers (`src/wave.test.ts:1-3`; `src/wave.fixtures.ts:1-15`).
- FACT: Phase/persistence/summary/status blast-radius tests are `src/slice-lifecycle.test.ts`, `src/run-state.test.ts`, `src/logger.test.ts`, `src/status-future.test.ts`, `src/status-pipeline.test.ts`, `src/status.test.ts`, `src/run-snapshot.test.ts`, and `src/run-journal.test.ts` (`src/slice-lifecycle.test.ts:17-138`; `src/status.test.ts:286-512`).
- FACT: Vitest includes `src/**/*.test.ts`, uses threads with two workers, and isolates fixture git config; slice handoff requires `pnpm test:fast` plus touched heavy suites, with `pnpm run test:heavy:orchestrator`, `pnpm run test:heavy:wave`, and `pnpm run test:heavy:resume` available (`vitest.config.ts:3-44`; `package.json:scripts`; `AGENTS.md:15-29`).
- FACT: `suite-budgets.json`, `scripts/timed-suite.mjs`, and `scripts/check-suite-budgets.mjs` are the timing-budget harness used by those commands (`package.json:scripts`; `AGENTS.md:49-58`).

## Data Model

- FACT: This area uses filesystem data, not database tables: working slice artifacts, `.afk/artifacts/<run>/slice-<n>/` archives, `.afk/state/<slug>.json`, and per-run `events.jsonl`/`run-summary.md` (`src/artifacts.ts:637-647`; `src/run-state.ts:34-54`; `src/run-events.ts:23-30`; `src/logger.ts:260-267`).
- FACT: Run state is schema version 1 with `slices: Record<string, PersistedSliceState>`; persisted phase, branch, error, PASS merge flag, and merge-collision prefixes are its current per-slice fields (`src/run-state.ts:18-54`).
- FACT: The exhaustion artifact is version 1 with classification, round, attempt, and finding records; no parser for a separate impasse artifact exists in the traced source (`src/contract-review.ts:121-127`; `rg -n "IMPASSE|impasse" src`).

## Integration Boundaries

- FACT: `orchestrator.ts` imports contract-review builders and artifact persistence, exports `NegotiateOutcome`/`runSliceNegotiate`, and `wave.ts` translates that result into `TerminalOutcome` (`src/orchestrator.ts:1305-1308,1909-1928`; `src/wave.ts:12-22,599-605`).
- FACT: `RunJournal` imports lifecycle and run-state projection; logger, events, snapshot, future status, and pipeline status all consume the same lifecycle vocabulary (`src/run-journal.ts:4-29`; `src/run-events.ts:9-17`; `src/status-future.ts:28-35`; `src/status-pipeline.ts:1-12`).
- FACT: DAG dependency data is `Slice.blockedBy`; readiness is computed from the completed set, and only PASS merged to the feature branch is complete across runs (`src/issues-parser.ts:3-25,92-109`; `src/run-state.ts:450-460`; `src/orchestrator.ts:4514-4532`).

## Potential Conflicts

- FACT: Slice #80 recently changed `src/orchestrator.ts`, `src/artifacts.ts`, `src/orchestrator.fixtures.ts`, and `src/orchestrator.test.ts` for focused scope revision (`git show --stat fd8cca9`).
- FACT: Slice #80's handoff says malformed escalation is archived before parsing, focused reviews share the review archive, and repair fixtures must repeat prior QA findings as resolved (`.kiro/specs/afk-v2-routing-adjudication/slices/01-scope-escalation-routes-to-contract-revision/handoff.md:12-20`).
- FACT: No `TODO`, `FIXME`, or `XXX` marker was found in the traced source/test set (`rg -n "TODO|FIXME|XXX" <traced files>`).

## Unknowns

- UNKNOWN: Must the parked phase's serialized name be exactly `AWAITING-ADJUDICATION`, or another spelling?
- UNKNOWN: Is `contract-negotiation-outcome.json` itself the required "impasse artifact," or must this slice introduce a separately named artifact?
- UNKNOWN: Should `run-summary.md` represent blocked dependents as lifecycle rows, a dependency column, or a separate section?
- UNKNOWN: On cancellation after the park outcome is already persisted, should the parked phase remain authoritative or be replaced by `CANCELLED`?
