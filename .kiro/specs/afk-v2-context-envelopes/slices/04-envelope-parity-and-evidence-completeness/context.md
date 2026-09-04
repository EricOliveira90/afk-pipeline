## Files and current behavior

### Governing scope

- GH issue #99 requires every PRD 3 in-scope invocation to use a versioned, budgeted, provider-independent envelope; stub fixtures must preserve artifact classes, order, and stable behavior, gate, finding, and checkpoint IDs; every invocation must record size evidence; run summaries must aggregate it; undeclared context classes must fail configuration (`gh issue view 99`).
- PRD 3 defines the manifest fields as objective, non-goals, write scope, stop/escalation conditions, accepted input artifact classes, output artifact, input order, and inline-size budget. It also requires prompt size, included artifact IDs, omitted classes, manifest version, and provider token counts when exposed (`.kiro/specs/afk-v2-context-envelopes/prd.md:13-22`).
- The four currently implemented PRD 3 manifests are explorer, planner, contract evaluator, and generator; new candidate/final evaluator and other later-role prompts are deferred (`docs/specs/afk-v2-agent-roles.md:167`, `docs/specs/afk-v2-agent-roles.md:226`, `docs/specs/afk-v2-agent-roles.md:259`, `docs/specs/afk-v2-agent-roles.md:294`, `.kiro/specs/afk-v2-context-envelopes/prd.md:65-69`).
- The public envelope contract includes allowlists, exclusions, ordering, stable-ID preservation, fresh invocation state, size evidence, and fail-closed budgets (`.kiro/specs/afk-v2-context-envelopes/prd.md:58-63`).

### Envelope assembly

- `src/context-envelope.ts` is the provider-independent assembly module. It exports version-1 manifests and assembly functions for explorer, planner initial/revision, contract evaluator initial/revision, and generator initial/repair (`src/context-envelope.ts:31-55`, `src/context-envelope.ts:100-144`, `src/context-envelope.ts:384-490`, symbols `assembleExplorerEnvelope`, `assemblePlannerInitialEnvelope`, `assemblePlannerRevisionEnvelope`, `assembleContractEvaluatorInitialEnvelope`, `assembleContractEvaluatorRevisionEnvelope`, `assembleGeneratorEnvelope`).
- `PromptAssemblyRole` currently admits only `explorer`, `planner`, `evaluator-contract`, and `generator`; `RoleEnvelopeEvidence` carries role, UTF-8 byte size, included artifact IDs, omitted artifact classes, and manifest version (`src/context-envelope.ts:492-508`).
- Planner and contract-evaluator assembly normalizes CRLF/CR to LF before measuring and returning the prompt. All role assemblers fail closed when the prompt exceeds the effective byte budget (`src/context-envelope.ts:560-597`, `src/context-envelope.ts:806-875`).
- Explorer assembly derives a sorted ADR index and optional `ARCHITECTURE.md` from the worktree, records their repository-relative IDs, renders `prompts/explorer.md`, and measures the rendered bytes (`src/context-envelope.ts:292-374`).
- Planner initial assembly includes the slice request, complete explorer evidence map, gate catalog, migration reservation, ADR index, and architecture body. Planner revision assembly instead includes the current contract pair, routed open findings, optional relevant resolved findings, control situation, gate catalog, and migration reservation (`src/context-envelope.ts:600-677`).
- Contract-evaluator initial assembly includes the proposed contract, acceptance manifest, gate catalog, and explorer context. Revision assembly additionally carries prior open findings, planner response, revision evidence, and optional control situation (`src/context-envelope.ts:679-756`).
- Generator assembly includes a projected contract view, the version-2 acceptance manifest, inline file scope, explorer `Patterns and test harness`, the test command, migration reservation, and the current failure set. Repair mode requires a repair situation (`src/context-envelope.ts:759-875`).
- Generator failure projection preserves finding IDs and gate IDs verbatim and carries only finding clear conditions/artifact references and gate evidence references (`src/context-envelope.ts:878-901`).
- Behavior IDs and their gate IDs travel in the acceptance manifest because planner/evaluator/generator assembly serializes the typed manifest with `JSON.stringify`; the manifest parser requires non-blank, unique gate IDs (`src/context-envelope.ts:687`, `src/context-envelope.ts:717-721`, `src/context-envelope.ts:825`, `src/acceptance-manifest.ts:137-186`).
- Template interpolation fails on a missing placeholder and on any supplied argument not declared by the template (`src/prompt-template.ts:7-34`).
- Manifests declare accepted artifact classes, but current assemblers construct included artifact IDs directly; no generic undeclared-context-class validator or configuration parser is present in `src/context-envelope.ts` (`src/context-envelope.ts:403-414`, `src/context-envelope.ts:457-465`, `src/context-envelope.ts:600-755`; command `rg -n "undeclared|acceptedInputArtifactClasses|context class" src`).

### Invocation routing and evidence

