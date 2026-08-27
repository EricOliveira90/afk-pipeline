# The cancellation record is written when the signal fires, and Windows needs SIGBREAK

Amends ADR 0003 (cancellation via `AbortSignal`). Issue #114.

## What happened

Stopping a live run on Windows (codex provider, orchestrator node PID
under a `cmd.exe` wrapper) took three attempts:

1. `CTRL_C_EVENT` to the node PID — the API reported success, the run
   continued.
2. `CTRL_C_EVENT` to the parent console — reported success, run
   continued.
3. `CTRL_BREAK_EVENT` — node exited.

That exit bypassed ADR 0003 entirely: no stop line in `run.log`, and the
slice that was mid-generator got **no run-state entry at all**. An
unmerged slice branch with no state is indistinguishable from a slice
that never ran, which is how `--only-failed` came to destroy five
commits' worth of work (#113).

## The two findings, measured

Reproduced locally on Windows 11 with a Node child that registers
`SIGINT`, `SIGBREAK`, `SIGTERM` and `SIGHUP`, and a sender that attaches
to the child's console and calls `GenerateConsoleCtrlEvent`:

- `CTRL_C_EVENT`: the call returns `TRUE`, and **nothing is delivered**.
  A sender that only checks the return value reports success either way.
  Windows disables Ctrl-C for a process group created with
  `CREATE_NEW_PROCESS_GROUP` — which is what libuv gives a
  `detached: true` spawn, i.e. how a babysat run is launched — and no
  amount of handler registration in the target changes that.
- `CTRL_BREAK_EVENT`: delivered, and Node surfaces it as `SIGBREAK`.

So the first defect was not "the handler missed the event". The event
never arrived. The signal that *does* arrive had no listener, so Node
took the default action for an unhandled signal: terminate.

## Decision

**1. Every stop signal reaches the same abort path.** The three CLI entry
points share `src/cancellation.ts`, which registers `SIGINT` + `SIGBREAK`
on Windows and `SIGINT` + `SIGTERM` + `SIGHUP` on POSIX. `SIGBREAK` is
Windows-only because on POSIX the name is not a signal at all —
registering it there would create a plain event listener that never
fires. `SIGTERM`/`SIGHUP` are POSIX-only for the mirror-image reason:
Windows never delivers them (a `taskkill /F` is an unconditional
`TerminateProcess`, which no handler can intercept).

The documented way to stop a Windows run is therefore **Ctrl-Break** in
the console, or `CTRL_BREAK_EVENT` to its console group. Ctrl-C still
works for a plain foreground launch; it cannot be made to work for a
detached one, so it is not the documented answer.

**2. The record is contemporaneous with the request, not the wind-down.**
`runPipeline` registers a listener on the `AbortSignal` that immediately —
synchronously, inside the listener — writes a `CANCELLED` run-state entry
for every slice with no decided outcome, and a stop line to `run.log`
naming them (`RunJournal.markCancelledInFlight`). The wave loop's
existing cancellation sweep still runs and still closes those slices
through the journal; it is no longer the *only* thing that records them.

This is the half that matters, and it is why the entry points can still
exit hard on a second signal: by then the record is already on disk. The
alternative — make the wind-down reliable enough to be trusted — is not
available. An agent process that will not die, a console close, or an
operator pressing the stop twice all end the process at a moment the
pipeline does not control.

**Provisional, deliberately.** The abort-time record does not close the
slice in the journal, so an outcome that genuinely lands during the
wind-down (a merge that was already in flight) overwrites it. The
ordering guarantee is one-directional: state is never *empty* for an
in-flight slice after a stop, and never *stale* if the truth arrives
later.

## What this does not fix

A stop delivered before the run scope is resolved (the first seconds of
git setup) records the stop line but has no slice to mark — correctly, as
nothing has been dispatched. And `taskkill /F`, a power loss, or a
`SIGKILL` still leave whatever was on disk at that instant; no in-process
design can improve on that. The narrowing is that the window is now
"between the signal and its listener" rather than "between the signal and
the end of the wind-down", which was minutes wide.
