# Tool-call cap is opt-in; the wall-clock ceiling is the backstop

Supersedes the default in ADR 0007's tool-call ceiling. The mechanism,
its kill class, and its recovery plumbing all remain.

## Failure mode

In the PRD 1 run (`afk-v2-evidence-backbone`, codex), slice #75's
generator was killed by the tool-call cap after 105 minutes — with its
work already complete: 12 files, 903 insertions, 8 conventional commits
on its branch, full suite reported green. It died during final
verification, on its first generator round.

Of its 103 shell commands, 25 were test runs and 8 typecheck. Roughly
70–85 of the 105 minutes was spent waiting on the Windows vitest suite.
That is not a "talky loop" (the failure ADR 0007 built the cap for) —
it is a disciplined TDD loop against a slow suite, and it legitimately
spends 100+ tool calls.

The calibration mismatch was structural: the same generator's
wall-clock ceiling is 120 min (ADR 0019), but the tool-call cap was a
hardcoded `DEFAULT_MAX_TOOL_CALLS = 100` with no CLI flag and no
per-role override. Two bounds guarding the same failure mode — a
runaway session — calibrated two orders of magnitude apart, and the
tighter one killed healthy work.

## Decision — no tool-call kill by default

`maxToolCalls` on `InvokeOptions` keeps its meaning but loses its
default. Unset — which is every current call site — means no tool-call
kill; the wall-clock ceiling (ADR 0016 decision 3, recalibrated per
role by ADR 0019) is the backstop for runaway sessions, talky loops
included: a loop that emits tool calls forever still burns wall-clock
time and dies at the ceiling.

What stays:

- **Counting.** `toolCallCount` still increments per `tool_call` event
  and still feeds `InvocationStats`, the slice totals, and the run
  totals in run-summary.md. Only the kill is gone.
- **The opt-in path.** A caller that sets `maxToolCalls` gets exactly
  the old behavior: the `(N+1)`th tool call trips the kill with the
  same `exceeded N tool calls — killed` message.
- **The classification plumbing.** The `tool-call-cap` kill class, its
  `KILL_SIGNATURES` regex, its label, and `classifyReviewFailure`'s
  `DIED_MID_RUN` mapping all remain — they serve the opt-in path.

## Decision — a tool-call-cap kill is not infrastructure-retried

`tool-call-cap` previously classified as an orchestrator kill, making
it an infrastructure cause eligible for `--infrastructure-retries`.
Retrying such a kill verbatim just re-runs the same invocation into the
same cap after another full budget — the retry can never succeed.

Considered: retrying with a raised cap. Rejected — the retry path has
no per-attempt option plumbing, and building it for an opt-in bound
inverts the point of opting in: a caller who set a cap asked for the
invocation to stop there. `isInfrastructureCause` now refuses the
retry; a tool-call-cap kill fails the slice immediately, like a
verdict.

## Why not raise the default instead

Any fixed default re-creates the calibration problem at a different
number: the observed healthy generator spent 103 calls; a heavier slice
on a slower suite spends more. The tool-call count is a proxy for
progress that the wall-clock ceiling already bounds directly, and the
ceiling is per-role calibrated (ADR 0019) where the cap never was.

## What stays untouched

- The idle floor (ADR 0007) and its per-role overrides (ADR 0008).
- The wall-clock ceiling and `--max-agent-duration-ms` (ADR 0019).
- `InvocationStats`, run-summary columns, and the events schema.
