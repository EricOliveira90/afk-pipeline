# Busy-probe deferral requires an open command, not just a descendant

Narrows ADR 0021, which deferred the idle kill on the existence of any
live spawned descendant. ADR 0037's role scoping is unchanged.

## Failure mode

Issue #182, twice in the guardian-convergence self-run series, ~80
minutes lost each time.

Run 9 (`run-20260906-125932`), slice #170 generator: the invocation sat
silent for 64 minutes logging `generator silent for 600s but 3 spawned
process(es) still running — deferring idle kill`. The three processes
were a `codex.exe credential-process` sidecar chain. No pnpm, vitest or
node child existed.

Run `20260906-182053`, slice #172 generator round 2: 100.6 min wall
clock, of which **80.2 min was dead air**. `pnpm typecheck &&
pnpm test:fast` completed at 22:06:08Z; the next stream event arrived
~23:26:20Z. Across that gap the probe deferred the 600 s idle kill eight
consecutive times. The three surviving processes were orphaned
vitest/node workers left over from the suite that had just finished.

Two unrelated orphan families, the same cost. ADR 0021's probe counts
live descendants; it never asked whether any of them was doing work.
The 120-minute wall-clock ceiling became the only backstop, so a stalled
generator cost up to two hours instead of ten minutes.

## Rejected: gate on CPU activity

The obvious reading of both incidents is that the deferring processes sat
at ~0% CPU, so requiring CPU consumption before deferring would catch
both. It would also destroy the case the probe exists for.

ADR 0021 was written for **I/O-bound** work: a test suite waiting on
disk, a serialized suite against a remote preview DB, a network fetch.
Those legitimately sit near 0% CPU while making real progress — that is
what "silent but working" *means* in the PRD 075 incident that motivated
the probe (slices 05 and 09 killed mid-`vitest` at "idle for 19
minutes"). A CPU gate would kill exactly those invocations. It trades one
failure for the worse one it replaced.

A process-name allowlist was also rejected: it catches run 9's credential
sidecars (ADR 0058 already enumerates them) and misses run 172's vitest
workers entirely. Two unrelated families in two occurrences is evidence
that the process identity is the wrong axis.

## Decision — defer only while a command is open

The idle kill is deferred when **both** hold:

1. the busy probe reports a live descendant outside its baseline
   (ADR 0021's condition, unchanged), **and**
2. the provider reports a command/tool execution **currently open** —
   its start record seen, its completion record not yet.

Once the command completes, surviving orphans can no longer hold the
invocation alive: the next idle window kills it. This is decisive rather
than heuristic — no allowlist, no CPU sampling, no guess about what a
descendant is for.

The lifecycle state already existed and is not new bookkeeping.
`createCommandTimeTracker` (`src/invocation-runtime.ts`) already keeps a
`Set` of open execution ids to attribute `nonCommandTimeMs`; it gains one
accessor, `hasOpenCommand()`, reading that set. Unlike `totalMs()` it is
deliberately **not** affected by `markUnattributable()`: a stream whose
durations cannot be summed can still say truthfully whether a bracket is
open.

`PreparedInvocation` gains `isCommandOpen?: () => boolean`, and the
AND lives at the probe call site in the shared runtime. `src/busy-probe.ts`
and `src/idle-watcher.ts` are untouched, so ADR 0021's generation-counter
invalidation still discards any decision that a `reset()`/`stop()`
supersedes — which is also what protects the two races the narrower
predicate creates (a command completing, or starting, while the async
probe is in flight: both arrive as stdout, both reset the watcher).

## Per-provider reach

- **codex** — `command_execution` items, `item.started` → `item.completed`,
  correlated by item id. Exactly "a shell command is running".
- **claude-code** — an equivalent lifecycle already parsed:
  `tool_use.id` → `tool_result.tool_use_id`, read from both `assistant`
  and `user` stream records. It brackets *every* tool, not only Bash, so
  its "open" window is wider than codex's. That is the safe direction:
  deferral still also requires a live descendant, and non-shell tools
  complete in milliseconds.
- **kiro** — no structured stream at all (ADR 0004), so no lifecycle to
  report. It omits `isCommandOpen`, and the runtime treats an absent
  signal as ADR 0021's descendant-only rule. Kiro's behaviour is
  therefore **unchanged**, deliberately: kiro generator and evaluator-qa
  do opt into deferral (ADR 0037 scopes by role, not provider), and
  making "no signal" mean "kill" would reintroduce the PRD 075 regression
  ADR 0021 was written to prevent. Issue #182's hole stays open for kiro;
  closing it needs a lifecycle signal kiro does not have.

## What this bounds, and what it does not

It bounds both observed occurrences. Run 9 had no command open at all.
Run 172's command had completed. Both now die at the 600 s idle timeout.

It does **not** bound the case where a start record arrives and its
completion record never does — an execution bracket left open by a stream
that died mid-command. `open` stays non-empty, condition 2 stays true,
and deferral continues to the wall-clock ceiling.

That residue is deliberate, not an oversight. An open bracket with a live
descendant is indistinguishable from a genuinely long I/O-bound command,
which is precisely what ADR 0021 defers for; killing there is the PRD 075
regression again. ADR 0021 already assigns that class to the ceiling:
"a spawned process that is itself hung … defers idle kills but cannot
defer the ADR 0016/0019 ceiling". Capping deferrals per unchanged
execution id would be the kind of heuristic this ADR rejects above.

## Observability shipped alongside

Neither of these bounds the loss; both were discarding evidence while the
incidents happened.

- The idle-warning callback reported a **tick count** that
  `Logger.writeIdleWarning` printed as minutes. The interval is 30 s, so
  the 80-minute gap logged as "idle for 161 minutes".
  `IdleWatcherOptions.onWarning` / `InvokeOptions.onIdleWarning` now carry
  elapsed silent **seconds** and the logger formats from that.
- `codex exec --json` was spawned with no `RUST_LOG`. Codex logs its own
  stream retries ("Reconnecting… 1/5") at WARN and defaults to ERROR, so
  the provider's record of a stall was thrown away as it was produced —
  33 ERROR lines and zero WARN across all 18 logs of run 172. The spawn
  now sets `RUST_LOG=codex_core=warn`; an operator `RUST_LOG` still wins.
- The kill side of the new rule logs why it killed: *"silent for 600s
  with 3 leftover process(es) but no command running — killing as idle"*.
  Without it the fix is invisible in a log and a recurrence needs a
  manual process-tree dump, which is what run 9 took to diagnose.
