# Architecture

AFK is a standalone CLI that orchestrates multi-agent pipelines to implement
PRD slices autonomously: explorer → planner ⇄ contract evaluator → generator ⇄
QA evaluator, per slice, in parallel lanes, merging to a feature branch behind
deterministic gates.

Readers: the explorer and planner receive this file in their envelopes (plan
§3c policy 3); ticket authors read Hubs when applying the seam-slice rule.
Every path here must exist; every hub must have a matching `resourceKeys`
entry in `afk.config.json`. Cap: 150 lines.

## Modules

| Module | Purpose (one line) | Public seam (import this) | Internals (do not import) |
|---|---|---|---|
| CLI entries | Parse options, pick provider, call the orchestrator | `src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` | `src/cli-options.ts`, `src/cli-run-scope.ts` |
| Orchestrator core | Run lifecycle: waves, dispatch, merges, resume | `src/orchestrator.ts` (`runPipeline`) | `src/wave.ts`, `src/resume.ts` |
| Lane partitioner | Pure function: wave → serial lanes by file overlap + resource keys (ADR 0005, 0027) | `src/lanes.ts` | — |
| Agent providers | One interface, three backends (ADR 0002, 0013, 0016) | `src/agent-provider.ts` | `src/claude.ts`, `src/codex.ts`, `src/kiro.ts` |
| Invocation runtime | Bounded process execution, liveness, retries (ADR 0030, 0021, 0022) | `src/invocation-runtime.ts` | `src/command-runtime.ts`, `src/busy-probe.ts`, `src/idle-watcher.ts`, `src/kill-tree.ts`, `src/liveness.ts`, `src/transient-retry.ts` |
| Git operations | Worktrees, branches, atomic merge attempts (ADR 0010) | `src/git.ts` | `src/worktree-processes.ts` |
| Run records | Persisted slice state, journal, events, snapshots (ADR 0018, 0031) | `src/run-state.ts`, `src/run-journal.ts` | `src/run-events.ts`, `src/run-snapshot.ts`, `src/slice-lifecycle.ts`, `src/stage-durations.ts`, `src/exact-stage-resume.ts` |
| Gates | Orchestrator-owned gate execution and evidence | `src/gate-runner.ts` | `src/migration-gate.ts`, `src/qa-gate-authorization.ts` |
| Review rails | Contract/QA lifecycle and accepted-candidate policy (PRD 1, PRD 3) | `src/contract-review.ts`, `src/qa-review.ts` | `src/convergence-coordinator.ts`, `src/accepted-candidate.ts`, `src/contract-convergence.ts`, `src/qa-convergence.ts`, `src/non-progress.ts`, `src/artifacts.ts`, `src/scope-amendment.ts`, `src/slice-scope.ts`, `src/acceptance-manifest.ts` |
| Manifest and claims | `afk.json` scope, migration prefix reservation (ADR 0034) | `src/afk-manifest.ts` | `src/migration-claims.ts` |
| PRD inputs | `issues.md` → DAG; PRD directory reading | `src/issues-parser.ts` | `src/prd-reader.ts`, `src/prd-hold.ts` |
| Ship path | Pre-ship gate, ship gate, terminal handoff (ADR 0033) | `src/ship-gate.ts` | `src/preship.ts`, `src/handoff.ts` |
| Control surface | Status, stop, preflight, cleanup (ADR 0023, 0042, 0043) | `src/status.ts`, `src/stop-command.ts`, `src/preflight.ts`, `src/clean-failed.ts` | `src/status-*.ts`, `src/stop-sentinel.ts`, `src/cancellation.ts`, `src/crash-records.ts` |
| Prompts | Role prompt templates, interpolated per invocation | `prompts/*.md`, `src/prompt-template.ts` | PRD 3 replaces raw templates with assembled envelopes |

## Hubs — do not grow these; extract instead

- `src/orchestrator.ts` — dispatch loop, phase sequencing, merge coordination.
  New behavior goes in a new module with one call site here. Precedent:
  `src/qa-review.ts` and `src/scope-amendment.ts` were extracted, not added.
- `src/wave.ts` — wave composition and lane execution. Same rule.

## Seams — extension points

- `AgentProvider` (`src/agent-provider.ts`) — a new agent backend implements
  this interface; nothing else changes (ADR 0002).
- `GateDeclaration` (`src/gate-runner.ts`) — a new check is a declared gate
  with evidence, not an inline check in the orchestrator.
- `laneResourceGroups` (`src/lanes.ts`) — a new contended resource is a
  resource key, not a scheduling special case (ADR 0027).
- Review artifacts (`src/contract-review.ts`, `src/qa-review.ts`) — new
  verdict or finding kinds extend the schema; consumers parse, never regex
  prose.
- Review lifecycle (`src/convergence-coordinator.ts`,
  `src/accepted-candidate.ts`) — the orchestrator sequences typed outcomes;
  these modules own validation, continuation, cap, resume, and terminal policy.

## Placement rules

- A new deterministic check is a gate in the catalog, never prompt prose
  (plan: "deterministic gates, not added prompt prose").
- A new persisted fact extends `src/run-state.ts`'s schema with a version
  bump and a reader; a record no reader checks is decoration.
- A new agent obligation lands in a prompt template only if no gate can
  enforce it.
- Anything two slices could contend for gets a resource key in
  `afk.config.json` before it gets a workaround.
- Tests: prefer a unit test, then an existing spawned scenario, then a new
  slice in an existing wave fixture — a new spawned scenario is last resort
  (see `AGENTS.md`).
