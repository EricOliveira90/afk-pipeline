Continue improving the afk/ pipeline orchestrator at C:\Code\sandcastle\afk\
based on patterns from the parent Sandcastle codebase at C:\Code\sandcastle\src\.

Background: We previously did two refactors and captured the decisions in
afk/CONTEXT.md and ADRs 0002 + 0003:

- Replaced duplicated kiro.ts / claude.ts invokers with a single AgentProvider
  interface (afk/src/agent-provider.ts). Branch prefixes derive from
  provider.name. Backend / Invoker terms retired.
- Threaded AbortSignal end-to-end. SIGINT triggers AbortController in afk.ts
  / afk-claude.ts. In-flight agent processes get SIGTERM. Unstarted slices
  marked CANCELLED. Worktrees preserved for resume.

Now tackle the next two items:

# Item 4 — Idle-warning heartbeat

Today afk only has a hard 10-min idle kill (kiro.ts / claude.ts resetIdle).
Sandcastle (src/Orchestrator.ts:51-58, 342-348) emits a per-minute
"Agent idle for N minutes" warning while idle but doesn't kill. This
makes long-running agents legible in logs.

Goal: add a periodic idle warning to AgentProvider.invoke (defaults: 60s
warning interval, 10min hard kill). Surface warnings via a callback in
InvokeOptions so the orchestrator can route them to the slice's log
stream and the run summary.

# Item 5 — Structured stream events

claude.ts already line-parses stream-json but only extracts cost. Sandcastle
(src/AgentProvider.ts) parses every event into typed shapes:
{ type: "text" | "tool_call" | "result" | "session_id"; ... }
and routes them through AgentStreamEmitter.

Goal: parse stream events in the claude provider and surface them to the
orchestrator. Use them to:

- record per-slice tool-call counts in run-summary.md
- detect "no progress" beyond plain stdout silence (e.g. agent looping
  on reads without producing text)
- (stretch) capture costUsd per slice / total in run-summary.md (we
  already extract it but throw it away)

Kiro doesn't emit stream-json today, so the parsing is provider-specific.
The AgentProvider interface should expose an optional
parseStreamLine(line) hook; the orchestrator only consumes events when
the provider implements it.

# What I want from you

1. Run /grill-with-docs to stress-test the design for both items together
   against afk/CONTEXT.md and the existing ADRs. Resolve terminology before
   any code:
   - Is "idle warning" the right term, or "heartbeat", or "liveness ping"?
   - Sandcastle uses "agent stream event" — adopt as-is, or do we need a
     leaner term given afk doesn't have a Display layer?
   - What's the right term for the cost/tool-count aggregates surfaced
     in run-summary.md? "Run metrics"? "Slice telemetry"?
   - How does parseStreamLine relate to the existing AgentProvider
     interface — extension point on the same object, or separate
     "stream parser" concept?

2. Update afk/CONTEXT.md inline as decisions crystallize. Add ADRs only
   for non-obvious / hard-to-reverse calls (e.g. "stream parsing is
   optional per-provider, not required by the interface" likely warrants
   an ADR; "warnings every 60s" likely doesn't).

3. Implement once design is settled. Verify with:
   node_modules/.bin/tsgo --noEmit -p afk
   cd afk && ../node_modules/.bin/vitest run

Be concise during grilling — one question at a time, one paragraph
recommendations. Reference existing Sandcastle implementations
(src/Orchestrator.ts, src/AgentProvider.ts, src/TextDeltaBuffer.ts)
when proposing solutions.
