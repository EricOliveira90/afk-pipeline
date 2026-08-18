# Kills are tree-first, verified, and never trusted blindly on Windows

**Date:** 2026-08-09

## Context

Every kill path in the providers — the agent fail-open tripwire, the
idle-timeout watcher, the wall-clock ceiling, the tool-call cap, and
cancellation — shared one mechanism: `proc.kill("SIGTERM")`, then a
10-second `unref`'d timer that ran `killProcessTree` (`taskkill /PID
<pid> /T /F` on win32) only if the child had not exited yet.

On Windows that mechanism could not work, for three stacked reasons
observed in a babysat PRD 066 run (kiro-cli 2.16.2):

1. **Node's "SIGTERM" on Windows is `TerminateProcess` of the direct
   child only.** The direct child of `spawn("kiro-cli", ...)` is the
   Toolbox shim (`Toolbox\bin\kiro-cli.exe`), which spawns the real
   versioned CLI as a grandchild (`claude`/`codex` are wrapped by
   `cmd.exe` via `shell: true` — same shape). The shim dies instantly;
   the real agent tree survives, orphaned.
2. **The force-kill timer then disarms itself.** The shim's death fires
   `exit`, the promise settles, and the timer's `proc.exitCode ===
   null` check is false — `taskkill /T` never runs. Even if it had run,
   the tree root was already dead, and `taskkill /T` cannot enumerate
   the children of a dead PID.
3. **The orphans keep the inherited stdio pipe ends open**, so the
   orchestrator's event loop has live handles after the run and the
   process can wedge at exit.

Concretely: a guardian review killed by the tripwire (agent config
fail-open, ADR 0016) kept running as the unrestricted default agent and
wrote review files into the feature worktree 12+ minutes after AFK had
recorded `NEVER_RAN` and written `run-summary.md`; killing it by hand
took `taskkill /PID <pid> /T /F` over a ~20-process tree. An earlier
idle-timeout kill in the same PRD behaved identically. The orchestrator
process itself was still alive 19 minutes after writing the summary.

## Decision

`src/kill-tree.ts` becomes an async, verifying terminator —
`terminateProcessTree(proc)` — and every kill path routes through it.

1. **Tree-first, while the root is alive.** On win32 the kill is
   `taskkill /PID <root> /T /F` immediately — no SIGTERM, no grace.
   There is nothing graceful to preserve: Node's "SIGTERM" there is
   already an ungraceful hard kill, just of the wrong process. POSIX
   keeps SIGTERM → 10 s grace → SIGKILL, with a plain (ref'd) timer; a
   kill in progress is exactly when keeping the event loop alive is
   correct. Nothing relies on an `unref`'d timer firing anymore.
2. **Snapshot, then verify.** Before killing, the tree is enumerated
   from a `(pid, ppid)` table (PowerShell CIM — `wmic` is removed from
   current Windows, `tasklist` is localized). After killing, the table
   is polled until the union of the snapshot and a fresh BFS from the
   root is gone. Windows never rewrites an orphan's recorded parent
   PID, so the BFS stays navigable even after the root dies — this is
   what makes verification (and straggler cleanup, one `taskkill /F`
   per survivor) possible. The result is a `TerminationReport
   { rootDead, survivors, verified }`.
3. **No terminal outcome while the tree may be alive.** Provider
   promises no longer settle on `exit` alone. When a kill was issued,
   settlement waits for the termination report; survivors (or a failed
   verification) are appended to the rejection message — `WARNING: N
   process(es) survived the kill (PIDs ...)` — and written to the
   invocation log, so the state file, run.log and console all name the
   PIDs an operator must act on.
4. **No hang awaiting a child that will not die.** If even the root
   survives every attempt, `exit` never fires — the invocation settles
   (rejects) from the termination report instead. Kill paths also
   destroy our ends of the child's stdio and `unref` the handle, so a
   surviving orphan cannot hold the orchestrator's event loop open. As
   a last-resort backstop the CLIs arm an `unref`'d 2 s force-exit
   timer after printing the final success message: a clean loop exits
   naturally before it fires; only a wedged loop ever reaches it (this
   backstop is belt-and-braces, not the mechanism — settlement never
   depends on it).
5. **`runHeartbeatCommand` gets the same guarantees** for QA/sanity
   commands: verified tree kill, survivor warnings via `onOutput`, and
   settlement from the report when the root will not die.

## Verification

Beyond the unit suite (fake process tables) and a real-process
integration test (parent + grandchild, win32-gated), the fix was
exercised against the real CLI on Windows: `kiro-cli chat` spawned the
production tree shape — Toolbox shim → versioned kiro-cli → 21
processes including MCP servers — and `terminateProcessTree` reported
`{ rootDead: true, survivors: [], verified: true }`, confirmed by an
independent `process.kill(pid, 0)` liveness probe over every pre-kill
PID: all 21 dead, `exit` observed on the root.

## Consequences

- Killed kiro/claude/codex invocations on Windows now take the whole
  shim → CLI → worker tree down, and AFK only records the outcome after
  confirming it — the "zombie guardian writes into the worktree after
  NEVER_RAN" class of failure is closed, or at minimum loudly named.
- A kill now costs a few PowerShell process-table listings (measured
  ~4 s total against the real CLI, up to ~15 s on a loaded machine).
  Kills are rare and already terminal for the invocation, so the
  latency is irrelevant.
- Verification is best-effort by PID: PID reuse inside the ~5 s
  confirmation window can mislabel an unrelated process as a survivor
  (warning noise, never a wrong kill of an unrelated PID — only
  snapshot/BFS members are ever force-killed, and `taskkill` carries
  the same inherent caveat).
- If PowerShell is unavailable the report says `verified: false` and
  the warning states that termination could not be confirmed — AFK
  still never claims a clean kill it cannot prove.
- Providers reject with the kill reason plus the survivor warning in
  one message; orchestrator state persistence (ADR 0018/0019) carries
  it into `state.json` and `run.log` unchanged.
