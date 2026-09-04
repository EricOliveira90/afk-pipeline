# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS — `pnpm install --frozen-lockfile` completed successfully. Typecheck and the related deterministic suites are covered by verified gate attempt `5415048c-7d0e-4a36-85c9-2f33367cb932` for Git tree `359074422d14ec126e20e0f2e5f138ed1e865aa4`.
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS — all changed source and test paths are declared by the locked contract and acceptance manifest; no migration was added.
- Preservation check: PASS — fail-closed budgets, focused-history exclusions, legacy generator fallback, summary copies and existing fields, and provider-owned prompt dispatch shapes remain asserted.

## Pass 2: Quality & Craft
- Convention compliance: NOTES — no documented-standard violation; retained compatibility parameters and repeated provider usage-field extraction are minor non-blocking cleanup opportunities.
- Code quality: PASS
- Test quality: PASS

## Resolved findings
- QA-02 — Planner revision assembly now ignores supplied resolved history, excludes its markers from the complete prompt, and emits no resolved-finding artifact class.
- QA-03 — Kiro-, Claude-, and Codex-named stubs now receive separate envelope assemblies whose normalized prompts, logical evidence, and behavior/gate/finding/checkpoint IDs are compared.
- QA-04 — The full scoped invocation sequence now asserts exact prompt bytes, included and omitted evidence, manifest metadata, exact token maps, and token-field absence, including `cache_read_input_tokens`.

## Findings
- None.
