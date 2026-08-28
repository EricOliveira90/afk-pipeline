## Evaluator feedback — round 1

I reviewed each acceptance-manifest scenario against its same-ID contract obligation and the executable gate catalog. The `typecheck` and `tests` bindings are apt because the full test gate includes the focused and heavy suites, and the scope remains feasible without a new dependency or artifact schema. Several observable results and test-plan assertions, however, omit data that their behaviors expressly promise, so those regressions could pass without detection.

### Findings

- **F-01 (BLOCKING)** — B-01 promises that the parked branch and reason are projected along with `AWAITING-ADJUDICATION`, but its observable result and test plan prove only the phase. This violates falsifiability and scenario honesty because the branch or reason could disappear without failing the stated acceptance proof.
- **F-02 (BLOCKING)** — B-02 requires both outcome copies to carry the classification, contested finding ID, evaluator-held state, planner position, and both evidence strings verbatim. Its integration test plan asks only for exact evidence, leaving the other required fields without an explicit failing assertion.
- **F-03 (BLOCKING)** — B-05 promises that cancellation preserves the parked branch and impasse artifact, while its observable result and cancellation test assert only phase retention and which slices become `CANCELLED`. This leaves destructive cancellation bookkeeping observable but untested.
