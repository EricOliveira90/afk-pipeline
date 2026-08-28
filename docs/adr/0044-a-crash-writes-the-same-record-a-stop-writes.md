# A crash writes the same record a stop writes, with cause CRASHED

Extends ADR 0040 (the cancellation record is written when the signal
fires). Issue #121.

## What happened

AFK run 6 died mid-run when the machine ran out of disk, during slice
#79's QA round 2:

```
[afk] Slice #79: deterministic report classified infrastructure; retrying without consuming round 2
node:events:496
      throw er; // Unhandled 'error' event
Error: ENOSPC: no space left on device, write
Emitted 'error' event on WriteStream instance
```

ADR 0040 exists precisely so that a run which dies mid-wind-down still
leaves a truthful record — and it wrote nothing here, because it hangs off
the `AbortSignal`. An unhandled `'error'` event is not a stop; nothing
aborted; the listener never ran.

So `.afk/state/prd-1.json` still held slice #79's entry from the
**previous run but one**:

```json
"79": {
  "phase": "ERROR",
  "error": "Base gate infrastructure failed: typecheck (.../run-20260827-144209/gates/s05/attempt-11c8af51245d.json)"
}
```

That typecheck failure had been fixed before this run started, and this
run's base gate had passed its `tests` step. The first thing an operator
read after the crash pointed them at a bug that no longer existed. The
slice branch was intact — 12 commits, including the round-1 QA fix — so
nothing was lost except the record, and the record was actively
misleading. **A record naming a stale failure is worse than no record**,
because an empty record invites a look at the branch while a stale one
invites the wrong fix.

## Decision

**1. The three ways a process observes its own death reach the same
bookkeeping.** `uncaughtException`, `unhandledRejection`, and a fatal
`'error'` event on a log stream the pipeline owns all call
`RunJournal.markCancelledInFlight` — the same function a Ctrl-Break
(ADR 0040) and an `afk stop` sentinel (ADR 0043) call — with a distinct
cause instead of `"Cancelled by user"`:

```
CRASHED (uncaughtException): <message>
CRASHED (unhandledRejection): <message>
CRASHED (stream-error: slice-05-generator-r2.log): <message>
```

The message is collapsed to one line and capped at 400 characters,
because it is read out of a JSON field; the stack goes to `run.log` and
the console. The source is named as well as the message: "the disk
refused this log" and "an agent threw" are different diagnoses, and the
record should not make the operator guess which happened.

The persisted **phase stays `CANCELLED`**. A crash is not a new slice
state — the work is on the branch, unmerged, exactly as it is after a
stop, and `CANCELLED` is the phase whose traits already say so
(`branchDisposition: "branch"`, and `--only-failed` reselects it). Adding
a `CRASHED` phase would have forced every reader, resume path and summary
to learn a state that behaves identically to one they already handle.
`CRASHED` is a *cause*, and causes live in the reason text.

**2. Recorded, then fatal.** The handler writes the record, prints the
crash with its stack, and exits non-zero. It does not swallow the crash
and it does not attempt a wind-down: whatever was about to fail is still
failing, and the value here is the record, not a recovery. A crash raised
while recording is dropped — the recorder is the thing that just failed,
and the exit is what still has to happen.

**3. Installed by the CLI, registered by the pipeline.** The handlers end
the process, which is only correct when the run *is* the process, so the
three entry points install them (`installCrashRecorder`) and `runPipeline`
registers what to write, unregistering in its `finally`. In-process
callers — the test suite runs many pipelines per vitest worker — pass no
handle and keep Node's own behaviour. This is the same split as
cancellation: the CLI owns the `AbortController`, the pipeline owns the
record.

The stream half is the same shape. `RunJournal.agentLog` is the single
place agent log streams are created; it attaches an `'error'` listener
**only** when a recorder is registered. Without one, no listener is
attached and an unhandled `'error'` stays process-fatal exactly as it was
— a stream failure must not become a silence just because nobody is
recording it.

## Best-effort, on purpose

The condition most worth recording is the condition that can defeat the
write: under ENOSPC, `saveSliceState` may fail too. That is accepted. A
failed record logs "Could not write the crash record … run state may still
name an earlier failure" and the exit still happens.

Reserved-space machinery — pre-allocating the bytes a crash record needs —
was proposed and rejected: permanent complexity on every run to buy one
write in the one case where the machine is already lost. The backstop is
cheaper and covers more: clearing a slice's stale reason when it is
*dispatched*, so no stale text survives into a later run whether or not
any crash record lands.

## What this does not fix

`taskkill /F`, a power loss, or `SIGKILL` still leave whatever was on disk
at that instant; no in-process design improves on that, and ADR 0040 said
the same. A crash before the run scope resolves records its line and no
slice, which is the truth at that moment. And the record names the crash,
not the run that wrote it — reading a record from the wrong run is the
other half of #121, and run-ID provenance fields on slice-state records
are their own item.
