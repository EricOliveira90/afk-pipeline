# Orchestrator owns contract Status; idle watcher resets on tool calls

**Date:** 2026-05-24

## Context

PRD 024 Wave 1 produced two slices stuck in `Phase B returned ERROR`
(`#271`, `#274`) after 36 minutes. Postmortem (see
`.afk/logs/024-lead-triage-view-claude-code/run-summary.md`) found
three compounding bugs:

1. The contract evaluator returned `VERDICT: ACCEPT` and instructed
   the planner to "flip Status to LOCKED" — but the planner's next
   round never runs once the verdict is ACCEPT, so Status stayed at
   `NEGOTIATING` on disk.
2. The orchestrator's `readContractStatus` papered over (1) by
   treating ACCEPT as implicitly LOCKED, but the **generator prompt**
   reads the literal Status field and bails by its own invariant
   ("If `contract.md` Status is not `LOCKED`, stop and report
   immediately"). Round 1 produced no code; the empty worktree
   trivially failed evaluator-qa round 1 and burned the round.
3. On round 2, the generator wrote real code, then ran the full test
   suite via Bash. The harness backgrounded the long-running command;
   the agent waited silently for results. The 3-minute idle floor
   (ADR 0007) fired and killed the session before any commit.

## Decision

**Single source of truth on contract lock state lives in the
orchestrator.** After `evaluator-contract` returns ACCEPT,
`runSliceNegotiate` calls `lockContract(path)` (new in
`src/artifacts.ts`) which writes `**Status:** LOCKED` directly. Agent
prompts no longer claim Status is the planner's responsibility, and
`readContractStatus` no longer infers LOCKED from evaluator verdicts.

**Idle watcher resets on parsed `tool_call` events**, not just on
stdout chunks. A backgrounded Bash command produces no stdout from
the agent's perspective, so the previous reset path missed it. The
tool-call ceiling (ADR 0007) is unaffected — the cap still fires on
runaway loops.

**Generator and evaluator-qa default to a 10-minute idle floor**
(`SLOW_AGENT_IDLE_TIMEOUT_MS`). Other roles keep the 3-minute
provider default; both roles can override per-invocation.

## Consequences

- Contract lock state is unambiguous on disk. Agents and the
  orchestrator agree on what the file says.
- A round of negotiation isn't wasted on a foregone-conclusion FAIL.
- Long test suites no longer trip the idle floor mid-run.
- The `lockContract` writer is small and idempotent, so reruns of
  Phase A on a previously-locked contract are safe.

## Alternatives considered

- **Prompt-side fix:** make `evaluator-contract` flip Status when it
  ACCEPTs. Rejected — agents are inconsistent at file edits, and the
  same agent grading itself for compliance is a bad audit trail.
- **Stricter `readContractStatus`:** keep the ACCEPT shortcut but
  warn loudly. Rejected — the divergence between disk and
  orchestrator state was the root cause, not the symptom.
- **Tool-call counter as idle reset signal:** reset only on the
  first tool_call per minute. Rejected — adds state for no real
  benefit; tool_calls are already cheap to count.
