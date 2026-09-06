# Slice Contract — Envelope parity and evidence completeness

**Parent PRD:** .kiro/specs/afk-v2-context-envelopes/prd.md
**GH issue:** #99
**Status:** LOCKED

**Lock-Provenance:** focused-scope-revision round 3

**Negotiation round:** 3

## Scope lock

Deliver one provider-independent, versioned, budgeted envelope path for every PRD 3 role (explorer, planner, contract evaluator, generator), with deterministic stub parity and per-invocation evidence aggregated in run summaries (GH #99; PRD Solution and Testing Decisions).

### In scope

- [behavior:B-01] A full stub pipeline routes every explorer, planner, contract-evaluator, and generator invocation through envelope assembly and records one role-attributed evidence event; no scoped role bypasses assembly (GH #99 AC1).
- [behavior:B-02] Given the same manifest version and artifact set through Kiro-, Claude-, and Codex-named stub adapters, the logical envelope has the same declared artifact classes and order and preserves behavior, gate, finding, and checkpoint IDs; adapter wrapper syntax may differ (GH #99 AC2 and Scope boundary; ADR 0002).
- [behavior:B-03] Repeated assembly with the same manifest version and artifact set returns byte-identical normalized prompt content and identical logical evidence (GH #99 AC3; PRD story 17).
- [behavior:B-04] Each scoped role manifest declares its accepted context classes and budget; supplying an undeclared context class fails as CONFIGURATION before provider invocation, without truncation or dispatch (GH #99 AC5; PRD fail-closed budgets).
- [behavior:B-05] Every completed scoped invocation records prompt bytes, ordered included artifact classes and IDs, omitted classes, manifest version, and any named token counts exposed by its provider (GH #99 What to build).
- [behavior:B-06] The run summary shows total assembled prompt bytes and exposed provider token counts for each slice and for the run (GH #99 AC4).

### Non-goals (explicit out-of-scope)

- Live Kiro/Claude/Codex invocation or a live-provider parity matrix (GH #99 Scope boundary).
- New envelopes or prompts for candidate/final evaluators, cleaner, hardener, remediator, or guardians (GH #99; PRD Out of Scope).
- Acceptance/scope gate execution or provider model, authentication, streaming, and wrapper redesign (PRD Out of Scope).
- A new checkpoint vocabulary; this slice preserves checkpoint IDs when present in declared artifacts (PRD story 15).

### Existing behavior to preserve

- [behavior:P-01] Over-budget required content still fails closed with measured actual/allowed bytes and is never silently truncated — `src/context-envelope.ts:assertEnvelopeBudget` (PRD Solution).
- [behavior:P-02] Initial and repair/revision envelopes retain their role-specific order and exclusions, including no prior conversation, other-role conversation, resolved findings, or passing raw logs — context manifest assemblers (PRD Solution and Implementation Decisions).
- [behavior:P-03] Generator assembly still supports the legacy direct-execution fallback when no explorer context artifact exists — `src/context-envelope.ts:assembleGeneratorEnvelope` (GH #99 additive scope; PRD focused assembly).
- [behavior:P-04] Run summaries retain existing status, rounds, branch, cost, tool-call and gate evidence, and both stable and per-run copies — `src/logger.ts:writeSummary` (GH #99 additive totals; ADR 0017).
- [behavior:P-05] `AgentProvider.invoke` remains the provider-agnostic dispatch seam and receives the assembled prompt unchanged; live adapter command syntax remains provider-owned — `src/agent-provider.ts:AgentProvider` (ADR 0002; GH #99 Scope boundary).

### Changes to existing behavior (only if the issue asks for it)

None.

## Files expected to change

- src/agent-provider.ts
- src/claude.ts
- src/claude.test.ts
- src/codex.ts
- src/codex.test.ts
- src/context-envelope.ts
- src/context-envelope.test.ts
- src/contract-prompt-orchestration.ts
- src/contract-prompt-orchestration.test.ts
- src/kiro.test.ts
- src/logger.ts
- src/logger.test.ts
- src/orchestrator.ts
- src/orchestrator.fixtures.ts
- src/orchestrator.test.ts
- src/resume-integration.test.ts
- src/run-events.ts

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)

- Extend logical envelope/run evidence with ordered included context classes and an optional string-keyed token-count map that preserves provider-exposed names; no new dependency or database schema.

## Test plan

- Given one existing full-pipeline stub fixture, when the four scoped roles run, then events cover every matching invocation and each provider receives its assembled prompt (`pnpm run test:heavy:orchestrator`).
- Given identical artifacts containing stable behavior/gate/finding/checkpoint IDs, when three provider-named stubs and repeated assembly consume them, then logical envelopes and evidence match and every ID remains visible (`pnpm vitest run src/context-envelope.test.ts`).
- Given any scoped manifest plus an undeclared context class or a one-byte-too-small budget, when assembly is attempted, then CONFIGURATION occurs before stub invocation and no content is truncated (`pnpm vitest run src/context-envelope.test.ts src/contract-prompt-orchestration.test.ts`).
- Given completed explorer, planner, contract-evaluator, and generator invocations whose stub results expose named `input`, `output`, or `cacheRead` token counts in different combinations, when `events.jsonl` is read, then every invocation asserts exact prompt bytes, exact ordered included artifact classes and stable IDs, exact omitted classes, manifest version, and the exact value or absence of each named token count (`pnpm vitest run src/context-envelope.test.ts src/contract-prompt-orchestration.test.ts src/orchestrator.test.ts`).
- Given the existing resumed-generator fixture includes file scope, migration reservation, repair situation, fresh handoff, contract view, acceptance manifest, verification command, patterns/harness, and failure set, when its prompt-assembly evidence is read, then the exact artifact class/ID pairs appear in that prompt order (`pnpm vitest run src/resume-integration.test.ts`).
- Given two slices with exact prompt-byte values, `input` and `output` counts present on only some invocations, and `cacheRead` absent everywhere, when `writeSummary` runs, then exact per-slice and run prompt/token totals appear, unavailable names are absent rather than synthesized at both levels, and existing summary fields plus stable/per-run copies remain (`pnpm vitest run src/logger.test.ts src/orchestrator.test.ts`).
- Given ordered role markers and forbidden prior-conversation, other-role-conversation, resolved-finding, and passing-raw-log markers supplied to applicable initial and revision/repair assembly inputs, when envelope tests run, then each prompt preserves its manifest order and excludes every forbidden marker (`pnpm vitest run src/context-envelope.test.ts`).
- Given the legacy no-context generator path, when it assembles, then the fallback prompt remains valid and measured (`pnpm vitest run src/context-envelope.test.ts`).
- Given one exact assembled-prompt marker, when provider command-shape tests invoke the common seam, then Kiro preserves it as the final CLI argument while Claude and Codex preserve it byte-for-byte on stdin, with each adapter's existing command flags and wrapping unchanged (`pnpm vitest run src/kiro.test.ts src/claude.test.ts src/codex.test.ts`).
- Given the completed slice, when evaluator verification runs, then execute `pnpm run typecheck`, `pnpm test:fast`, `pnpm run test:heavy:orchestrator`, and the issue-mandated `pnpm run test:heavy:wave`.

## Definition of done

- [ ] The four scoped roles have no unassembled stub-provider dispatch.
- [ ] Parity, determinism, stable-ID preservation, and undeclared-class rejection are executable assertions.
- [ ] Per-invocation evidence and slice/run totals expose the fields required by GH #99 without removing existing evidence.
