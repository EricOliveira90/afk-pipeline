# AFK Pipeline — Product Vision

This is the vision file: the stable, one-page statement of what AFK is,
what it is deliberately not, and the principles every scope decision is
tested against. Consumers: the triage pass (every new GH issue must cite
this file to enter the roadmap), the planner (contract validation), and
the PM reviewer guardian (post-merge review). The roadmap and status live
in `docs/specs/afk-v2-plan.md`; this file changes rarely and only by
recorded decision.

## The vision

**Define the work, walk away, and come back to a verified draft PR — or
to an honest, machine-readable account of exactly why there isn't one.**

AFK is a standalone CLI tool that implements PRD slices end-to-end
without human interaction. Walk-away autonomy only works when the agent
work is trustworthy, and trust stands on two legs:

1. **Evidence.** Every claim in a run is backed by a recorded check —
   and that evidence is spent once, not re-derived by every actor.
2. **Framing.** Every agent session receives a clear objective, the why
   behind it, the relevant context, and the guardrails — only the core
   of each. Current models do their best work when given the complete
   task up front and left to run; over-instruction and micromanaged
   verification add cost, not quality.

## Who it is for

The operator's own projects: `rumo-app` first, then other personal
repositories (including AFK developing itself). **Adoption by others is
out of scope until v2 is complete and stable** — an issue justified by
hypothetical external users fails triage today.

## Success looks like

- A PRD's slices land unattended: contracts negotiated and locked, code
  gated, merged, reviewed by guardians, shipped as a draft PR.
- When the pipeline cannot ship, the operator learns *which* check
  failed and *what state everything was left in* — from the run record,
  not from archaeology.
- A failed or killed run is always resumable; completed work is never
  silently lost or redone.
- The happy path stays fast: hardening pays for itself in the very next
  run or it does not ship.

## Operating principles (the scope filter)

1. **Default is no.** Nothing enters the roadmap without citing this
   file, and the burden of proof is on the proposal. The operator's
   explicit accept is recorded — the operator stays the bottleneck by
   design.
2. **Prefer deletion.** When a mechanism misbehaves, first ask whether
   it should be removed rather than compensated for. Net-new governance
   must name what it retires or simplifies.
3. **Frame, don't micromanage.** Each agent session gets the objective,
   the why, the core context, and the guardrails — nothing more.
   Envelope size is a measured cost.
4. **Nothing adds minutes to the happy path.** Any proposal whose
   recurring cost lands on every slice or round must show measured
   benefit first.
5. **Evidence over argument.** Defaults change because a run produced
   ROI evidence, not because a debate was persuasive. Measurements are
   never gates until proven stable.
6. **Fail closed, record why.** A gate that cannot run refuses rather
   than assumes; every refusal names the check that failed; every
   waiver is recorded text.
7. **New machinery defaults off**, opt-in until run evidence decides
   otherwise, with enable/disable recorded in run evidence.
8. **The pipeline must survive its own tooling.** Pipeline-safety fixes
   are done by hand; anything the pipeline must survive failing does
   not ride the pipeline.
9. **Provider-agnostic at the interface** (ADR 0002). Multiple live
   backends are a hedge against availability and quality swings, not a
   commitment — a backend that costs more to maintain than the hedge is
   worth gets dropped. Deterministic checks live in the orchestrator's
   gate catalog, never in provider-specific hook config.

## The endgame

**v2 complete = feature-complete.** When the seven PRDs of
`afk-v2-plan.md` are done, AFK enters maintenance mode: evidence-driven
fixes only. Every triage decision is tested against "does this get us to
done, or does it move 'done'?"

## What AFK is not

Recorded "no" decisions. Each stays decided unless its re-open trigger
(see plan §6 and `.out-of-scope/`) fires.

- **Not a tool for other users** — until after v2 is complete and stable.
- **Not a durable process supervisor.** No auto-restart of vanished
  processes; the journal and restart evidence are the product.
- **No in-session / per-tool-call hooks.** All six 2026-08-29 hook
  proposals were cut; deterministic checks belong in the gate catalog.
- **No auto-kill of processes AFK did not spawn.** Preflight detects,
  reports, and fails fast; the operator kills foreign processes.
  Teardown of AFK's own spawned processes (quiescing, ADR 0035; sidecar
  sweep, ADR 0058) is unaffected — it was always in scope.
  *(Sharpened 2026-09-08: the original wording overstated the §3 item 7
  cut, which was about foreign processes at launch, and conflicted with
  ADR 0058.)*
- **No agent-certified classification.** Whether a failure is
  environmental or candidate-owned is keyed on structural facts, never
  on an agent's say-so.
- **No merge-gating on agent-eval results.** `afk eval` reports; humans
  and deterministic gates decide merges.
- **No automatic edits to steering or memory files.** Recurring-finding
  proposals are committed as proposals; a human applies them.
- **Not a general CI system, container platform, or sandbox.** Isolation
  is git worktrees; verification is the consuming repo's own scripts.
- **No speculative provider features.** Provider surface grows only when
  a run needs it on a real backend.

## Changing this file

This file is guardian-owned (`pm-review`). Changes require an explicit
recorded decision (ADR or dated plan-debate entry), never an inline edit
during triage or implementation. If a triage pass concludes the vision
itself is wrong, that conclusion is escalated as its own decision — the
issue that prompted it waits.
