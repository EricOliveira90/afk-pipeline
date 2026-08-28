# A stop is delivered as a file the run polls for, not only as a signal

Amends ADR 0040 (the cancellation record is written when the signal
fires) and ADR 0003 (cancellation via `AbortSignal`). Evidence:
`docs/specs/afk-v2-recovery-plan.md`, Run 3, "CTRL_C into a detached run
is unreliable"; both debaters in `docs/specs/afk-v2-plan-debate.md`
proposed this independently from that evidence.

## What happened

ADR 0040 fixed what happened *after* a stop arrived: every stop signal
reaches one abort path, and the CANCELLED run-state records are written
synchronously inside the abort listener rather than during the wind-down.
It could not fix whether the stop arrived at all. Stopping the Run 3
orchestrator took three attempts:

1. `AttachConsole` + `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` at the
   node PID — **reported success**, run kept going.
2. The same, aimed at the parent console — **reported success**, run kept
   going.
3. `CTRL_BREAK_EVENT` at the parent `cmd.exe` console group — delivered,
   and the orchestrator exited **without writing a cancellation record**,
   leaving slice #76 unrecorded in run state. That gap is what let a
   later `--only-failed` destroy five commits of work (#113).

Two distinct defects, and ADR 0040 only closed the second. The first is
not a bug AFK can fix: Windows disables Ctrl-C for a process group
created with `CREATE_NEW_PROCESS_GROUP`, which is exactly what a
`detached: true` spawn — a babysat run — gets, and the API returns `TRUE`
either way. An operator following the documented procedure could send two
stops, be told both succeeded, and watch the run continue.

## Decision

**A stop can also be delivered as a file, and the run polls for it.**

`afk stop [<prd-slug>]` writes `<runDir>/stop.request`. The orchestrator
checks for that file on a timer while the run is alive, and a request
that names this run goes straight into `cancellation.requestStop()` — the
CLI's own stop button, the same `AbortController`, the same abort
listener, the same escalation counter. Nothing about cancellation
semantics is new: ADR 0040's CANCELLED records fire exactly as they do
for Ctrl-Break, because they *are* the same code path. Only the delivery
differs, and a file needs no console, no process group and no PID.

### The sentinel is namespaced by run, structurally

`runDir` is the per-run log directory (`.afk/logs/<run-slug>/run-<timestamp>/`,
ADR 0017), so the run directory's name **is** the run ID and the sentinel
path is unique per run by construction. A sentinel left behind by a
crashed `afk stop` names a directory no future run will ever be handed —
`runDirNameFor` never reuses a name — so a stale sentinel cannot abort
the next launch. That property comes from the layout rather than from a
check that could be wrong, which is the point: the failure this whole
item exists to prevent is a stop that lands where nobody expected it.

Two cheap belts on top of the structural guarantee:

- The file records the run ID it was written for, and a poller ignores a
  request naming a different run. This only matters for a hand-copied or
  hand-edited run directory — precisely when the structural guarantee
  stops being one.
- Every run clears its own directory's `stop.request` and `stop.ack` at
  launch, so "no live poller ever sees a stale request" holds
  unconditionally instead of resting on directory-name uniqueness. It
  should always find nothing; if it finds something, it says so in
  `run.log` rather than deleting silently.

Sweeping other runs' directories is deliberately absent. Nothing polls a
finished run's directory, so those files are inert, and preflight
housekeeping is a separate job with its own scope.

### The acknowledgement is the part that makes this better than a signal

Writing a file is not an improvement on its own — it is just as easy to
write a file nobody reads, and that is the same failure as an API that
returns `TRUE` without delivering. So the run writes
`<runDir>/stop.ack` **after** the abort path returns, which is after the
abort listener has synchronously written the CANCELLED records. The ack
therefore carries a real guarantee, and `afk stop` reports it: exit 0
means the bookkeeping the old stop mechanism lost is already on disk, and
the command names the slices it covers. Exit 1 means the sentinel is in
place and unacknowledged — also a true answer, and one no previous stop
mechanism could give.

### Costs and the accepted limitation

One `existsSync` every two seconds, and a `readFileSync` only on the tick
that finds something. Two seconds is chosen against what the operator is
waiting for; the poll is on a timer rather than at wave boundaries
because a wave can run for hours and mid-wave is exactly when a stop is
wanted.

The timer is unref'd and never a reason to keep the event loop alive.
The flip side is the limitation, accepted knowingly: **a wedged event
loop never runs the tick.** A sentinel cannot stop a run whose loop is
blocked, and the fallback there is what it is today — Ctrl-Break, then a
hard kill, with whatever is on disk at that instant. This is strictly
better than the status quo rather than a complete answer, and no
in-process design can be a complete answer.

## What this does not change

`taskkill /F`, power loss and `SIGKILL` still leave whatever is on disk,
unchanged from ADR 0040. Ctrl-Break remains fully supported and stays the
documented in-console stop; `afk stop` is the answer for a run whose
console you are not sitting at, which is every babysat run.
