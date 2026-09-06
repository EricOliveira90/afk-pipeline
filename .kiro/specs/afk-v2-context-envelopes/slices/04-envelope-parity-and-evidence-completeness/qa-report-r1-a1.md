# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness

- Pre-QA commands: PASS — `pnpm install --frozen-lockfile` completed successfully. Typecheck was accepted from orchestrator evidence `.afk/logs/afk-v2-context-envelopes-codex/run-20260904-154113/gates/s04/attempt-a9f500f433bd.json`, attempt `a9f500f4-33bd-4fcf-a01d-a4b5f10efb09`, for Git tree `648ad66b0027c5bd0050936fc8ea558ab1d5dec6`.
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft

- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings

- none

## Findings

### Finding 1 — Envelope evidence classes and order are inaccurate

**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/context-envelope.ts:675-692` maps both evaluator contract and acceptance-manifest IDs, including revision inputs, to `proposed-contract-pair`, while the evaluator manifest at `src/context-envelope.ts:476-491` declares distinct initial and revision classes. Generator evidence at `src/context-envelope.ts:959-1013` also orders contract and acceptance inputs before file scope and repair situation, unlike the repair prompt at `prompts/generator-repair.md:6-50`. `src/orchestrator.test.ts:2293-2297` asserts only that classes form an array parallel to IDs, not their exact values or order.
**What the contract expected:** “Every completed scoped invocation records prompt bytes, ordered included artifact classes and IDs, omitted classes, manifest version, and any named token counts exposed by its provider.”
**What I observed:** Contract-evaluator events use stale aggregate classes instead of the manifest-declared classes, and generator events do not list inputs in the order they appear in the repair envelope.
