# Product Guardian Review — Slice 04

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed only slice 04, “Envelope parity and evidence completeness” (#99), against the parent PRD, slice index, locked contract, acceptance manifest, and implementation. Slices 01–03 did not affect the verdict.

## Requirement verification

| Requirement | Result | Product evidence |
|---|---|---|
| B-01 — every scoped role uses envelope assembly and records evidence | Delivered | `src/orchestrator.ts:894-957`, `src/orchestrator.ts:2754-2789`, `src/orchestrator.ts:3046-3094`, `src/orchestrator.ts:3246-3275`, and `src/orchestrator.ts:4636-4691` route explorer, planner, contract evaluator, and generator through the common dispatch seam. `src/orchestrator.test.ts:2251-2500` matches all eight scoped invocations to exact evidence events. |
| B-02 — provider-independent logical parity and stable IDs | Delivered | `src/context-envelope.ts:619-657` creates provider-independent evidence. `src/context-envelope.test.ts:777-853` independently assembles Kiro-, Claude-, and Codex-named stub envelopes and checks behavior, gate, finding, and checkpoint IDs. |
| B-03 — deterministic repeated assembly | Delivered | `src/context-envelope.ts:635-657` normalizes and derives evidence deterministically; repeated-byte/evidence assertions are at `src/context-envelope.test.ts:658-717` and `src/context-envelope.test.ts:1145-1178`. |
| B-04 — declared classes and fail-closed configuration | Delivered | `src/context-envelope.ts:619-657` rejects undeclared classes and calls the shared byte-budget guard before dispatch. Focused assertions are at `src/context-envelope.test.ts:741-773`. |
| B-05 — complete per-invocation evidence | Delivered | `src/orchestrator.ts:946-956` records completed logical invocations with provider token names preserved. `src/orchestrator.test.ts:2251-2488` checks exact bytes, ordered classes/IDs, omissions, manifest versions, and token presence or absence. |
| B-06 — per-slice and run totals | Delivered | `src/logger.ts:233-291` aggregates prompt bytes and available token names without inventing absent fields. `src/logger.test.ts:276-327` verifies exact slice and run totals. |
| P-01 — no silent truncation | Delivered | `src/context-envelope.ts:605-616` throws with actual and allowed byte sizes; the one-byte-over assertion passed at `src/context-envelope.test.ts:758-773`. |
| P-02 — fresh focused envelopes exclude resolved findings | **Not delivered** | See blocking finding below. |
| P-03 — legacy generator fallback | Delivered | `src/context-envelope.ts:933-938` retains the full-context fallback; `src/context-envelope.test.ts:1180-1200` verifies it remains measured. |
| P-04 — existing summary evidence and copies remain | Delivered | Existing status, cost, tool, and gate sections remain in `src/logger.ts:251-356`; stable and per-run copies are verified at `src/logger.test.ts:443-453`. |
| P-05 — unchanged prompt at provider seam | Delivered | Kiro receives the exact final argument and Claude/Codex receive exact stdin, verified at `src/kiro.test.ts:69-94`, `src/claude.test.ts:62-85`, and `src/codex.test.ts:161-199`. |

## Fix before ship

### 1. Generator repair prompts still include resolved QA findings

The PRD requires fresh invocations with “no resolved findings” and says a repair round receives the orchestrator-computed unresolved set so the generator does not re-read preserved reports (`prd.md`, Solution and user story 5; testing decision at lines 60–61). The locked slice requirement P-02 repeats that repair/revision envelopes exclude resolved findings.

- **File and location:** `src/qa-convergence.ts`, `qaGeneratorContext` and `formatQAGeneratorContext` (`290-360`).
- **What I read:** the formatter deliberately selects resolved source-change findings that overlap open work, then serializes their ID, state, summary, expected/observed text, clear condition, and artifact references under “Relevant resolved QA findings.”
- **File and location:** `src/orchestrator.ts`, `runSliceExecute` (`5119-5126`, then `4609-4666`).
- **What I read:** the resolved-finding formatter becomes `retryNote`; that note is inserted into `repairSituation`, which is passed into `assembleGeneratorEnvelope`, so the resolved content reaches the actual generator prompt despite the assembler’s omission list.
- **File and location:** `src/candidate-gate-policy.test.ts`, candidate gate repair test (`31-132`).
- **What I ran:** `pnpm vitest run src/candidate-gate-policy.test.ts` passed while explicitly requiring `QA-PRIOR` and `State: RESOLVED` in the next generator’s retry note. This independently confirms the shipped behavior, rather than merely exposing an unused helper.

This restores the context accumulation the PRD set out to remove and materially changes the promised generator experience.

**Clear condition:** Build every generator repair prompt from current OPEN findings and failed-gate references only. Remove resolved finding content from retry notes and repair situations, and add an orchestration-level assertion that seeded resolved IDs, details, and report references are absent from the dispatched prompt.

## Verification performed

- The pre-ship sanity gate was accepted as already passed for this exact tree.
- `pnpm vitest run src/context-envelope.test.ts src/contract-prompt-orchestration.test.ts src/logger.test.ts src/kiro.test.ts src/claude.test.ts src/codex.test.ts` — 92 tests passed.
- `pnpm vitest run src/candidate-gate-policy.test.ts` — 1 test passed and confirmed the blocking resolved-history behavior.
- The full suite was not rerun.

## Out-of-scope PRD gaps

- Slice 01 requirements (US-1–5, US-11–14, US-17–18, US-21), slice 02 requirements (US-9–10, US-19), and slice 03 requirements (US-6–8, US-20) were explicitly excluded from this invocation and were not used to determine the verdict.
- The live three-provider parity matrix portion of US-16 remains deferred by the slice index and parent plan. Slice 04 was correctly judged on provider-independent assembly and named stub parity.
