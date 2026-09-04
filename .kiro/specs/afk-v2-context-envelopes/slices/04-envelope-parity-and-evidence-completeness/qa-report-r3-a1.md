# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness

- Pre-QA commands: PASS — `pnpm install --frozen-lockfile` completed successfully. Typecheck and authorized related gates are accepted from `.afk/logs/afk-v2-context-envelopes-codex/run-20260904-154113/gates/s04/attempt-5b2fe06d1606.json`, attempt `5b2fe06d-1606-419f-b89b-b951de6c8494`, for Git tree `f958190be95b474b972c89fee54d90b74b282ebf`.
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS — all changed implementation and test paths are declared by the locked file scope; no migration was added.
- Preservation check: FAIL — planner revisions include resolved finding history contrary to P-02.

## Pass 2: Quality & Craft

- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings

- QA-01 — Envelope events now report exact included artifact classes in prompt order. Exact class/ID assertions cover explorer, both planner modes, both contract-evaluator modes, both generator modes, the full scoped stub invocation sequence, and resumed generator evidence.

## Findings

### Finding 1 — QA-02: Planner revisions include forbidden resolved findings

**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/context-envelope.ts:733-745` renders `resolvedFindings` into `RESOLVED_HISTORY`; lines 769-773 records `relevant-resolved-contract-findings`. `src/context-envelope.test.ts:397-435` supplies a resolved finding and asserts that its marker and evidence class are present.
**What the contract expected:** “Initial and repair/revision envelopes retain their role-specific order and exclusions, including no prior conversation, other-role conversation, resolved findings, or passing raw logs.”
**What I observed:** The planner revision prompt contains resolved finding IDs, clear conditions, and evidence under `# Relevant resolved history`, and its event reports that history as included.

### Finding 2 — QA-03: Provider parity test reuses one preassembled object

**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/context-envelope.test.ts:770-825` assembles one generator result, gives the same `result.prompt` and `result.evidence` to all three named stubs, then compares each capture to that same source object.
**What the contract expected:** “Given identical artifacts containing stable behavior/gate/finding/checkpoint IDs, when three provider-named stubs and repeated assembly consume them, then logical envelopes and evidence match and every ID remains visible.”
**What I observed:** No independent assembly occurs per named stub, so the test cannot detect provider-path or repeated-assembly divergence.

### Finding 3 — QA-04: Invocation evidence assertions are not fully exact

**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/orchestrator.test.ts:2420-2446` checks prompt bytes only as greater than zero and omission classes only with `toContain`. The scoped stub fixture exposes input and output token combinations but no cache-read token name.
**What the contract expected:** “Every invocation asserts exact prompt bytes, exact ordered included artifact classes and stable IDs, exact omitted classes, manifest version, and the exact value or absence of each named token count.”
**What I observed:** Class/ID pairs and current token maps are exact, but prompt-byte values and complete omission lists are not, and cache-read presence/absence is not exercised for invocation events.
