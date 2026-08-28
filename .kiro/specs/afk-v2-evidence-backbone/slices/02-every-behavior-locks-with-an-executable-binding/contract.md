# Slice Contract — Every Behavior Locks with an Executable Binding

**Parent PRD:** .kiro/specs/afk-v2-evidence-backbone/prd.md
**GH issue:** #76
**Status:** LOCKED
**Negotiation round:** 2

## Scope lock
This slice makes every anchored contract obligation machine-valid before review: version 2 manifests carry stable behavior evidence and executable baseline-gate bindings, deterministic refusals return to planning without invoking the evaluator, and valid artifacts give the evaluator the manifest and gate catalog (GH #76 "What to build" and AC1-6; PRD Solution and Implementation Decisions).

### In scope
- [behavior:B-01] A version 2 manifest requires a non-empty `behaviors` array; each exact-key behavior has non-blank string `id`, `source`, `given`, `when`, `then`, and `observableResult`, boolean `preservation`, and a non-empty unique list of non-blank string `gateIds`; behavior IDs are unique (GH #76 "What to build" and AC3; parent design M1).
- [behavior:B-02] Before review, every behavior anchor in `In scope` and `Existing behavior to preserve` has exactly one same-ID manifest entry; refusal reports the complete missing and duplicate anchor sets and ignores all non-anchor prose (GH #76 AC1 and explicit "contract-manifest behavior coverage").
- [behavior:B-03] Every `gateIds` value names a derived baseline catalog entry backed by a discovered command; refusal reports every unknown or non-executable ID (GH #76 AC2; PRD Implementation Decisions; quality-gauntlet baseline).
- [behavior:B-04] A complete, covered manifest reaches contract review, whose prompt includes that manifest and the derived gate catalog for scenario-honesty and binding-aptness judgment; ACCEPT follows the existing lock flow (GH #76 AC4; PRD US-6 and contract-evaluator decision).
- [behavior:B-05] Schema, coverage, binding, and stability refusals each consume one planner round, invoke no evaluator and create no evaluator feedback; when a round remains, the next planner prompt contains the mechanical objection (GH #76 AC5; PRD Solution; ADR 0028).
- [behavior:B-06] From one schema-valid planner output to the next, a behavior whose `source`, Given/When/Then, observable result, and preservation flag are unchanged retains its case-sensitive ID even if its gates change; renumbering is refused with old and new IDs (GH #76 AC6).

### Non-goals (explicit out-of-scope)
- Executing gates per behavior, matching behavior IDs to test names, or producing coverage results; PRD 4/#72 owns execution (PRD Implementation Decisions).
- Finding lifecycle, canonical verdicts, and convergence rules; slices #77-#79 own them (PRD Out of Scope; slice index).
- A quality-policy file, arbitrary planner commands, or changes to DAG, lane, migration, cancellation, MERGE-PENDING, blocked-ship, or generator semantics (GH #76; PRD Implementation Decisions).

### Existing behavior to preserve
- [behavior:P-01] Version 1 remains strictly parseable for archived evidence; normalized paths, explicit no-change scope, and migration-count validation remain available in version 2 — `src/acceptance-manifest.ts:parseAcceptanceManifest`.
- [behavior:P-02] Each planner round must produce a fresh manifest, and a prior LOCKED contract with an invalid manifest reopens fail-closed — `src/orchestrator.ts:runSliceNegotiate`.
- [behavior:P-03] Baseline gate IDs and commands remain derived from the pre-ship sanity plan — `src/orchestrator.ts:resolveBaseGateDeclarations`.
- [behavior:P-04] Orchestrator-owned status transitions, configured round caps, refusal events, and escalation artifacts remain intact — `src/orchestrator.ts:runSliceNegotiate`.
- [behavior:P-05] Manifest-driven lane scope and migration claims continue to consume normalized scope and migration count — slice 01 handoff.
- [behavior:P-06] Missing and unused prompt placeholders still fail rendering — `src/prompt-template.ts:renderPrompt`.

### Changes to existing behavior (only if the issue asks for it)
- Newly negotiated contracts require behavior-bearing manifest version 2; version 1 stays parseable but cannot pass the behavior lock gate, authorized by GH #76: "The acceptance manifest gains behaviors."

## Files expected to change
- src/acceptance-manifest.ts
- src/acceptance-manifest.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/prompt-template.test.ts
- src/migration-claims.test.ts
- src/resume-integration.test.ts
- src/wave.test.ts
- prompts/planner.md
- prompts/evaluator-contract.md

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- Manifest version 2 adds the B-01 `behaviors` schema; IDs are case-sensitive. Version 1 remains parseable. No new dependency.
- Sole exception to the PRD's no-`contract.md`-parser rule, authorized by GH #76's explicit deterministic coverage check and AC1: inside the exact `### In scope` and `### Existing behavior to preserve` sections, only lines matching `^- \[behavior:([A-Z][A-Z0-9-]*)\] .+$` are control anchors. A section ends at the next heading; duplicate anchors fail; every other character of the contract is ignored by code.

## Test plan
- Given a valid version 2 behavior, when `pnpm vitest run src/acceptance-manifest.test.ts` runs a table with root `behaviors` missing, object-valued, or empty; each of `id|source|given|when|then|observableResult` separately missing, numeric, or blank; `preservation` missing or string-valued; `gateIds` missing, string-valued, empty, containing a number or blank ID, or containing duplicates; an extra behavior key; and duplicate behavior IDs, then each case fails naming its exact field or duplicate ID, while valid versions 1 and 2 parse.
- Given anchors B-01, B-02, duplicate B-03, P-01, and P-02, a manifest containing B-01, B-03, and P-01, plus `B-DECOY` in ordinary prose and a non-controlled section, when the focused coverage test runs, then refusal reports missing `{B-02,P-02}` and duplicate `{B-03}` only; a separate negotiation omitting anchored preservation behavior P-03 refuses lock naming P-03.
- Given bindings `missing-gate` and `lint` where the temporary package has no lint command, when `pnpm vitest run src/orchestrator.test.ts` negotiates, then the pre-review refusal names both the unknown and non-executable IDs.
- Given `maxContractRounds: 3`, when parameterized negotiations keep schema, coverage, or binding invalid through rounds 1-3, or emit an invalid binding in round 1 and renumber the otherwise unchanged behavior in rounds 2 and 3, then planner calls equal three, prompts 2 and 3 contain the immediately prior objection (including stability in prompt 3), evaluator calls equal zero, and no `feedback-r*.md` exists.
- Given unchanged behavior evidence with the same ID and a complete manifest bound to a discovered command, when negotiation runs and the evaluator accepts, then its prompt contains the manifest and catalog ID/command, and the contract reaches LOCKED; changing only that ID instead refuses with both IDs.
- Given all manifest fixtures use valid behavior-bearing declarations, when `pnpm vitest run src/migration-claims.test.ts src/resume-integration.test.ts src/wave.test.ts` and `pnpm test:fast` run, then prior scope, migration, resume, wave, and prompt-placeholder outcomes remain unchanged.

## Definition of done
- [ ] Version 2 validation enforces every behavior field/type and unique behavior/gate IDs while version 1 remains interpretable.
- [ ] Exact contract anchors deterministically produce complete missing/duplicate coverage errors without parsing prose.
- [ ] Unknown/non-executable gates and unchanged-behavior renumbering refuse before review with identifying evidence.
- [ ] Every mechanical refusal spends planner rather than evaluator rounds and reaches the next planner prompt when available.
- [ ] A fully bound manifest and catalog reach the evaluator and can lock through the preserved flow.
