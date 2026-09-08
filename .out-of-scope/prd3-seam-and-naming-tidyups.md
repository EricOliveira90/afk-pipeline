# PRD 3 Seam and Naming Tidy-Ups (fold-in, not tickets)

Two PRD 3 structural items are real but do not earn a standalone slice:
moving envelope metadata off the `AgentProvider` seam (#163), and renaming the
prompt-assembly helpers that no longer do what their names say (#165).

## Why this is out of scope as tickets

`docs/agents/triage-rules.md` §4 exempts refactor work from the §1
roadmap-citation rule, but requires **observed friction**: a measured cost, a
recorded incident, or a pain that recurred at least twice. Neither has it.

**#163** is a recorded architect note from the PRD 3 ship gate, but its stated
impact is prospective — "future envelope or provider additions require
coordinated edits across orchestration, prompt assembly, provider types,
events, and summary consumers" — and the note itself concludes that current
dispatches remain correct and fail closed, so it is structural debt rather
than a ship blocker. The one live fact is a layering inversion
(`contract-prompt-orchestration` importing its evidence type from the provider
layer), which is a state, not a friction. The guardian's own prescription is a
fold-in: move the invocation evidence onto an orchestrator-owned wrapper
"when this seam is next changed."

**#165** appears in neither `review-architect.md` nor `review-pm.md`. The
claim that the misleading names cost review time is not recorded anywhere. The
ignored journal parameter did spread from two call sites to four while the
issue sat, which is growth, not evidence.

Both are correct diagnoses. §4's default vehicle applies: fold into the next
slice that edits the area. A standalone slice needs friction to justify its own
round cost, and here the round cost exceeds the change.

## Re-open trigger

Either a slice editing the `AgentProvider` seam or the prompt-orchestration
module trips over these and records the cost, or one of them blocks a concrete
change.

#162's orchestrator-hub extraction is the most likely occasion — it touches
the same area. Treat this file as a pointer for that slice's planner, not as a
scope instruction: whether to absorb either item stays the planner's call at
contract time.

## Prior requests

- #163: "Move InvokeOptions.contextEnvelope off the AgentProvider seam to an orchestration-owned wrapper"
- #165: "Naming cleanups: promptAssemblyContext's unused _journal param; recordPromptAssembly no longer records"
