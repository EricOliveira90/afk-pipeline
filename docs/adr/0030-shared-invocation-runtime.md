# Shared invocation runtime behind agent providers

**Date:** 2026-08-22

## Context

`kiro.ts`, `claude.ts`, and `codex.ts` each owned a copy of the agent
invocation lifecycle: spawn, stdout/stderr teeing, idle watcher and busy-probe
deferral, wall-clock ceiling, cancellation, verified tree termination, kill
reason selection, and settlement ordering. Claude and Codex also duplicated the
stdout newline framing and stream-event loop.

The copies were already drifting. Codex used ASCII hyphens in kill messages
where Kiro and Claude used em dashes, and its tool-call cap used a different
expression for the same rule. This was unsafe because those details are not
cosmetic: the orchestrator pattern-matches the wall-clock ceiling message (ADR
0019), and ADR 0020 requires every kill outcome to wait for a verified
process-tree termination report rather than trusting the child `exit` event.

ADR 0004 rejected a separate stream-parser module because each agent provider
owned its spawn loop and consumed its parser there. A shared spawn loop changes
that premise.

## Decision

Add `src/invocation-runtime.ts` as the deep module for one agent invocation. Its
interface accepts `InvokeOptions` plus a prepared invocation containing a
command and optional provider hooks. The runtime owns:

- process spawn and optional prompt delivery over stdin;
- stdout/stderr teeing, stdout newline framing, and stream-event dispatch;
- tool-call counting and the tool-call cap;
- the idle watcher, idle warnings, and busy-probe deferral;
- the independent wall-clock ceiling;
- cancellation;
- tree-first verified termination and survivor warnings;
- the kill-reason ladder and load-bearing message shapes; and
- settlement ordering, handle release, and settle cleanup.

Agent providers remain the adapters at the existing `AgentProvider` seam. They
supply only behavior that genuinely differs:

- Kiro supplies argv/model policy, managed worker-agent preparation, a
  spinner-aware activity filter, the fail-open output sniffer and transient
  output tail, and transient exit classification.
- Claude supplies argv/model/bare-mode policy, its stream parser, and cost
  extraction from result envelopes.
- Codex supplies argv/reasoning policy, isolated spawn environment preparation
  with settle cleanup, its stream parser, and stderr detail for nonzero exits.

Provider-specific errors from an output sniffer or stream parser sit below
cancellation and above the shared tool-cap, wall-clock-ceiling, and idle-timeout
rungs. This preserves Kiro's agent-config failure and Codex's provider-stream
failure precedence.

Stream parsing remains optional on `AgentProvider`. When present, the provider's
`parseStreamLine` is wired directly into the runtime-owned stdout line loop.
Kiro still supplies no parser. This revisits ADR 0004's rationale without
changing the `AgentProvider` interface or moving stream events into the
orchestrator.

## Pinned lifecycle semantics

The runtime preserves the existing decisions:

- Kill messages use the Kiro/Claude em-dash form, including Codex (ADR 0019).
- Every kill is tree-first and verified; an `exit` observed during a kill is
  held until the termination report arrives (ADR 0020).
- Busy-probe deferral restarts only the idle cycle. It never changes or resets
  the wall-clock ceiling (ADR 0021).
- Providers classify transient failures. Retry policy remains in the
  orchestrator (ADR 0022).

## Verification strategy

`invocation-runtime.test.ts` is the authoritative lifecycle suite. It tests the
runtime through its interface with one shared `FakeProc` fixture, covering idle
kill, busy-probe deferral, wall-clock ceiling, cancellation, tool-call cap,
kill-verification settlement, survivor warnings, root-survivor settlement,
child-handle release, stream framing, and cleanup. Provider suites test adapter
concerns only. `kill-tree.test.ts` continues to test the termination
implementation itself using the same fixture.

## Consequences

Lifecycle changes now have one implementation and one test surface. Adding an
agent provider requires command preparation and only the hooks its CLI needs;
it does not require copying the process state machine. The orchestrator and the
`AgentProvider` interface remain unchanged.
