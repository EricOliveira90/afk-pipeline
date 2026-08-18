# Busy probe: defer idle kills while a spawned process is still running

## Failure mode

The idle watcher judges liveness by output. Generators routinely run a
project's test suite with piped output (`… | Select-Object -Last N`), so
a legitimately long-running suite produces zero stdout until it
completes — indistinguishable, to an output-based watchdog, from a
wedged session.

In the PRD 075 babysit run (Kiro backend), this was a guaranteed kill:
slices 05 and 09 were killed at "generator idle for 19 minutes" while
`vitest run …integration.test.ts` (4 000+ lines, serialized against a
remote preview DB, 20–40 min wall time) was mid-flight. The suite's
child process was healthy the entire time; the run lost full lanes to
it twice, and a third run only survived by inflating
`--command-timeout-ms` to an hour — which weakens wedge detection for
every other invocation to protect one long suite.

The stream-parsing providers only soften this: claude/codex reset the
watcher on `tool_call` events (ADR 0008), but that fires once when a
command *starts* — a suite that then runs silently past the idle floor
still dies. Kiro has no structured stream at all (ADR 0004).

## Decision — process-level busy probe, consulted at kill time

"Silent but working" and "silent and hung" are distinguishable at the
process level: a working agent has a live child it spawned for the
command. The machinery to see that already exists — ADR 0020's
(pid → ppid) table listing and `collectTree` BFS — used until now only
inside the kill path.

`src/busy-probe.ts` (`createBusyProbe(pid)`):

- Shortly after spawn (default **5 s**, before any model round-trip can
  plausibly have started a command), snapshot the agent's process tree.
  That is the *quiescent baseline*: the CLI shim, the real CLI, its
  helpers.
- `check()` re-lists the tree and counts live PIDs **not in the
  baseline** — processes the agent started afterwards, i.e. a running
  command.

`createIdleWatcher` gains an optional async `shouldDefer` probe: when
the idle timeout fires and the probe resolves true, the kill is
skipped, `onDefer` fires (one log line per deferral: *"generator silent
for 600s but 2 spawned process(es) still running — deferring idle
kill"*), and both timers restart. The warning counter deliberately
keeps counting across deferrals — the agent genuinely is silent, and
the accumulated minutes stay truthful. A `reset()` or `stop()` landing
while the async probe is in flight invalidates its decision (generation
counter): fresh activity means the kill question is stale.

All three providers wire the probe identically.

## Why this stays safe

- **The wall-clock ceiling is untouched.** A spawned process that is
  *itself* hung (dead DB connection, deadlocked suite) defers idle
  kills but cannot defer the ADR 0016/0019 ceiling — 120 min for
  generator/evaluator-qa. Deferral trades "kill healthy work at
  idle-timeout" for "kill hung-command sessions at the ceiling", and
  the ceiling was always the backstop for exactly this class.
- **Conservative failure posture.** Probe unavailable (no
  PowerShell/`ps`), baseline never captured, or root PID missing →
  `check()` reports 0 and the kill proceeds — the exact pre-probe
  behavior. The probe can only ever *extend* a session's life when it
  has positive evidence of a live spawned process.
- **A wedged CLI is still killed on time.** Its tree never grows beyond
  the baseline, so the first idle timeout kills it exactly as before.
  The kiro progress filter (ADR 0016) is unchanged and remains the
  primary stall detector for spinner-painting hangs.

## Known trade-offs

- A command started within the 5 s baseline window would be counted as
  baseline and not defer kills. Real commands require at least one
  model round-trip first, so the window is practically unreachable;
  wrong-way failure is the old behavior, not a new one.
- PID reuse between baseline and probe could theoretically report a
  fresh process that is unrelated. The consequence is one deferral
  cycle, bounded by the ceiling.
- POSIX gets a `ps -A -o pid=,ppid=` lister (new); Windows reuses the
  ADR 0020 CIM lister. Either failing degrades to pre-probe behavior.

## Complementary prompt guidance

`prompts/generator.md` now instructs the generator to let long-running
commands stream (no output-buffering filters, prefer compact reporters
over silence). Streaming output is the cheaper heartbeat; the probe is
the guarantee when agents ignore the guidance or a runner buffers
anyway.
