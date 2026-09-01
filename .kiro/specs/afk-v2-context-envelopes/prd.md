# PRD 3: Context envelopes and prompts v2 - role manifests and focused assembly

**GH issue:** #71
**Parent design:** `docs/specs/afk-v2-agent-roles.md` (mechanism M5; per-role sections 1-4)
**Parent plan:** `docs/specs/afk-v2-plan.md` (§2 PRD 3; carries §3 item 5 manifest entry, item 13, and §3c policies 1-3)

## Problem Statement

AFK's prompts accumulate. Retry notes hand the generator every preserved QA report and ask it to reconcile them; required-reading lists send agents grepping for ADRs; resume situations spawned three generator template variants; role prompts carry rituals (TDD mechanics, reasoning protocols, streaming workarounds) that deterministic machinery has since made redundant. Long prompts create context rot - instruction quality falls as unrelated context accumulates - and "lost in the middle": critical constraints lose attention inside large prompts. The observed 15-minute docs-only generator round traces directly to a prompt that defined "done" as a self-assessed claim while forbidding the measurement.

## Solution

Versioned role context manifests and focused prompt assembly (supersedes gauntlet issue #54):

- Every agent role gets one versioned **context manifest**: objective, non-goals, allowed write scope, stop and escalation conditions, accepted input artifact classes, output artifact, input order, and a configurable inline-size budget.
- **Envelope order** enforced by assembly: objective, write boundary, and stop condition first; small supporting context in the middle; unresolved evidence and the output contract last.
- **Two templates per role**: initial and revision/repair. Resume situations become data blocks (commit log, base-refresh note) in the repair template. The resume-stuck and stuck variants retire.
- **Fresh invocations**: no prior conversation, no other role's conversation, no resolved findings, no passing raw logs. Large logs and documents pass as artifact references plus a short canonical summary.
- **Fail-closed budgets**: required content over budget stops prompt preparation with a configuration result; nothing is silently truncated.
- **Size evidence**: assembled prompt size, included artifact IDs, omitted artifact classes, and manifest version recorded in run evidence; provider token counts when exposed.
- New prompt content per the session record: explorer restructured to four sections with the citation-label rule and section-level selection; planner emits contract plus manifest; contract evaluator judgment-only with revision template; generator one-screen with inline file scope, coverage obligation, escalation instruction, and computed failure set.
- **Repository-context entries** (plan ┬º3c, 2026-08-28): the explorer and planner envelopes carry an ADR index (number plus title, one line each; the agent reads a full ADR from its worktree only when a title matches its slice) and the repository's `ARCHITECTURE.md` when present. Absence of either degrades to today's envelope. The writing roles' escalation instruction becomes the ┬º3c criteria text: escalate on spec contradiction (a recorded ADR counts as spec), load-bearing silence, or a declared risk class; decide-and-record otherwise.

## User Stories

1. As a maintainer, I want every role to have a versioned context manifest with a size budget, so that prompt growth is visible and controlled.
2. As a maintainer, I want each round to start as a fresh invocation without prior conversation, so that context rot does not accumulate across rounds.
3. As a generator agent, I want my prompt to contain only the locked contract view, manifest, file scope, patterns section, and current failure set, so that unrelated context cannot distract me.
4. As a generator agent, I want the file scope inline in my prompt as the write boundary, so that I do not reconstruct my cage from prose.
5. As a generator agent, I want the repair round to receive the orchestrator-computed unresolved set (finding IDs with clear-conditions plus gate failures), so that I never re-read all preserved reports.
6. As a planner agent, I want the explorer's evidence sections selected for me, so that I plan from cited facts and named unknowns.
7. As a planner agent, I want a revision template scoped to open findings, so that rounds converge on the specific conflicts.
8. As a contract evaluator, I want the manifest, gate catalog, and explorer sections as inputs, so that I can judge against repository reality.
9. As an explorer agent, I want a four-section output with the citation-label rule, so that facts, inferences, and unknowns are distinguishable downstream.
10. As a maintainer, I want explorer output selected by section rather than per-item role tags, so that the explorer never models other roles' needs.
11. As a maintainer, I want resume and resume-stuck situations expressed as data blocks in one repair template, so that four generator templates collapse to two.
12. As a maintainer, I want rituals removed (TDD mechanics, reasoning protocols, streaming invariants, craft lectures, self-review), so that deterministic outcomes enforce the value and prompts stay one screen.
13. As a run operator, I want over-budget required content to fail prompt preparation, so that an agent never works from a silently truncated contract.
14. As a run operator, I want assembled prompt size and included artifacts in run evidence, so that context growth that increases cost or error rate is findable.
15. As a maintainer, I want stable behavior IDs, gate IDs, finding IDs, and checkpoint IDs preserved through any compaction, so that no schema projection loses governing identity.
16. As a maintainer, I want the same logical envelope across Kiro, Claude Code, and Codex providers, so that orchestration stays provider-independent.
17. As a maintainer, I want prompt assembly deterministic for the same manifest version and artifact set, so that envelope behavior is testable.
18. As a generator agent, I want handoff reduced to what-shipped, decisions, and gotchas for later slices, so that no status claims survive anywhere.
19. As an explorer agent, I want an ADR index (numbers and titles) in my envelope, so that I cite governing decisions without grepping for them.
20. As a planner agent, I want `ARCHITECTURE.md`'s hubs, seams, and placement rules in my envelope, so that I declare seams instead of hubs and new code lands where the repository says it goes.
21. As a writing agent, I want the escalation instruction to state the three critical-judgment tests, so that I escalate spec contradictions and declared risks and record the rest instead of asking.

## Implementation Decisions

- AFK owns the role context manifests; project policy may set stricter budgets but cannot add undeclared context classes without a manifest-version change.
- Envelope contents follow the session record's per-role include/exclude lists, which amend the parent spec's role table: explorer evidence sections enter the generator, contract evaluator, and (later) candidate evaluator inputs.
- Small contract and evidence views are deterministic schema projections from PRD 1 artifacts, never new agent summaries.
- The sibling-handoff and ADR-grep required-reading instructions move upstream: the explorer cites; the planner copies governing facts into the contract; the generator reads what the contract cites.
- The verbatim test-command line stays in the generator prompt (local-run drift wastes the round).
- Deterministic gates, not added prompt prose, enforce every fact the orchestrator can check; prompt text that restates a gate is deleted.
- The ADR index and `ARCHITECTURE.md` are optional inputs, index pushed and body pulled: full ADR texts never enter envelopes, and a repository without either file assembles today's envelope. A slice whose correct implementation contradicts a recorded ADR escalates as a spec contradiction (plan ┬º3c policy 1).

## Testing Decisions

- The context envelope is a public orchestration contract: test included artifact classes, excluded artifact classes, input order, stable-ID preservation, fresh-invocation state, size evidence, and over-budget failure without silent truncation.
- Primary seam: full-pipeline runs with stub providers that record received prompts; assert the generator's round-2 prompt contains current unresolved findings and no resolved ones, no prior conversation, no other role's output.
- Do not test prompt wording except where it is itself a public contract (placeholder set, envelope order, budget behavior).
- Prior art: existing prompt-template rendering tests and orchestration tests that assert prompt-block content.

## Out of Scope

- Executing acceptance/scope gates (PRD 4) - the generator's coverage-obligation line lands here, its gate lands there.
- New role prompts for candidate/final evaluator, cleaner, hardener, remediator (PRDs 4-6); their manifests reuse this machinery when they arrive.
- Provider model selection, authentication, or streaming changes.

## Further Notes

Full session record: `docs/specs/afk-v2-agent-roles.md` (mechanism M5 and per-role sections 1-4). Supersedes gauntlet issue #54. Depends on PRD 1 (schemas to project) and PRD 2 (escalation instruction and computed unresolved sets). PRD 0 (PR #68) already shipped the hand-editable subset; this PRD replaces those interim edits with assembled envelopes. The repository-context entries and the escalation-criteria text implement `docs/specs/afk-v2-plan.md` ┬º3c (policies 1-3, agreed 2026-08-28).