- Planner and contract-evaluator prompts pass through `src/contract-prompt-orchestration.ts`, whose `recordPromptAssembly` appends a typed `prompt-assembly` event before returning the prompt (`src/contract-prompt-orchestration.ts:20-27`, `src/contract-prompt-orchestration.ts:77-122`).
- Generator assembly is followed by an explicit `prompt-assembly` journal event before `provider.invoke`; the provider receives `assembled.prompt` unchanged through the common `AgentProvider.invoke` interface (`src/orchestrator.ts:4614-4669`, `src/agent-provider.ts:118-130`).
- Explorer uses `assembleExplorerEnvelope` and invokes the provider with `assembled.prompt`, but the current path records only `phase-started` and `phase-ended`; it does not append `assembled.evidence` as a `prompt-assembly` event (`src/orchestrator.ts:2740-2775`).
- The event schema already defines `prompt-assembly` with issue, slice, round, role, byte size, included IDs, omitted classes, and manifest version (`src/run-events.ts:89-98`). Events are JSONL records under the per-run directory and the reader skips torn/malformed lines (`src/run-events.ts:261-297`).
- The current full-pipeline stub assertion expects seven assembly events for planner, contract evaluator, and generator only; the same fixture separately proves evaluator QA runs but does not expect its prompt evidence (`src/orchestrator.test.ts:2251-2306`).
- Existing deterministic QA/UAT invocation still renders `prompts/evaluator-qa.md` directly inside the orchestrator. PRD 3 defers candidate/final evaluator prompt redesign, so this path is outside the four implemented PRD 3 role manifests (`src/orchestrator.ts:3994-4019`, `.kiro/specs/afk-v2-context-envelopes/prd.md:65-69`).

### Run summary and provider statistics

- `Logger.addInvocationStats` currently aggregates only `costUsd` and `toolCallCount` by slice (`src/logger.ts:21-25`, `src/logger.ts:124-135`).
- `InvocationStats` exposes only optional cost and tool-call count; there is no provider token-count field in the current provider result contract (`src/agent-provider.ts:103-116`).
- `Logger.writeSummary` reads only `gate-outcome` events, renders per-slice and run cost/tool totals, and has no prompt-size, artifact, omission, manifest-version, or token-count totals (`src/logger.ts:213-275`, `src/logger.ts:319-345`).

## Patterns and test harness

### Existing focused tests

- `src/context-envelope.test.ts` is the unit seam for manifest contents, inclusion/exclusion, ordering, deterministic repeated assembly, stable projections, line-ending normalization, and one-byte-under-budget failures. Repeated planner/evaluator assembly compares prompt bytes and evidence objects exactly (`src/context-envelope.test.ts:560-615`); generator repeated assembly does the same (`src/context-envelope.test.ts:890-892`).
- No existing focused test compares logical envelope contents across multiple provider adapters; current parity evidence stops at provider-independent assembler determinism and stub prompt capture (`src/context-envelope.test.ts:560-615`, `src/orchestrator.fixtures.ts:311-361`; command `rg -n -i "provider.*parity|parity.*provider" src`).
- `src/contract-prompt-orchestration.test.ts` verifies planner and contract-evaluator prompts are assembled and journaled behind one seam (`src/contract-prompt-orchestration.test.ts:43-88`).
- `src/orchestrator.test.ts` contains the existing spawned full-pipeline fixture that records provider prompts and prompt-assembly events; its `B-06` assertion is the closest existing scenario for issue #99's no-bypass requirement (`src/orchestrator.test.ts:2251-2306`).
- `src/resume-integration.test.ts` already inspects generator `includedArtifactIds` for resumed handoff and STUCK evidence, so resume evidence behavior has an existing fixture (`src/resume-integration.test.ts:447-458`, `src/resume-integration.test.ts:750-758`).
- Stub providers implement the same `AgentProvider` seam as live adapters. The orchestrator stub records the exact `InvokeOptions.prompt` it receives, while the wave stub records invocation order (`src/orchestrator.fixtures.ts:311-361`, `src/wave.fixtures.ts:223-243`).
- `src/prompt-template.test.ts` owns placeholder-contract tests; it already covers missing values, numeric values, and role-template argument boundaries (`src/prompt-template.test.ts:10-75`, `src/prompt-template.ts:11-34`).
- `src/logger.test.ts` owns `events.jsonl` and summary formatting behavior (`src/logger.test.ts:407-483`).

### Commands and blast radius

