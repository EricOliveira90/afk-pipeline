# Stream parsing is provider-optional

`AgentProvider` exposes `parseStreamLine?(line: string): StreamEvent[]`
as an **optional** method. Providers whose CLI emits a structured stream
(today: `claude --output-format stream-json`; future: codex `--json`)
implement it and surface typed **stream events** to the orchestrator.
Providers whose CLI emits opaque stdout (today: kiro) leave it
undefined; the orchestrator falls back to treating the stream as plain
log output.

**Why optional, not required:** the parent Sandcastle codebase makes
`parseStreamLine` required and lets non-streaming providers (e.g.
`opencode`) return `[]`. We considered the same shape and rejected it.
Returning `[]` is a *lie about capability* — the orchestrator can't
distinguish "this provider streams nothing" from "this provider had
nothing to stream this turn." Concretely, that distinction matters for
the planned no-text-progress detector: with a required stub the
detector would fire spuriously on kiro every run; with an optional
hook the orchestrator only enables the detector for providers that
actually parse events.

**Why a method on `AgentProvider`, not a separate `StreamParser`
interface:** afk's provider already owns the spawn loop (unlike
Sandcastle, where the orchestrator spawns and the provider only builds
commands). The line parser is consumed *inside* `invoke()` —
splitting it onto a separate object would force every provider to
import and wire up two correlated objects for one capability.

**Why `StreamEvent` mirrors Sandcastle's `ParsedStreamEvent` shape:**
the discriminated union (`text | tool_call | result | session_id`) is
already battle-tested in `src/AgentProvider.ts`. When codex eventually
joins as an afk provider, `parseCodexStreamLine` from the parent
codebase lifts in almost verbatim. Mirroring the shape preserves that
portability.

**Consumption model:** the orchestrator passes `onStreamEvent` through
`InvokeOptions`; providers that parse call it for each event during
the stdout loop. Aggregates (`costUsd`, `toolCallCount`) are returned
on `InvokeResult` as **invocation stats**. The orchestrator sums
those into **slice totals** and **run totals** in run-summary.md.

## Considered alternatives

- **Required `parseStreamLine` returning `[]` for kiro** — matches
  Sandcastle exactly. Rejected: capability lie; complicates the
  no-text-progress detector and any future "did this run produce any
  parsed events?" gating.
- **Separate `StreamParser` interface plumbed alongside the provider**
  — cleaner separation of "how to spawn" vs. "how to parse." Rejected:
  the parser is consumed inside `invoke()`'s stdout loop; splitting it
  onto a second object is friction without benefit while afk has only
  one stream-parsing provider.
- **Return `StreamEvent[]` on `InvokeResult` instead of a real-time
  callback** — simpler signature. Rejected: idle-warning reset
  semantics and per-slice log routing both need events as they
  arrive, not in a final batch.
