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
| CLI entries | Parse options, pick provider, call the orchestrator | `src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` | `src/cli-options.ts`, `src/cli-run-scope.ts`, `src/prompt-recorder.ts` |
| Orchestrator core | Run lifecycle: waves, dispatch, merges, resume | `src/orchestrator.ts` (`runPipeline`) | `src/wave.ts`, `src/resume.ts` |
| Lane partitioner | Pure function: wave → serial lanes by file overlap + resource keys (ADR 0005, 0027) | `src/lanes.ts` | — |
| Agent providers | One interface, three backends (ADR 0002, 0013, 0016) | `src/agent-provider.ts` | `src/claude.ts`, `src/codex.ts`, `src/kiro.ts` |
| Invocation runtime | Bounded process execution, liveness, retries (ADR 0030, 0021, 0022) | `src/invocation-runtime.ts` | `src/command-runtime.ts`, `src/busy-probe.ts`, `src/idle-watcher.ts`, `src/kill-tree.ts`, `src/liveness.ts`, `src/transient-retry.ts` |
| Git operations | Worktrees, branches, atomic merge attempts (ADR 0010) | `src/git.ts` | `src/worktree-processes.ts` |
| Merge resolution | One scoped resolution round for a conflicted wave merge (#132, ADR 0029, 0039) | `src/merge-resolution.ts` | — |
| Run identity | Provider-qualified state, branch, and worktree names (ADR 0002, 0053) | `src/run-identity.ts` | — |
| Run records | Persisted slice state, journal, events, snapshots (ADR 0018, 0031, 0056) | `src/run-state.ts`, `src/run-journal.ts` | `src/file-lock.ts`, `src/adoption-provenance.ts`, `src/run-events.ts`, `src/run-snapshot.ts`, `src/slice-lifecycle.ts`, `src/stage-durations.ts`, `src/exact-stage-resume.ts` |
| Gates | Orchestrator-owned gate execution, declarations, and evidence | `src/gate-runner.ts`, `src/base-gates.ts`, `src/candidate-gate-phase.ts`, `src/post-qa-gates.ts`, `src/scope-gate.ts`, `src/acceptance-gate.ts`, `src/skip-gate.ts`, `src/suppression-gate.ts` | `src/candidate-gate-policy.ts`, `src/migration-gate.ts`, `src/qa-gate-authorization.ts`, `src/gate-cache.ts` |
| Slice selection | Match CLI selectors to slice numbers or issue IDs | `src/slice-selector.ts` | — |
| Review rails | Contract/QA lifecycle, candidate review isolation, accepted-candidate policy (PRD 1, PRD 3, PRD 4) | `src/contract-review.ts`, `src/qa-review.ts`, `src/change-summary.ts` | `src/convergence-coordinator.ts`, `src/accepted-candidate.ts`, `src/contract-convergence.ts`, `src/qa-convergence.ts`, `src/non-progress.ts`, `src/artifacts.ts`, `src/scope-amendment.ts`, `src/slice-scope.ts`, `src/acceptance-manifest.ts` |
| Final evaluation | Exact-tree reuse decision, final review schema, finding routing to the stage that actually wrote, final verdict (PRD 4 D9, D19, D20; PRD 5 D12, #97) | `src/final-evaluation.ts` | — |
| Post-approval quality stages | Bounded post-approval rounds that make declared *clean* gates green without changing approved behavior, re-dispatched with the final evaluator's `RESTORE` findings under the same round budget and reverted whole when none is left; each attempt reported as `quality-stage-attempt` ROI evidence, never as a gate (PRD 5 D2/D4/D10–D12, ADR 0063, #87, #97) | `src/cleaner-orchestration.ts` | `src/cleaner-stage.ts`, `src/suppression-gate.ts`, `prompts/cleaner.md`, `src/run-events.ts` |
| Manifest and claims | `afk.json` scope, migration prefix reservation (ADR 0034) | `src/afk-manifest.ts` | `src/migration-claims.ts` |
| PRD inputs | `issues.md` → DAG; PRD directory reading | `src/issues-parser.ts` | `src/prd-reader.ts`, `src/prd-hold.ts` |
| Ship path | Pre-ship gate, ship gate, terminal handoff (ADR 0033) | `src/ship-gate.ts` | `src/preship.ts`, `src/handoff.ts` |
| Guardian round persistence | The complete persistence invariant for guardian round evidence: persisted shape, normalization, ledger writes (ADR 0057, #221) | `src/guardian-round-persistence.ts`, `src/guardian-round-records.ts` | — |
| Control surface | Status, stop, preflight, cleanup (ADR 0023, 0042, 0043) | `src/status.ts`, `src/stop-command.ts`, `src/preflight.ts`, `src/clean-failed.ts` | `src/status-*.ts`, `src/stop-sentinel.ts`, `src/cancellation.ts`, `src/crash-records.ts` |
| Prompts | Role prompt templates, assembled into per-invocation context envelopes (PRD 3, shipped) | `prompts/*.md` (e.g. `prompts/evaluator-final.md`), `src/prompt-template.ts` | — |
| Agent eval | `afk eval`: replay a scenario pack against a live model, report only — never gates (PRD 7, #262) | `src/eval-command.ts` | `src/eval-pack.ts`, `src/eval-compare.ts`, `src/eval-report.ts` |

## Hubs — do not grow these; extract instead

- `src/orchestrator.ts` — dispatch loop, phase sequencing, merge coordination.
  New behavior goes in a new module with one call site here. Precedent:
  `src/qa-review.ts` and `src/scope-amendment.ts` were extracted, not added.
- `src/wave.ts` — wave composition and lane execution. Same rule.

## Seams — extension points

- `AgentProvider` (`src/agent-provider.ts`) — a new agent backend implements
  this interface; nothing else changes (ADR 0002).
- `GateDeclaration` (`src/gate-runner.ts`) — a new check is a declared gate
  with evidence, not an inline check in the orchestrator. A check the
  orchestrator computes itself supplies `run` instead of `command` (never
  both) and reports through `GateFindings`; `src/scope-gate.ts` and
  `src/skip-gate.ts` are the worked examples. A finding kind is a field on
  `GateFindings`, pinned to the evidence version that introduced it:
  `suppressions` carries `{ path, line, detectorId }` triples from
  `src/suppression-gate.ts` and is evidence version 4 only (#87), so a reader of
  an older artifact never has to guess whether an absent field means "none" or
  "not yet counted".
- Post-approval writing stages (`PostApprovalWritingStage` in
  `src/final-evaluation.ts`) — a stage that runs after the approval commit and
  before the merge takes `{ worktreeDir, stageId, repair? }` and is wired at the
  one accept seam in `src/orchestrator.ts`. The cleaner orchestration session
  (`src/cleaner-orchestration.ts`) owns resume lookup, dispatch, persistence,
  standing state across restores, and its typed terminal decisions; the
  orchestrator retains generator availability, final-evaluation routing and
  slice lifecycle. Its implementation (`src/cleaner-stage.ts`,
  `prompts/cleaner.md`) runs under `gatePolicy.clean`: round 0 gates the accepted
  tree, and each later round dispatches, checkpoints, and gates the clean gates
  **plus the full set the approval rested on**, so a round that reddens any of
  the latter is reverted with `git reset --hard` rather than re-baselined. Every
  exit path resets (ADR 0051) and the loop continues on a comparison against the
  remaining rounds rather than an incremented counter (ADR 0050); a
  `BASELINE_IS_WRONG` escalation returns the slice to the generator with the
  baseline citation invalidated, and exhaustion goes stuck with every still-red
  gate named. A restore round (`repair`) skips round 0 — its input is the
  cleaner's own green output, which round 0 would simply release.
- Gate cost (`gatePolicy.cost` → `resolveTestCostPlan` in `src/base-gates.ts`)
  — a gate's price is declared, not discovered: `expectedCostMs` decides what
  the generator's verification command may contain, `prerequisiteGateIds`
  decides what is worth spawning at all, `environmentSensitive` marks a gate
  that reports and can never block (ADR 0063), and `src/gate-cache.ts` reuses
  a `PASS` for an identical tree. A miss on any path pays the gate; no cache
  path can turn a run redder.
- `laneResourceGroups` (`src/lanes.ts`) — a new contended resource is a
  resource key, not a scheduling special case (ADR 0027).
- Review artifacts (`src/contract-review.ts`, `src/qa-review.ts`) — new
  verdict or finding kinds extend the schema; consumers parse, never regex
  prose.
- Candidate review isolation (`QA_WINDOW_ARTIFACT_NAME` in
  `src/post-qa-gates.ts`, `scanReviewWorktreeWrites` in `src/qa-review.ts`) —
  deterministic QA reads a disposable worktree at the candidate checkpoint, and
  the one artifact-name allowlist is both the copy-back boundary out of it and
  the post-QA window check. A new reviewer output extends that constant; a
  reviewer write it does not admit is discarded and journaled as
  `reviewer-write-violation`, never enforced by prompt prose.
- Change summary (`src/change-summary.ts`) — one builder over
  `(cwd, fromRef, toRef)`; a new evaluator's input is a variant binding those
  two refs, never a second producer. The baseline → final variant
  (`buildFinalChangeSummary`) binds them to the approved baseline and the final
  checkpoint and attributes files per post-approval writing stage.
- Final evaluation (`src/final-evaluation.ts`, `prompts/evaluator-final.md`) —
  reuse is exact tree equality against `approved-baseline.json` with no
  cosmetic exception; a `reuse` dispatches zero evaluator invocations and is
  recorded in run state, run events, and the run summary. An `evaluate` runs a
  bounded `evaluator-final` loop in the orchestrator: each attempt captures the
  post-approval tree, re-runs the scope gate **on that tree** (evidence keyed to
  the accepted candidate authorizes nothing about the tree that replaced it),
  dispatches into a disposable review worktree, and validates the copied-back
  `final-review.json` exactly once — the parsed value is what keys the verdict,
  so validation and verdict cannot describe different documents. Attempts are
  persisted per candidate tree, and only a graded attempt spends the
  `MAX_FINAL_EVALUATION_ATTEMPTS` budget: a `RETURN_TO_GENERATOR` finding
  re-enters the implementation loop and spends a generator round instead (D19).
  A `RESTORE` is routed to the stage that **actually wrote** — the last id
  `buildWritingStageIds` reports — re-dispatched with `repair: { findings }` under
  its own `roundsSpent` budget, whose exhaustion resets its range whole (#97).
- Quality-stage ROI evidence (`quality-stage-attempt` in `src/run-events.ts`,
  `readQualityStageOutcomes` in `src/logger.ts`) — one event per cleaner round and
  final-evaluation attempt carries both trees, timings, gate ids, outcome and
  cache-reused gate ids, pooled per `(ghIssue, stage)` for the summary rows and the
  draft PR alike; a measured stage adds an event, never a gate (ADR 0063, D10–D11).
- Merge resolution (`resolveMergeConflict` in `src/wave.ts`, body in
  `src/merge-resolution.ts`) — a real textual conflict spends one scoped round
  in the slice's own worktree, inside the merge mutex the refused attempt
  already holds: the round re-runs the slice's own required declarations on the
  resolution commit's tree and refuses the retry if a conflicted path still
  carries a marker. Unset — every caller outside the orchestrator — a conflict
  is terminal as before; a failed round keeps the resolution commit (ADR 0039),
  leaves the feature tip unmoved and records the same terminal `CONFLICT`.
- Guardian round persistence (`GuardianRoundPersistence` in
  `src/guardian-round-persistence.ts`) — the ship gate decides *when* a round
  reaches disk, including on every failure exit; the adapter decides *how*
  (normalization, append-only rounds against replace-wholesale caches,
  filed-findings carry-forward, filed-finding identity dedup). A new guardian
  persistence rule extends the adapter, never the sequencer or `run-state.ts`;
  ADR 0057's guardian-round lifecycle consumes the adapter as a collaborator.
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
