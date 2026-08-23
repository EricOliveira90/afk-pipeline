# RunJournal owns slice outcome recording

## Failure mode

A terminal slice outcome used to be assembled by convention across the
wave, orchestrator, Logger, run state, run log, and typed event stream.
Failure sites first changed Logger's lifecycle map, the wave often replaced
the real reason with a generic phase label, and the orchestrator reconciled
both copies before writing the remaining artifacts. Retry idempotency lived
in a runPipeline-local set. A missing step or reordered call could leave the
artifacts describing different outcomes.

## Decision

`RunJournal.recordTerminal(sliceId, outcome)` is the only interface for a
current run's terminal slice outcome. The outcome carries its reason once;
the journal constructs the shared `SliceLifecycle` value and projects it to
the in-memory summary, `.afk/state/<run-slug>.json`, `run.log`, and the
unchanged `slice-outcome` event. `MERGE-PENDING` uses the same interface and
keeps its colliding prefixes. Non-terminal tracking rejects terminal phases,
so callers cannot update only the in-memory lifecycle by mistake.

The journal orders a terminal record as follows:

1. synchronously persist the per-slice run state;
2. update the in-memory lifecycle;
3. synchronously append the terminal run-log line and typed event;
4. mark the slice recorded for in-process retry idempotency.

State goes first because it is authoritative for resumption (ADR 0018). If
that write fails, no terminal log or event is emitted and the post-wave
reconciliation retries the same journal call. Once the call completes,
retries produce no duplicate state transition, line, or event. Run-log and
event writes remain best-effort as required by ADR 0017; this is an ordered
multi-artifact operation, not a cross-file transaction.

`RunJournal.phase` also owns paired human and typed phase-transition writes.
Logger is reduced to agent invocation logs and summary rendering; it no
longer exposes lifecycle mutation, terminal wrappers, run-log writes, or
typed-event writes.

## Consequences

Phase B returns a typed outcome with the real reason instead of mutating
Logger and returning a generic string. Wave reporting stays unchanged, and
`events.jsonl` keeps schema version 1 and its existing `SliceLifecycle`
payload. Tests can now exercise cause preservation, write ordering,
`MERGE-PENDING`, failed-write retry, and idempotency directly at the journal
interface.
