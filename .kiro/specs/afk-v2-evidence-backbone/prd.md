# PRD 1: Evidence backbone - finding schema, machine manifest, lock validation

**GH issue:** #69
**Parent design:** `docs/specs/afk-v2-agent-roles.md` (mechanisms M1, M3)
**Parent spec:** `docs/specs/afk-deterministic-quality-gauntlet.md` (delivery items 1, 4-5)

## Problem Statement

AFK's control-plane facts live in prose. The orchestrator parses verdict marker lines, gap counts, and file lists out of markdown that agents write free-form. This permissive parsing tolerates duplicate and contradictory states; findings have no identity, so each retry round asks an agent to re-read every preserved report and mentally reconcile which findings a later report cleared; and the run cannot mechanically count gaps, detect re-raised objections, or compute an unresolved set.

Observed consequences in run-20260824-174249: a resumed generator round "cleared" the only open finding in prose, committing nothing but a docs file; QA self-reported counts; and a slice locked with a file list that later stranded it, because nothing validated the declaration at lock time.

## Solution

One evidence backbone, all deterministic:

- An **acceptance manifest** - a structured, versioned, schema-validated artifact beside the prose slice contract. It carries everything the orchestrator parses: behaviors (stable behavior ID, source citation, Given/When/Then, observable result, preservation flag, one or more configured gate IDs), the declared file scope, and the migration count. `contract.md` stays prose that no parser touches: the judged artifact for agents and the babysit agent.
- One **finding schema** shared by every judging role: ID, severity, behavior IDs touched, evidence, expected (quoted), observed, and a clear-condition - the observable change that resolves the finding. Finding states OPEN / RESOLVED / CONTESTED / WITHDRAWN, tracked by code. Code counts findings, computes the unresolved set, and detects re-raises.
- **Canonical verdict artifacts** for contract review and slice QA, schema-validated, fail-closed. A favorable verdict cannot coexist with a blocking finding. Marker-line parsing leaves control flow; markdown remains a human-readable companion.
- A **deterministic lock gate** that runs before the contract evaluator is invoked: manifest schema validity, contract-manifest behavior coverage, gate-ID existence against the configured catalog, and concrete file scope (or an explicit no-repository-change declaration). A refusal returns to the planner without consuming an evaluator round - the same pattern as the existing contract-lock migration prefix gate (ADR 0028).

## User Stories

1. As a run operator, I want reviewer verdicts validated as one coherent versioned artifact, so that duplicate or contradictory verdict fields cannot pass.
2. As a run operator, I want PASS to mechanically require no blocking finding, so that report invariants do not depend on agent honesty.
3. As a run operator, I want malformed or missing canonical artifacts to fail closed, so that prose formatting accidents cannot advance a slice.
4. As a planner agent, I want every in-scope behavior mapped to a stable behavior ID with an executable gate binding, so that "done" is falsifiable.
5. As a planner agent, I want an explicit no-repository-change declaration, so that empty scope is distinct from unknown scope.
6. As a contract evaluator, I want the configured gate catalog as input, so that I can judge whether a gate binding would actually prove its behavior.
7. As a contract evaluator, I want every REVISE finding to carry a clear-condition, so that the planner knows exactly what resolves it.
8. As a planner agent, I want to answer a finding with CONTESTED plus evidence, so that I can advocate instead of blindly complying.
9. As a contract evaluator, I want to be bound by my own stated clear-conditions, so that goalposts cannot move between rounds.
10. As a generator agent, I want the orchestrator to compute my unresolved finding set, so that I never reconcile prior reports myself.
11. As a run operator, I want re-raised findings detected by code via finding IDs, so that agent-counted metadata (`GAPS:`, `RE_RAISED_GAPS:`) disappears.
12. As a run operator, I want undeclared, placeholder, or empty file scope to be unable to lock, so that unsafe parallel lanes cannot form from uncertainty.
13. As a run operator, I want lock-gate refusals returned to the planner without consuming an evaluator round, so that mechanical failures never burn judgment rounds.
14. As a maintainer, I want every machine-read field out of prose, so that a prompt edit can never weaken enforcement.
15. As a maintainer, I want lane partitioning, the contract-lock gates, and future scope enforcement to read the same normalized declaration, so that there is one source of truth for scope.
16. As a maintainer, I want every review attempt archived with resolved/unresolved identification, so that later attempts never erase earlier evidence.
17. As a babysit agent, I want structured artifact state instead of agent prose, so that diagnosis reads facts.
18. As a maintainer, I want artifact schemas versioned, so that evolution is explicit and old runs stay interpretable.
19. As a run operator, I want migration counts declared in the manifest, so that migration claims bind to a validated field instead of a prose line.
20. As a run operator, I want round 2+ contract review scoped to open findings plus revision-caused defects, so that negotiation converges instead of re-litigating approved sections.

## Implementation Decisions

- The acceptance manifest is a separate structured file beside the prose contract; the planner emits both. The lock check validates their consistency: every in-scope contract behavior appears in the manifest with at least one gate ID.
- The behavior-ID thread is established here as an obligation format only; gate execution against behavior IDs arrives in PRD 4 (#72). Gate IDs are validated against the configured gate catalog (or the derived baseline command set when no policy exists).
- Finding lifecycle: OPEN, RESOLVED (clear-condition met), CONTESTED (planner argues with evidence), WITHDRAWN (judge concedes). A CONTESTED finding still held at round exhaustion is an impasse (routing arrives in PRD 2 (#70); here it terminates as today's escalation, with both positions recorded).
- The contract evaluator's prompt sheds mechanical checks and self-counts; it judges scenario honesty, gate-binding aptness, single-session feasibility, file-scope plausibility against explorer evidence, and blocking UNKNOWNs. Max negotiation rounds stays 2.
- New-finding rule for revision rounds: a new finding must cite text the revision changed. A gap missed in round 1 locks - accepted trade for convergence; the downstream net still exists.
- The migration reservation and claim flow is unchanged; only the declaration field moves into the manifest.
- Existing DAG, wave, lane, narrowed-invocation, resumption, cancellation, MERGE-PENDING, and blocked-ship semantics are preserved.

## Testing Decisions

- Primary seam: the existing full-pipeline filesystem contract - real temporary git repository, real DAG, real orchestrator, stub agent provider. Stub agents deliberately write malformed, contradictory, duplicate, and dishonest artifacts; tests assert the slice does not advance and the failure is attributed correctly.
- Focused module tests for the manifest parser, finding-schema validator, and lock gate as pure functions: every contradictory or malformed combination, coverage validation, undefined gate IDs, duplicate behavior IDs, placeholder scope, explicit no-change scope.
- Assert externally observable behavior only: artifacts on disk, run events, run state, round consumption, terminal outcomes. No mocking of internal call sequences.
- Prior art: existing artifact-parsing tests and contract-negotiation orchestration tests.

## Out of Scope

- Executing acceptance gates or the coverage gate (PRD 4, #72).
- The escalation/adjudication routing machinery (PRD 2, #70) - impasses terminate as today's escalation for now.
- Role context manifests and prompt assembly (PRD 3, #71); prompts change only where self-counts and reconciliation instructions are deleted.
- New roles (candidate/final evaluator, cleaner, hardener, remediator).
- Removing existing markdown reports - they remain human-readable companions.
