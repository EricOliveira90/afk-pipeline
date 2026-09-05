# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `c16c7b7ebe5e7844301c45344df738fedcdfa9fd` against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, all slice contracts and handoffs, `ARCHITECTURE.md`, and the cited ADRs. I accepted the recorded pre-ship gate result and did not rerun the full suite. Narrow verification passed for `src/related-gates.test.ts` (5 tests) and the focused QA-convergence test for overlapping resolved constraints.

## FIX-BEFORE-SHIP

### A1 — Automatic related suites run before candidate QA, outside the approved early-delivery boundary

- **Convention:** ADR 0012, “Amendment (2026-09-02) — candidate QA precedes the full slice suite,” requires dependency preparation plus typecheck/lint, then candidate QA, then the full slice suite. The same section explicitly says this early delivery does not add the policy-owned gate catalog or automatic `test:related` selection.
- **File and location:** `src/orchestrator.ts`, `runSliceExecute`, lines 4884–4917 and 4934–4944; `src/related-gates.ts`; `afk.config.json`, related-gate declarations.
- **Evidence:** I read the gate-selection and candidate-gate control flow and ran `pnpm vitest run src/related-gates.test.ts`; all five tests passed, confirming changed/locked paths select the configured related declarations. Those declarations are appended to `preQaDeclarations`, which `runCandidateGatePhase` executes before the evaluator at line 5062. The repository policy maps source changes to `test:fast` and heavy suites, so a candidate can pay those suites before product QA rejects it.
- **Attribution:** Commit `183ddac9` (`harden-afk-before-prd3-relaunch`), which is not in the reviewed base, added the selection block and the `...relatedDeclarations` pre-QA append.
- **Required correction:** Keep the PRD 3 sequence at cheap typecheck/lint → candidate QA → full suite. Move automatic related-policy selection to its PRD 4-owned stage or obtain and record an explicit architecture decision that supersedes ADR 0012.

### A2 — The new repair-envelope boundary still admits resolved QA findings

- **Convention:** `ARCHITECTURE.md`, “Modules > Prompts,” identifies assembled envelopes as the PRD 3 replacement for raw prompt construction. The PRD’s focused-envelope contract excludes resolved findings, and slice 04 behavior P-02 repeats that exclusion for repair/revision envelopes.
- **File and location:** `src/orchestrator.ts`, `repairSituation` assembly at lines 4609–4665 and deterministic retry construction at lines 5118–5126; `src/qa-convergence.ts`, `formatQAGeneratorContext` at lines 295–358; `src/context-envelope.ts`, `assembleGeneratorEnvelope` at lines 941–987.
- **Evidence:** I traced a deterministic QA failure into `generatorFailureSet`, then separately into `retryNote`. `formatQAGeneratorContext` selects overlapping `relevantResolved` entries and renders the heading “Relevant resolved QA findings”; `repairSituation` appends that text and `assembleGeneratorEnvelope` inserts it through `REPAIR_SITUATION`, bypassing the focused failure-set projection. `src/qa-orchestration.test.ts:1665–1684` currently asserts that resolved IDs remain in later generator prompts. The focused QA-convergence test also passed and confirmed the formatter deliberately returns overlapping resolved entries.
- **Attribution:** The old formatter predates this branch, but the reviewed diff materially changes the authority boundary: commit `162c9469` introduced the assembled repair path, commit `74e5b9d5` routed `retryNote` into its generic situation block, and the new `context-envelope.ts` renders that block beside the scoped failure set. This is changed control flow in the reviewed diff, not merely reachability of base behavior.
- **Required correction:** Build repair prompts from the current open finding/gate projection only. Resume/control-plane facts may remain in `repairSituation`, but resolved QA lineage must not enter that block or any other generator prompt input.

### A3 — The role-context manifest is metadata, not the authoritative role contract

- **Convention:** `ARCHITECTURE.md`, “Modules > Prompts,” assigns PRD 3 the assembled-envelope seam. The governing PRD requires each versioned manifest to declare objective, non-goals, write scope, stop and escalation conditions, accepted inputs, output, input order, and budget; its implementation decision permits project policy to make budgets stricter only. The parent plan also assigns PRD 3 the candidate-evaluator manifest entry.
- **File and location:** `src/context-envelope.ts`, `PromptAssemblyRole` at lines 514–518, `ContextEnvelopeManifest` at lines 539–545, `assembleContextEnvelope` at lines 619–655, and `EXPLORER_CONTEXT_MANIFEST` at lines 31–60; candidate QA still calls `renderPrompt("evaluator-qa", ...)` directly in `src/orchestrator.ts:4017–4024`.
- **Evidence:** The shared manifest type requires only version, role, accepted classes, budget, and omissions. Assembly validates only accepted classes and byte size; it cannot validate the declared objective, boundaries, stop/escalation rules, output contract, or input order. The version-1 explorer object itself omits non-goals and stop/escalation fields. `PromptAssemblyRole` has no candidate-evaluator entry, so the explicitly carried manifest entry does not exist. Finally, line 643 accepts an arbitrary invocation budget override, including a larger value; slice 01’s handoff documents that intentional relaxation even though policy is stricter-only.
- **Attribution:** Commits `4b076e13`, `ba7d1afd`, and `1032e301`, all outside the base, introduced the role objects, narrowed role union/interface, and generic assembler. The candidate-evaluator omission and relaxable budget are therefore properties of the abstraction introduced by this diff.
- **Required correction:** Make the manifest schema represent and validate the complete role contract, add the candidate-evaluator manifest entry without adding its deferred prompt, and enforce overrides as `min(projectBudget, manifestBudget)`. Prompt ordering and evidence should derive from that authoritative schema rather than parallel hand-maintained objects.

### A4 — The evidence seam cannot record the required per-invocation `nonCommandTime`

- **Convention:** ADR 0046, “Decision,” says durations are recorded per invocation at the journal seam and are evidence, never a gate. The PRD’s parent-plan declaration carries §3 item 13: per-invocation `nonCommandTime` as first-class evidence to score the envelope change and the candidate-evaluator rider.
- **File and location:** `src/agent-provider.ts`, `InvocationStats` and `ContextEnvelopeInvocationEvidence` at lines 113–130; `src/run-events.ts`, `prompt-assembly` event at lines 89–100.
- **Evidence:** I searched the source for `nonCommandTime`, non-command timing, and equivalent fields. The new invocation stats add token counts only, while prompt-assembly evidence records bytes, artifact classes/IDs, omissions, manifest version, and tokens. Existing `durationMs` fields describe gates or whole stages; none subtract command/tool execution time. Consequently the run journal cannot carry the metric that the plan uses to judge whether focused envelopes reduced reading work.
- **Attribution:** Commits `2fb0c11e`, `4fe5eb2d`, and `eb012b9f`, all outside the base, introduced or completed the invocation/prompt evidence seam without the carried metric.
- **Required correction:** Measure and record a clearly named per-invocation non-command duration in typed run evidence, with documented clock boundaries and no gating behavior.

## Non-blocking architecture notes

1. `src/orchestrator.ts` changes by +636/−376 lines. The two blockers above are examples of why `ARCHITECTURE.md`, “Hubs — do not grow these; extract instead,” requires one-call-site modules: repair-context policy and related-gate selection remain assembled in the dispatch loop. Extract those policies while correcting A1 and A2.
2. `InvokeOptions.contextEnvelope` is orchestration evidence that every provider intentionally ignores. ADR 0002 keeps `AgentProvider` as the provider dispatch seam; consider recording envelope evidence around invocation without adding ignored control-plane metadata to that provider contract.
