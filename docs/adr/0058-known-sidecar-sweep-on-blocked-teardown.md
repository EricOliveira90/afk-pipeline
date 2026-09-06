# 0058. Blocked worktree teardown sweeps known detached sidecars by name

Date: 2026-09-06
Status: Accepted
Issue: #166 (same root cause tracked in #146)

## Context

Every codex invocation may spawn the Toolbox wrapper's machine-wide OTel
collector supervisor: `codex.exe __otel-server`, which itself spawns
`otelcol-contrib`. The supervisor is a lock-file singleton spawned
deliberately detached (`CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS |
CREATE_BREAKAWAY_FROM_JOB` on Windows) and it inherits the cwd of the
invocation that won the spawn race. Guardian reviews run codex inside the
review worktree, so the pair regularly ends up holding that directory as
its working directory — an open handle on Windows — long after the review
settles. Observed 8+ times across the PRD 3 run: every subsequent launch
failed to remove or recreate the worktree (EBUSY / "Directory not empty")
until the pair was killed by hand.

Every existing defense is structurally blind to this shape:

- **ADR 0020 tree kill / ADR 0035 quiesce** walk (pid → ppid) edges from
  AFK's own spawn roots. On a *natural* exit nothing walks the tree at
  all, and by teardown time the wrapper chain between root and sidecar is
  dead — a BFS has no bridge to a breakaway process whose recorded parent
  is gone.
- **The preflight holder scan** reads executable paths and command lines
  only. The sidecar's argv names no worktree path; `Win32_Process`
  exposes no working directory. `src/preflight.ts` already prints this
  exact caveat.

Options considered:

1. **Disable the sidecar at spawn.** The wrapper (internal `OpenAICodex`
   package) exposes no config knob, env var, or flag to suppress the
   collector; `spawn_collector()` runs unconditionally. Nothing to turn
   off.
2. **Pre-spawn the singleton from a neutral cwd** so the lock is already
   held by a harmless owner. Fragile: depends on wrapper-internal lock
   semantics and lifecycle we do not control, and a wrapper update that
   recycles the server (it kills stale-versioned servers) re-breaks it
   silently.
3. **Kill the pair by name at teardown.** The only shape-stable seam we
   own.

## Decision

When a worktree removal attempt survives (the directory still exists
after an `rmSync` pass and the failure is transient — EBUSY-family — not
fatal), `removeWorktree` runs a **one-time, machine-wide sweep of known
detached sidecars** (`src/worktree-sidecars.ts`): every process whose
argv contains `__otel-server` or whose image name is `otelcol-contrib`
is tree-killed via the ADR 0020 terminate-and-confirm path, then the
bounded rm retry loop continues.

The sweep is machine-wide by necessity — no listing available to us can
attribute a cwd to a directory — and safe by construction:

- It runs only after a removal has actually stalled; an idle machine and
  the common clean-teardown path never pay for it.
- The pair is a telemetry-only singleton that the next codex invocation
  respawns on demand. The blast radius of a kill is one lost telemetry
  batch, never lost work.
- Kills go through `terminatePidTree`, so they are confirmed against the
  process table, not assumed.

The sweep outcome travels on `RemoveWorktreeResult.sidecars` and is
rendered by the two prose sites (`formatWorktreeSurvivorWarning`,
`WorktreeBusyError`), so a *still*-blocked removal now names the
processes it found and what became of them, instead of "something is
still holding handles inside it".

## Consequences

- A codex guardian review no longer poisons the next launch: the first
  blocked teardown kills the pair and the removal proceeds.
- One review can re-orphan a fresh pair *after* teardown (any later codex
  invocation elsewhere respawns the singleton with its own cwd). The
  sweep is therefore a standing teardown behavior, not a one-shot
  migration.
- An operator's interactive codex session on the same machine loses its
  collector when a blocked teardown fires; it respawns on that session's
  next invocation. Accepted trade-off, documented here.
- If the wrapper ever renames the subcommand or the collector binary, the
  sweep goes quiet (matches nothing) rather than killing wrong processes;
  the EBUSY then surfaces with the sweep's "found nothing" evidence in
  the warning, pointing straight back at this ADR.
