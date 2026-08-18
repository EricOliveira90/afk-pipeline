# Per-run log directories and an orchestrator-owned run.log

## Failure modes

During a babysat run (pin 8cd531e, Windows), two observability defects
made a real hang indistinguishable from normal slow progress:

1. **Cross-run log appending.** `Logger.agentLog` opened
   `.afk/logs/<prd-slug>/slice-*.log` with `{ flags: "a" }`. Re-running
   the same PRD appended run 3's output into run 2's files, so a stale
   log looked live and a live log looked stale — `slice-07-generator-r1.log`
   showed the prior run's 94,400 bytes and mtime for 20+ minutes while
   the current run's generator was writing into the same file.
2. **Phase lines lost with launcher stdio.** Every `[afk]` phase
   transition went only to `console.error`. Launched as
   `pnpm exec afk ... > run.log 2>&1` on Windows, that stream was lost
   (empty file across three runs), so phase transitions were
   unobservable from outside the process. The only liveness signals an
   operator had were worktree mtimes and per-process CPU deltas.

A third gap compounded them: a slice whose `contract.md` sat at
`**Status:** NEGOTIATING` with no running evaluator was ambiguous — it
could be a dropped negotiation (evaluator exited without a verdict) or
a lane successor legitimately waiting to re-negotiate after its
predecessor merges. Neither state produced any distinguishing signal.

## Decision 1 — one directory per run

Each `Logger` (one per pipeline run) creates
`.afk/logs/<prd-slug>/run-<yyyyMMdd-HHmmss>/` and writes all agent
invocation logs there. A numeric suffix disambiguates same-second
starts. A log file's mtime and size now always describe the run that
owns the directory.

- **Append mode stays** for agent logs *within* a run: a lane successor
  legitimately reopens the same filenames (explorer, planner rounds)
  after its refresh, and that history must not be truncated. Truncation
  on open was rejected for exactly this reason; cross-run appending is
  impossible now that runs don't share files.
- `run-summary.md` keeps its stable path
  (`.afk/logs/<prd-slug>/run-summary.md`, overwritten per run — the
  existing consumer contract) and gains a per-run archive copy inside
  the run directory.

## Decision 2 — orchestrator-owned run.log

`Logger.phase(message, via?)` appends `[ISO-timestamp] message` to
`<runDir>/run.log` **synchronously** (`appendFileSync`, no buffered
stream — freshness is the point) and echoes to the console stream the
call previously used. All `[afk]` phase transitions in
`orchestrator.ts` and `wave.ts` now route through it; the first line of
every run names the run directory, giving `tail` a target from second
zero. File writes are best-effort: logging failure never takes down the
pipeline.

Timestamps in the file (absent from the old console lines) also give
operators "time since last transition" for free.

## Decision 3 — negotiation and lane states are explicit

New phase lines close the NEGOTIATING ambiguity regardless of cause:

- After every contract-review round: `contract verdict
  <ACCEPT|REVISE|ESCALATE|UNKNOWN> (round n/m)` — UNKNOWN is annotated
  as "evaluator produced no parseable verdict" instead of silently
  looping.
- Terminal negotiation states: `contract LOCKED`, and a previously
  silent path now logs `STUCK — contract not locked after negotiation
  (last verdict: …, round …)`.
- Lane queueing: when lanes are partitioned, every successor logs
  `queued behind #<pred> in its lane — waiting to re-negotiate on the
  refreshed base after the predecessor merges (not dropped)`.
- Every per-slice wave outcome (PASS / STUCK / ESCALATE / ERROR /
  CONFLICT / CANCELLED / LANE-CANCELLED) writes a timestamped line with
  its error reason when it is persisted.

## What stays untouched

- `handoff.json`, run-state persistence, and the stable
  `run-summary.md` path — existing consumer contracts.
- Console output shape: `phase` echoes to the same `console.error` /
  `console.log` / `console.warn` stream each line used before.
- Agent-log filenames (`slice-<n>-<agent>[-r<round>].log`) — only their
  parent directory moved.
- The one `console.error` inside `verifyMigrationSync`'s local-stack
  helper — a standalone exported utility without a `Logger`, not a
  phase transition.
