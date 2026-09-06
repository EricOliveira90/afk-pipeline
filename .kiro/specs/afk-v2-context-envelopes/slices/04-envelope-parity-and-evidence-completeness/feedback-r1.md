## Evaluator feedback — round 1

I reviewed the contract and acceptance manifest against the PRD, ADR 0002, ADR 0017, and the executable gate catalog. The `tests` and `typecheck` bindings are capable of producing relevant evidence, the non-goals and schema change are explicit, and the implementation remains plausible in one generator session. The test plan, however, leaves required evidence fields, unavailable-token behavior, focused-envelope preservation, and live-adapter prompt delivery implicit, so those contract regressions could pass the stated scenarios.

### Findings

- **F-01 (BLOCKING)** — B-05 promises complete per-invocation evidence, but its test-plan entry checks only generic size evidence and token-field filtering. It does not require assertions for ordered included classes and IDs, omitted classes, or manifest version. This violates falsifiability and scenario honesty because those required fields can be absent or reordered while the stated test still passes.

- **F-02 (BLOCKING)** — B-06 promises that summaries do not invent unavailable token counts, but its test-plan fixture does not require mixed token availability or assert absence at slice and run levels. This violates falsifiability because synthetic zero-valued totals can satisfy a generic “totals are correct” assertion.

- **F-03 (BLOCKING)** — P-02 promises role-specific ordering and exclusion of prior conversations, other-role conversations, resolved findings, and passing raw logs, but no test-plan scenario supplies and checks those markers. A broad command that happens to run existing envelope tests is not a same-obligation acceptance scenario, so this violates falsifiability.

- **F-04 (BLOCKING)** — P-05 preserves both exact prompt delivery through `AgentProvider.invoke` and provider-owned command wrapping. The listed scenarios exercise generic or provider-named stubs, not the Kiro, Claude, and Codex command builders, so adapter prompt placement can regress without failing the stated preservation proof. Add an explicit command-shape scenario for all three adapters.
