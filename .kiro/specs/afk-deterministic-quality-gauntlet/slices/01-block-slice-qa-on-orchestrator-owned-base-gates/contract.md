# Slice Contract — Block slice QA on orchestrator-owned base gates

**Parent PRD:** .kiro/specs/afk-deterministic-quality-gauntlet/prd.md
**GH issue:** #49
**Status:** LOCKED
**Negotiation round:** 3

## Scope lock

This slice checkpoints each generated candidate, runs AFK's existing discovered baseline commands against that exact tree through one orchestrator-owned runner, retains structured evidence, and permits behavioral evaluation and merge only when every required base gate passes (issue #49; parent spec sections 2 and 5).

### Non-goals (explicit out-of-scope)

- Project quality-policy files, custom gate declarations, prerequisites, scope, cacheability, or cache reuse; those are parent-spec capabilities not required by issue #49.
- Structured evaluator schemas/isolation, changed-file enforcement, acceptance gates, focused role contexts, cleaner/hardener loops, final QA, guardian remediation, language-specific tools, or the live dashboard (PRD delivery constraints; parent spec delivery order and Out of Scope).

### In scope

- After each successful generator invocation, AFK creates and identifies an immutable candidate checkpoint before any base gate starts; later working-tree edits cannot affect gate input or evidence (issue #49 AC 1 and falsifiability constraints; parent spec section 5).
- One provider-independent runner executes the existing ordered `typecheck`, `lint`, and `tests` discovery set with cancellation, inactivity timeout, wall-clock limit, live stdout/stderr streaming, retained logs, and continuation after independent failures (issue #49 AC 2 and 4; ADR 0012; parent spec section 2).
- Every result records gate ID, stage, `status: PASS | FAIL | INFRASTRUCTURE | SKIPPED`, ISO start/end times, non-negative duration, exit code when present, checkpoint tree ID, and log artifact ID (issue #49 AC 3-5; parent spec section 2).
- `failureKind` is `COMMAND | CONFIGURATION` for `FAIL` and `null` otherwise. Missing required tooling is `FAIL/CONFIGURATION`; ordinary nonzero exit and timeout without external-outage evidence are `FAIL/COMMAND`; process-launch/substrate failure is `INFRASTRUCTURE`; an absent optional discovered script is `SKIPPED` (issue #49 AC 4-5 and infrastructure constraint; parent spec sections 2 and 13).
- Required `FAIL` or `INFRASTRUCTURE` blocks evaluator invocation and merge. All command failures from one checkpoint reach the next generator together; infrastructure retries do not consume a generator round; all required `PASS` results release behavioral evaluation (issue #49 AC 4, 6, and 9; parent spec sections 5 and 13).
- Per-checkpoint result/log artifacts survive later attempts unmodified. Typed events and `run-summary.md` expose each completed gate's status, `failureKind`, and elapsed time (issue #49 AC 3 and 8; parent spec sections 2 and 13).
- Cancellation terminates the command tree and the slice follows existing `CANCELLED` pipeline behavior. AFK retains the partial log but emits no fifth gate status or terminal gate-result event for the interrupted gate (issue #49 cancellation constraint; PRD delivery constraints; parent spec section 13).

### Existing behavior to preserve

- Missing/unreadable `package.json` and absent scripts remain non-blocking; discovery keeps `typecheck` -> `lint` -> `test:run`/`test` order and aggregate sanity uses the same set: `src/orchestrator.ts:resolveSanityCommands`, `runPreShipSanity` (ADR 0012; issue #49 AC 7).
- Behavioral evaluation, three generator rounds, archived QA reports, evaluator infrastructure retries, and separate shared-preview UAT remain after base gates release the checkpoint: `src/orchestrator.ts:runQAStage`, `runSliceExecute` (README, QA Rounds and Shared Preview).
- DAG, wave, lane, resumption, cancellation, MERGE-PENDING, aggregate sanity, guardians, and blocked-ship behavior remain intact (PRD delivery constraints).

### Changes to existing behavior (only if the issue asks for it)

- Baseline command success becomes orchestrator evidence before evaluation: "An agent report cannot replace command evidence or advance a failing candidate to behavioral review or merge."
- AFK checkpoints generator output before base gates: "After each generator attempt, AFK creates an immutable candidate checkpoint and keys all base-gate evidence to its tree identity."

## Files expected to change

- src/command-runtime.ts
- src/gate-runner.ts (new file)
- src/gate-runner.test.ts (new file)
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/qa-orchestration.test.ts
- src/run-events.ts
- src/logger.ts

## New patterns / deps / schema (if any)

- One reusable gate-runner interface and the gate-result schema defined above; no quality-policy schema and no new package dependency (issue #49; parent spec section 2).

## Test plan

- Given a real temporary repo whose stub generator writes a change, when generation returns, then AFK creates and identifies a checkpoint before the first gate; mutating the working tree afterward does not change gate input, tree ID, or retained evidence.
- Given all three discovered gates with observable start markers and one command writing distinct stdout/stderr markers, when gates run, then starts follow `typecheck`, `lint`, `tests`; both channels stream before exit and appear in the retained log; every result field is populated.
- Given evaluator prose says PASS but two independent required gates fail, when the full temporary-repository pipeline runs, then both result references reach the very next generator invocation, no evaluator attempt is consumed, and neither evaluation nor merge occurs.
- Given checkpoint A fails and repaired checkpoint B passes, when B completes, then A's unchanged results/logs remain beside B's evidence; all required PASS results invoke behavioral evaluation and evaluator PASS permits merge.
- Given missing required tooling, an absent optional script, ordinary nonzero exit, and process-launch failure, when gates run, then results are respectively `FAIL/CONFIGURATION`, `SKIPPED`, `FAIL/COMMAND`, and `INFRASTRUCTURE/null`; infrastructure retry leaves the generator round unchanged.
- Given a silent gate exceeds its inactivity timeout, when the runner observes no output, then it terminates the process tree for inactivity, records `FAIL/COMMAND`, and retains the result and partial log evidence.
- Given a gate continuously emits output beyond its inactivity timeout and wall-clock limit, when the runner receives those heartbeats, then inactivity does not terminate it, the wall-clock limit does, and `FAIL/COMMAND` result and log evidence are retained.
- Given PASS, both FAIL kinds, INFRASTRUCTURE, and SKIPPED results, when events and `run-summary.md` are inspected, then each completed outcome names its gate and non-negative elapsed time; the two FAIL kinds remain distinguishable.
- Given cancellation during a real child command, when the signal fires, then its process tree stops, its partial log remains, the slice is `CANCELLED`, and no terminal result/event with an invented status exists for that gate.

## Definition of done

- [ ] Every issue #49 acceptance criterion and falsifiability constraint passes through the UAT scenarios above.
- [ ] Failing base evidence cannot invoke behavioral evaluation or merge; passing evidence can.
- [ ] All tests pass locally: `pnpm typecheck`, `pnpm test`, and `pnpm build`
- [ ] No regression in existing suite
- [ ] Evaluator has signed off via qa-report.md
