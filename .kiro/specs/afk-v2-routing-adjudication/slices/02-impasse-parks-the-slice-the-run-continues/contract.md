# Slice Contract — Impasse parks the slice, the run continues

**Parent PRD:** .kiro/specs/afk-v2-routing-adjudication/prd.md
**GH issue:** #81
**Status:** LOCKED
**Negotiation round:** 2

## Scope lock
Route a round-two contract `IMPASSE` to a persisted `AWAITING-ADJUDICATION` slice outcome, preserve its existing structured evidence, and let DAG-independent work continue while dependents remain visibly blocked (GH #81; PRD stories 3, 6, 10, 15, 16).

### In scope
- [behavior:B-01] Given round-two exhaustion leaves **every** unresolved blocking finding `CONTESTED`, when negotiation ends, then run state, the `slice-outcome` event, `run-summary.md`, and `afk status` each expose `AWAITING-ADJUDICATION`, the parked branch, and the impasse reason; omission of the branch or reason from any projection fails verification (GH #81 AC1; PRD stories 3, 10).
- [behavior:B-01a] Given round-two exhaustion leaves a `CONTESTED` blocking finding **beside** an unresolved `OPEN` blocking finding, when negotiation ends, then the slice classifies `NON_CONVERGENCE` and routes to the operator as `ESCALATE` — not to a park — **and** the diagnosis surfaces the contest: `stuck.md` names each contested finding with both held positions and both sides' evidence, names the `OPEN` blocker that made the exhaustion non-adjudicable, and states that closing it and rerunning makes a surviving contest park adjudicably; the run-state reason names the contest too. A silent non-convergence that drops the contested positions fails verification (ADR 0055 §1, ADR 0041; PRD stories 3, 10).
- [behavior:B-02] Given that impasse, when failure artifacts are preserved, then the existing `contract-negotiation-outcome.json` has classification `IMPASSE` and carries each contested finding ID, evaluator-held state, planner position, planner evidence, and evaluator evidence verbatim in the working slice and review archive (GH #81 AC2; PRD Testing Decisions).
- [behavior:B-03] Given an impasse slice has DAG-independent siblings, including a later member of the same file-overlap lane, when the wave runs, then those siblings continue under existing lane rules and may complete normally (GH #81 AC1/AC4; PRD stories 6, 15).
- [behavior:B-04] Given a slice depends on the parked slice, when the run finishes and `afk status` reads its artifacts, then the dependent is not dispatched and both `run-summary.md` and status name it as blocked by the parked issue in `AWAITING-ADJUDICATION` (GH #81 AC4; PRD stories 6, 15).
- [behavior:B-05] Given `AWAITING-ADJUDICATION` is already persisted while other work remains active, when cancellation occurs, then the parked phase and branch value remain unchanged, both working and archived impasse artifacts remain unchanged, and only unsettled slices become `CANCELLED` (GH #81 AC5; PRD story 16).

### Non-goals (explicit out-of-scope)
- Reading or validating `adjudication.md`, applying a human decision, re-locking, live re-enqueue, bounded waiting, or next-run adjudication resumption; those belong to #89 (PRD stories 4, 7-9 and post-wave-3 alignment note).
- Babysit courier behavior or skill relocation (#94), code-assembled stuck diagnosis (#82), and `afk adopt` (#129) (PRD Solution, stories 11-14 and 17, and post-wave-3 alignment note).
- Generator scope escalation (#80), QA-side `SCOPE_AMENDMENT`, or changes to ADR 0048 routing (PRD post-wave-3 note; ADR 0048).
- A second impasse schema or artifact; this slice routes the PRD 1 `contract-negotiation-outcome.json` record named by GH #81.

### Existing behavior to preserve
- [behavior:P-01] Given round-two exhaustion has unresolved blocking findings but none is `CONTESTED`, when negotiation ends, then classification remains `NON_CONVERGENCE`, the slice remains `ESCALATE`, and current failure artifacts and reason text remain available (GH #81 AC3; PRD story 10; `src/contract-review.ts:buildContractNegotiationOutcome`).
- [behavior:P-02] Given negotiation ends through malformed artifacts, lock refusal, infrastructure failure, an unlocked contract, or cancellation before an impasse is decided, when routing occurs, then existing `ERROR`, `STUCK`, `ESCALATE`, or `CANCELLED` behavior remains unchanged (PRD Implementation Decisions; `src/orchestrator.ts:runSliceNegotiate`).
- [behavior:P-03] Given ordinary failed, deferred-merge, or passing slices share a wave or lane, when scheduling, cleanup, persistence, and summaries run, then existing `PASS`, `STUCK`, `MERGE-PENDING`, lane-continuation, and branch-preservation semantics remain unchanged (GH #81 "lanes follow existing continuation rules"; PRD Implementation Decisions; `src/wave.ts:runWave`, `src/clean-failed.ts:runCleanFailed`).

### Changes to existing behavior (only if the issue asks for it)
- "Exhaustion with a finding still CONTESTED parks the slice as awaiting-adjudication in run state" replaces the current plain `ESCALATE` outcome for `IMPASSE` only (GH #81 AC1).

## Files expected to change
- src/orchestrator.ts
- src/wave.ts
- src/slice-lifecycle.ts
- src/run-state.ts
- src/run-journal.ts
- src/logger.ts
- src/status-future.ts
- src/status-pipeline.ts
- src/orchestrator.test.ts
- src/orchestrator-runs.test.ts
- src/orchestrator.fixtures.ts
- src/wave.test.ts
- src/wave.fixtures.ts
- src/slice-lifecycle.test.ts
- src/run-state.test.ts
- src/run-journal.test.ts
- src/logger.test.ts
- src/status-future.test.ts
- src/status-pipeline.test.ts
- src/status.test.ts
- src/run-snapshot.test.ts
- src/status.ts (added by scope amendment for QA finding QA-01)
- src/artifacts.test.ts (added by scope amendment for QA finding QA-01)

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- Add persisted lifecycle phase `AWAITING-ADJUDICATION` through the existing lifecycle/journal projections. Reuse version-1 `contract-negotiation-outcome.json`; no dependency or new artifact schema (GH #81 What to build).

## Test plan
- Given a held round-two `CONTESTED` finding and known parked branch, when `pnpm vitest run src/orchestrator.test.ts` exhausts negotiation and the status projections are read, then run state, the `slice-outcome` event, `run-summary.md`, and `afk status` each assert `AWAITING-ADJUDICATION`, that branch, and the impasse reason; absence of the branch or reason in any one projection fails the scenario.
- Given that impasse has multiple contested findings with distinct values, when the same focused suite reads the working and archived `contract-negotiation-outcome.json`, then both copies match classification `IMPASSE` and every contested finding ID, evaluator-held state, planner position, planner evidence, and evaluator evidence verbatim.
- Given the existing non-convergence fixture, when the same focused suite runs, then it still returns `ESCALATE` with classification `NON_CONVERGENCE`.
- Given one parked slice, a DAG-independent same-lane sibling, and a dependent, when `pnpm run test:heavy:wave` and `pnpm run test:heavy:orchestrator` run their shared scenarios, then the sibling passes, the dependent is never invoked, and summary/status output names the dependency hold.
- Given a parked outcome followed by cancellation of an active sibling, when the cancellation fixture completes, then persisted state retains `AWAITING-ADJUDICATION` and the exact parked branch, both impasse artifact copies are unchanged, and only unsettled work records `CANCELLED`.
- Given the new phase crosses lifecycle, persistence, journal, logger, snapshot, and status projections, when `pnpm run typecheck` and `pnpm test:fast` run, then exhaustive phase handling compiles and focused projection tests pass.

## Definition of done
- [ ] `IMPASSE` alone produces a persisted `AWAITING-ADJUDICATION` outcome with verbatim structured evidence.
- [ ] Independent siblings continue; DAG dependents do not dispatch and are visibly blocked in summary and status output.
- [ ] Cancellation leaves the parked phase, branch, and impasse artifacts unchanged.
- [ ] Non-convergence and existing terminal, lane, cleanup, and branch semantics retain their specified behavior.
