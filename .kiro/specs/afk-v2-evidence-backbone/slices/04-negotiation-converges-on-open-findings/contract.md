# Slice Contract — Negotiation Converges on Open Findings

**Parent PRD:** .kiro/specs/afk-v2-evidence-backbone/prd.md
**GH issue:** #78
**Status:** LOCKED
**Negotiation round:** 4

## Scope lock
Deliver a two-round, code-tracked contract negotiation in which only open findings reach round 2, planner positions and evaluator dispositions form a validated lifecycle, and exhaustion records distinguish impasse from non-convergence (GH #78; PRD stories 7-11, 16, 20).

### In scope
- Route exactly round 1's `OPEN` findings and clear-conditions to the round-2 planner; exclude terminal findings and prior feedback prose (GH #78 AC1; agent-roles M3).
- Before invoking the round-2 planner, delete the working `contract-response.json`; afterward, require one fresh, valid position per routed ID before invoking the evaluator: unresolved, condition met with evidence, or contested with evidence (GH #78 AC1, AC3; PRD stories 3, 8, 10).
- Require the evaluator to disposition every routed ID exactly once, judge claimed clear-conditions, and preserve contested evidence (GH #78 AC2-3; agent-roles M3).
- Reject terminal-state reactivation and fresh round-2 findings without an exact citation to revision-changed contract or manifest text (GH #78 AC2, AC4).
- Archive every evaluator attempt with code-derived lifecycle and unresolved identity (PRD story 16).
- At round-2 exhaustion, classify a held BLOCKING contest as `IMPASSE`; otherwise classify remaining BLOCKING open findings as `NON_CONVERGENCE` (GH #78 AC5).
- Enforce at most two planner rounds with unchanged evaluator-invocation accounting (GH #78 AC6; agent-roles contract evaluator).

### Non-goals (explicit out-of-scope)
- Human adjudication or PRD 2 escalation routing; both exhaustion classes use today's escalation path (GH #78; PRD out of scope).
- Gate execution, role-context manifests, new judging roles, or removal of markdown companions (PRD out of scope).
- Changes to migrations, lock gates, lanes, waves, generation, QA, resumption, cancellation, or merge semantics (PRD implementation decisions; ADR 0028).

### Existing behavior to preserve
- Duplicate-key-aware exact JSON parsing and fail-closed artifact handling — `src/contract-review.ts:parseContractReview`.
- ADVISORY findings alone never force REVISE or exhaustion — `src/contract-review.ts:ContractFindingSeverity`.
- Stale working reviews are deleted and every evaluator attempt is archived — `src/orchestrator.ts:runSliceNegotiate`, `src/artifacts.ts:archiveContractReviewAttempt`.
- Markdown remains human-only, and the orchestrator alone changes contract status — `prompts/evaluator-contract.md`, `src/orchestrator.ts:runSliceNegotiate`.
- Contract-lock refusals consume the existing budget and escalate without generation — `src/orchestrator.ts:runSliceNegotiate`, ADR 0028.

### Changes to existing behavior (only if the issue asks for it)
- Round 2 replaces all-findings/prose routing with an exact open set: "contains exactly the open findings" (GH #78 AC1).
- Verdict consistency uses active BLOCKING states, while terminal BLOCKING records remain as reconciliation evidence (GH #78 "finding lifecycle module").
- Default-three-plus-extension becomes a hard cap: "Max negotiation rounds remains 2" (GH #78 AC6).

## Files expected to change
- src/contract-review.ts
- src/contract-review.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/artifacts.ts
- src/artifacts.test.ts
- src/test-support.ts
- src/cli-options.ts
- src/cli-options.test.ts
- src/wave-migrations.test.ts
- prompts/planner.md
- prompts/evaluator-contract.md
- agents/planner.md
- agents/evaluator.md

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- Planner owns `contract-response.json` v1: exactly `{version:1,round:2,responses:[{findingId,position:"UNRESOLVED"|"CONDITION_MET"|"CONTESTED",evidence}]}`. The orchestrator deletes this working file immediately before the round-2 planner invocation, then fails closed before evaluator invocation if the fresh file is missing, malformed, has duplicate IDs, or its IDs differ from the routed set. Evidence is non-blank for `CONDITION_MET` and `CONTESTED`.
- Evaluator owns `contract-review.json` v2: each finding retains the v1 fields and adds `state:"OPEN"|"RESOLVED"|"CONTESTED"|"WITHDRAWN"` plus `revisionCitation:null|{artifact:"contract.md"|"acceptance-manifest.json",before,after}`.
- Round 1 findings are `OPEN`. In round 2, `UNRESOLVED` permits `OPEN`; `CONDITION_MET` permits `OPEN` when the evaluator judges the clear-condition unmet or `RESOLVED` when met; `CONTESTED` permits `CONTESTED` (held) or `WITHDRAWN`. Terminal states cannot reactivate.
- The round-2 review contains every routed ID exactly once. Its only additional IDs are fresh `OPEN` findings whose unequal before/after excerpts exactly match prior/current artifacts; familiar IDs use `revisionCitation:null`.
- `ACCEPT` requires zero BLOCKING findings in active states (`OPEN`/`CONTESTED`); `REVISE` requires at least one. BLOCKING `RESOLVED`/`WITHDRAWN` records are terminal evidence and do not force REVISE.
- Orchestrator archives raw artifacts plus a versioned attempt record containing each finding's ID, severity, state, derived unresolved flag, and both parties' evidence. Exhaustion writes a versioned `IMPASSE` or `NON_CONVERGENCE` outcome from those records; `stuck.md` renders it. No new dependency or database schema.

## Test plan
- Given mixed round-1 findings, when round 2 starts, then planner input and the freshly written response IDs equal the `OPEN` set and contain clear-conditions but no prior prose.
- Given a valid stale `contract-response.json` and a round-2 planner that writes no response, when round 2 starts, then the stale file is deleted, missing fresh output fails closed, and the evaluator is not invoked.
- Given a planner claims `CONDITION_MET`, when the evaluator observes it unmet, then `OPEN` is valid and exhaustion is non-convergence; when observably met, `RESOLVED` permits ACCEPT and later reactivation of that ID fails closed.
- Given routed IDs, when the evaluator omits or duplicates one, then artifact validation fails; a citation-valid fresh ID is the only permitted addition.
- Given a contested planner position, when evaluated, then only `CONTESTED` or `WITHDRAWN` validates and archives preserve both evidences.
- Given terminal BLOCKING records and no active blocker, when reviewed, then ACCEPT validates; given any active BLOCKING record, only REVISE validates.
- Given a fresh round-2 ID, when its citation is absent, unchanged, or mismatched to the prior/current artifact, then validation fails before another planner invocation.
- Given round-2 exhaustion, when a BLOCKING contest is held, then the outcome is IMPASSE with both positions; otherwise an active BLOCKING finding produces NON_CONVERGENCE.
- Given repeated REVISE, a configured cap above two, or an ADR 0028 lock refusal, when negotiation runs, then no third planner round or extension occurs and existing lock-refusal accounting remains observable.
- Given the implementation, when the evaluator runs `pnpm vitest run src/contract-review.test.ts src/cli-options.test.ts src/artifacts.test.ts`, `pnpm test:fast`, `pnpm run test:heavy:orchestrator`, and `pnpm run test:heavy:wave`, then each exits successfully.

## Definition of done
- [ ] Both canonical agent artifacts reject malformed shape, duplicate IDs, illegal transitions, terminal reactivation, invalid citations, and incomplete routed dispositions; stale or missing planner output cannot reach the evaluator.
- [ ] Round-2 input, attempt archives, and exhaustion output expose the exact lifecycle, position, evidence, and unresolved identity defined above.
- [ ] Active-state verdict consistency, rejected and accepted resolution claims, both contest dispositions, and both exhaustion classes are observable.
- [ ] No negotiation path or accepted configuration exceeds two planner rounds; ADR 0028 refusal accounting remains intact.
