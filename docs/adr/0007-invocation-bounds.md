# Per-invocation bounds: idle floor + tool-call ceiling

Each Claude/Kiro invocation is bounded by two independent caps:

- **Idle floor.** `idleTimeoutMs` defaults to **180_000** (3 min). No
  stdout/stderr for that long → `SIGTERM`. Set in `src/claude.ts` and
  `src/kiro.ts`.
- **Tool-call ceiling.** `maxToolCalls` defaults to **100**. The
  `(N+1)`th tool_call event triggers `SIGTERM`. Enforced in
  `src/claude.ts` only, where the structured stream gives a clean
  signal; Kiro doesn't parse a stream (see ADR 0004) so the floor is
  its only guard.

Both errors come back through the same `provider.invoke` rejection path
that `runSliceNegotiate` and `runSliceExecute` already catch — a capped
or wedged session lands the slice in `STUCK`, not in a hung process.

## Failure mode

The `evaluator-qa` agent ran `pnpm test --run` against a Jest project
(Jest doesn't accept `--run`). The command exited non-zero. The Claude
session then entered an unrecoverable loop, emitting text and tool calls
without making progress on the QA report. Idle timeout was 600s and the
session kept emitting bytes — every chunk reset the watcher, so it never
fired. The slice never reached a verdict; the run hung indefinitely.

The hardcoded test command is fixed separately by the
`{{TEST_COMMAND}}` placeholder injected from `resolveTestCommand`. This
ADR covers the second failure surface: a wedged session needs a bound
that doesn't depend on the agent eventually going silent.

## Why two caps, not one

Idle timeout and tool-call ceiling fail in opposite directions:

- **Silent wedge** — process alive, no output. Idle timeout catches
  this. Tool-call ceiling can't, because no tool calls are happening.
- **Talky loop** — agent emits text/tool calls forever without
  progress. Tool-call ceiling catches this. Idle timeout can't,
  because every chunk resets it.

A single cap leaves one surface uncovered. Both together cost two
counters and ~10 lines of code in `claude.ts`.

## Why these defaults

**3-minute idle floor.** Real test/build steps emit progress to stdout
within seconds (vitest dot reporter, jest "PASS file.test.ts" lines,
tsc compile errors). 3 minutes of total silence indicates a genuinely
wedged process — the previous 10-minute floor just slowed recovery.
Per-invocation override via `idleTimeoutMs` is preserved for
operations that genuinely need longer.

**100 tool-call ceiling.** Slices in production usage land in 20–40
tool calls (read source, write code, run tests, write report). 100 is
~2.5× the observed ceiling — high enough that legitimate slices don't
trip it, low enough that a runaway loop stops within seconds rather
than minutes. Tied to `claude.ts`'s existing `toolCallCount` counter,
so the cost is one comparison per tool_use event.

## Why not semantic loop detection

A more precise alternative: parse assistant text and tool_call args,
detect repetition (same question twice, same Bash command 3×),
short-circuit on detection. Rejected for now:

- **Cost.** Requires a sliding-window comparison over arbitrary text.
- **False positives.** A retry of the same `pnpm test` is normal
  behaviour, not a loop. Distinguishing "looking at the same file
  again" from "stuck reading the same file forever" needs heuristics
  this codebase doesn't have anywhere else.
- **Caps are sufficient.** The two caps above cover every reported
  failure mode without semantic analysis. If a future incident slips
  past both, the data from that incident is what should drive the
  detector — guessing now is premature.

If we add it later, the natural seat is `claude.ts`'s tool_call branch,
adjacent to the counter that already feeds the ceiling.

## What stays untouched

- `IdleWatcher` (`src/idle-watcher.ts`) — same shape; only the default
  `idleTimeoutMs` passed to it changes.
- `parseStreamLine` and the existing `toolCallCount` field on
  `InvocationStats` — no schema change. The cap reuses the counter
  the orchestrator already records for cost telemetry.
- Per-invocation overrides — both `idleTimeoutMs` and `maxToolCalls`
  are `InvokeOptions` fields callers can raise for legitimately
  long-running operations (e.g. a generator implementing a large
  slice). The defaults exist to bound the common case, not to
  ceiling every case.
