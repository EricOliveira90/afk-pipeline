# PRD 2: Routing and adjudication - escalation, impasse, human decisions in live runs

**GH issue:** #70
**Parent design:** `docs/specs/afk-v2-agent-roles.md` (mechanism M4)
**Parent plan:** `docs/specs/afk-v2-plan.md` (SS2 PRD 2)
## Problem Statement

When an agent cannot proceed legally, AFK has no move that changes pipeline state. A finding whose fix sits outside the locked file list deadlocks the slice: the generator either edits out of scope or stalls (round expires). This caused two STUCK outcomes in run-20260824-174249. ADR 0048 (wave 3, #112) has since absorbed the QA-side half: a QA boundary finding that only needs the scope widened names remedy `SCOPE_AMENDMENT`, and the orchestrator amends the locked scope and re-grades without spending a generator round. The generator-side half remains: a generator that knows the fix needs an out-of-scope path *before* building anything still has no legal move. A negotiation disagreement between planner and contract evaluator has no terminal except round exhaustion. The stuck diagnosis is written by a tired agent as prose. And when a human does decide something, there is no way to inject that decision into a live run - the slice waits for a whole new run.

## Solution

One routing mechanism with structured artifacts:

- A schema-validated **escalation artifact** written by a writing role that cannot proceed legally. Five consumers share it: the generator (fix requires an out-of-scope path -> routes to contract revision), the cleaner and hardener (future consumers, mechanism ready in this PRD), contract negotiation (a CONTESTED finding held at exhaustion -> impasse routed to the human), and the remediator (out-of-scope aggregate fix -> blocked ship with explanation attached).
- **Park-as-dependency:** a slice blocked on a human decision becomes blocked on an external dependency named "adjudication". The rest of the run continues.
- A schema-validated **adjudication artifact** (finding ID, winning position or third instruction, author) written into the slice directory. When it appears, the slice is dispatchable again like any slice whose dependencies completed. The wait is bounded; after timeout the slice parks permanently and the next run resumes it. The human decision resolves a finding, not the contract: one mechanical apply-and-lock step runs before any generator starts.
- **Code-assembled stuck diagnosis:** the stuck artifact is generated deterministically from archived findings, escalations, and round evidence. The generator-stuck agent invocation is removed.
- The **babysit skill becomes the courier**: it watches for impasse artifacts, presents the contested question to the human verbatim (both positions, both evidences, no summary bias), and writes the validated adjudication artifact. It carries the message; it does not vote. The skill stays in its external home; courier duties land as a manual follow-up (#94) after #89, and relocation (story 14) stays deferred.

## User Stories

1. As a generator agent, I want a structured escalation when a correct fix requires a path outside my declared scope, so that the slice routes to contract revision instead of deadlocking.
2. As a run operator, I want scope escalations to trigger a focused contract-revision round, so that a too-narrow lock is repaired at the contract, not gamed at the code.
3. As a run operator, I want a CONTESTED finding held at round exhaustion recorded as an impasse with both positions and evidence, so that the disagreement is pre-digested to one question.
4. As a human operator, I want impasses brought to me for decision rather than settled by the babysit agent, so that intent conflicts stay mine.
5. As a babysit agent, I want to present the contested question verbatim and write a validated adjudication artifact, so that I courier decisions without biasing them.
6. As a run operator, I want the run to continue with other slices while one slice awaits adjudication, so that a single conflict does not stall the wave.
7. As a human operator, I want my decision injected into the live run, so that the parked slice resumes as soon as possible.
8. As a run operator, I want the adjudication wait bounded, so that an overnight run does not hang on a sleeping human; the next run picks the slice up.
9. As a run operator, I want the human decision to resolve the finding and then pass through one mechanical apply-and-lock step, so that no contract locks without passing the lock gate.
10. As a run operator, I want two exhaustion shapes distinguished - impasse (adjudicate the point) and non-convergence (fix the ticket) - so that the remedy matches the cause.
11. As a maintainer, I want the stuck diagnosis assembled by code from structured evidence, so that no agent invocation is spent summarizing and no synthesis bias enters the record.
12. As a maintainer, I want the generator-stuck and resume-stuck prompt variants retired, so that repair rounds have one template with situation data blocks.
13. As a run operator, I want escalation artifacts schema-validated and fail-closed, so that a malformed escalation cannot silently reroute a slice.
14. As a maintainer, I want the babysit skill versioned inside this repository and installed globally, so that courier duties evolve with the pipeline that emits the artifacts.
15. As a run operator, I want DAG dependents of a parked slice to stay blocked and lane semantics preserved, so that routing adds no new scheduling hazards.
16. As a maintainer, I want cancellation and resumption to treat parked slices safely, so that Ctrl-C during a wait loses nothing.

## Implementation Decisions

- Escalation and adjudication are filesystem artifacts, consistent with AFK's artifact-driven control flow; both are schema-validated before they count.
- Routing model: the parked slice's phase is recorded in run state; the wave scheduler treats adjudication as an external dependency. Whether injection is event-driven re-enqueue or wait-at-idle depends on the scheduler's dispatch dynamics - decide after inspecting the wave module; the bounded-wait-plus-resumption fallback is required either way.
- A generator scope escalation consumes no generator round; it spends a contract-negotiation round (the revision templates from PRD 1's finding lifecycle).
- The stuck artifact keeps its name and audit role; only its author changes from agent to code. The "best guess at the blocker" synthesis section is dropped - the human adjudicates from evidence.
- The babysit skill stays in its external home and gains courier duties there (manual follow-up #94, after #89 lands), referencing this repository's adjudication schema as the single source of truth. Relocation and global install (story 14) stay deferred until a skill/pipeline version skew actually bites a run.
- Existing STUCK/resume semantics, MERGE-PENDING, lane-cancelled, and blocked-ship classifications are preserved; escalation is a new routing cause, not a new terminal status taxonomy.

## Testing Decisions

- Primary seam: the full-pipeline filesystem contract. Stub generators write escalations (valid, malformed, out-of-scope); tests assert routing: contract-revision round dispatched, no generator round consumed, run continues with siblings, dependents stay blocked.
- Impasse end-to-end: stub evaluator holds a CONTESTED finding for two rounds; assert the impasse artifact carries both positions; write an adjudication file mid-run and assert the slice becomes dispatchable; omit it and assert bounded-wait expiry parks the slice for next-run resumption.
- Stuck assembly: exhaust rounds with archived findings and assert the code-assembled diagnosis contains every unresolved finding and no agent invocation occurred.
- Cancellation during an adjudication wait preserves resumable state.
- Prior art: existing escalation, resumption, and cancellation orchestration tests.

## Out of Scope

- Cleaner, hardener, and remediator roles themselves (PRDs 5-6); this PRD only makes the escalation mechanism ready for them.
- Prompt envelope machinery (PRD 3); the generator prompt gains only the escalation instruction.
- Any UI beyond artifacts and run-summary lines.
- Changing GH issue state from inside the run (protected-issue handling stays with babysit tooling).

## Further Notes

Full session record: `docs/specs/afk-v2-agent-roles.md` (mechanism M4). Kills the STUCK deadlock class observed in run-20260824-174249. Depends on PRD 1 (finding schema, states, lock gate). The babysit skill lives outside this repository; courier duties are a manual follow-up (#94, after #89), and relocation (story 14) is deferred — it is not part of this PRD's definition of done.



## Post-wave-3 alignment note (2026-08-28)

- ADR 0048 (merged, PR #128) owns the QA-side scope amendment. Slice S1 (#80) is the generator-side escalation only and reuses the ADR 0048 machinery's vocabulary; it must not build a parallel scope-amendment path.
- #94 is rescoped to a manual courier-only follow-up after #89 (it edits a skill file outside this repository, unreachable from an AFK slice's repo-relative file scope). The AFK slices of this PRD are #80, #81, #82 and #89.

## Slice 06 excision note (2026-08-31)

Story 17 (`afk adopt`) and slice 06 (#129) were moved to
`.kiro/specs/afk-v2-run-state-lock-and-adoption/`. Stories 1-16 keep their
numbers — the plan's deferral references story 14 by number, and the new PRD
carries story 17 under its own numbering.

`afk adopt` blocked the post-implementation guardian gate in three consecutive
rounds. The last finding (architect A1, round 6) requires a cross-process lock
shared by *every* run-state writer, not just adoption's. That is a
persistence-layer decision, so it belongs to its own PRD rather than to routing
and adjudication. `afk adopt` is an operator bypass valve and nothing else in
this PRD depends on it, so the four remaining AFK slices ship without it and
the `adopt` code is not in this PRD's branch.

Consequently ADR 0053 and ADR 0055 §8 and §11 describe code that is not in the
tree. Each now carries a banner saying so and pointing at the new PRD.