- The focused unit loop is `pnpm vitest run src/context-envelope.test.ts`, with `src/contract-prompt-orchestration.test.ts`, `src/logger.test.ts`, or `src/prompt-template.test.ts` added when their seams change (repository test discipline in `AGENTS.md`; test files above).
- `pnpm test:fast` excludes orchestrator, wave, resume-integration, resume-worktree, and QA orchestration suites (`package.json:24-31`).
- Issue #99 explicitly requires `pnpm run test:heavy:wave`; if `src/orchestrator.ts` changes it also requires `pnpm run test:heavy:orchestrator` (`gh issue view 99`).
- The AFK slice handoff gate is `pnpm typecheck && pnpm test:fast` plus touched heavy suites, not the full suite (repository test discipline in `AGENTS.md`; `package.json:24-35`).
- Likely test/config blast radius is `src/context-envelope.test.ts`, `src/contract-prompt-orchestration.test.ts`, `src/orchestrator.test.ts`, `src/orchestrator-runs.test.ts`, `src/wave.test.ts`, `src/wave-migrations.test.ts`, `src/resume-integration.test.ts`, `src/logger.test.ts`, and `src/prompt-template.test.ts`, because those files own assembly, full-pipeline stub dispatch, wave execution, resume evidence, event persistence, and summary rendering (symbols and fixtures cited above).

### Recent integration history

- Slice #95 introduced negotiation manifests and assembly, event recording, line-ending normalization, and the extracted prompt-orchestration seam in commits `ba7d1af`, `37ed9c1`, `8a78f06`, and `e5879e1` (`git log --oneline -- src/context-envelope.ts src/contract-prompt-orchestration.ts src/run-events.ts src/orchestrator.ts prompts`).
- Subsequent host integration restored generator failure-set handling, legacy direct execution without explorer context, and compact shared-preview repair context in commits `723b8a5`, `a9fec39`, and `991f2ee` (`git show --stat --oneline 723b8a5 a9fec39 991f2ee`).
- The two latest branch integrations, commits `4cffbe6` and `0945efb`, both recorded conflicts in `src/orchestrator.ts`; this is the active conflict hotspot for envelope routing (`git show --format=fuller --no-patch 0945efb 4cffbe6`).

## Data and integration

### Current shapes

- `RoleEnvelopeResult` is `{ prompt, evidence }`; evidence is the logical provider-independent record, while provider adapters consume only the prompt through `InvokeOptions` (`src/context-envelope.ts:498-509`, `src/agent-provider.ts:125-130`).
- `prompt-assembly` is a run event, not persisted slice state. Its current identity is issue + slice number + round + role; it has no invocation-attempt ID or provider name (`src/run-events.ts:89-98`).
- Per-role budget overrides are optional `RunPipelineConfig` fields for generator, explorer, planner, and contract evaluator (`src/orchestrator.ts:448-464`).
- The stable and per-run summaries are both generated by `Logger.writeSummary`; the stable copy is overwritten each run and the per-run copy is best-effort (`src/logger.ts:337-345`).

### Integration seams

- `src/context-envelope.ts` owns manifests, deterministic projections, byte measurement, and fail-closed assembly.
- `src/contract-prompt-orchestration.ts` owns planner/evaluator assembly plus event recording; explorer and generator currently record through separate orchestrator paths (`src/contract-prompt-orchestration.ts:77-122`, `src/orchestrator.ts:2740-2775`, `src/orchestrator.ts:4653-4659`).
- `src/run-events.ts` owns the event payload schema; `src/run-journal.ts` appends events; `src/logger.ts` is the existing run-summary consumer (`src/run-events.ts:30-98`, `src/run-journal.ts:104-110`, `src/logger.ts:228-275`).
- `AgentProvider.invoke` is the provider boundary. Existing branch and provider identity is outside envelope assembly, so parity fixtures can compare the prompt/evidence delivered before adapter execution (`src/agent-provider.ts:118-130`, ADR 0002 at `docs/adr/0002-agent-provider-interface.md`).

## Unknowns

- Do existing `evaluator-qa` and `evaluator-uat` invocations count as “in-scope” for #99? PRD 3 defers new candidate/final evaluator prompts, while the current pipeline still invokes the legacy QA template directly (`.kiro/specs/afk-v2-context-envelopes/prd.md:51`, `.kiro/specs/afk-v2-context-envelopes/prd.md:65-69`, `src/orchestrator.ts:3994-4019`).
- Does “provider token counts when exposed” require separate input/output/cache token fields, or one provider-reported total? The issue and PRD name token counts, but `InvocationStats` currently defines no token vocabulary (`gh issue view 99`, `.kiro/specs/afk-v2-context-envelopes/prd.md:20`, `src/agent-provider.ts:103-116`).
- What canonical checkpoint ID is in scope for the four PRD 3 roles? The current assembly manifests and `prompt-assembly` event have no checkpoint field, while checkpoint placeholders appear in later evaluator/guardian role specifications (`src/context-envelope.ts:31-179`, `src/run-events.ts:89-98`, `docs/specs/afk-v2-agent-roles.md:416`, `docs/specs/afk-v2-agent-roles.md:589`, `docs/specs/afk-v2-agent-roles.md:667`).
- Should repeated infrastructure attempts each emit a separate assembly event, or should one assembly record cover all retries that reuse byte-identical prompt content? Current planner/evaluator assembly happens before `invokeAgent`'s retry loop, while issue #99 says evidence is recorded for every invocation (`src/orchestrator.ts:2670-2709`, `src/orchestrator.ts:3026-3069`, `src/orchestrator.ts:3225-3249`, `gh issue view 99`).
