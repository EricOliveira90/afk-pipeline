## Evaluator feedback — round 1

The success, refusal, state, summary, and draft-PR outcomes are mostly concrete and bound to executable gates. The verification boundary and existing CLI dispatch still lack tests that can detect the regressions prohibited by their contracts.

### Findings

- **F-01 (BLOCKING)** — The passing and failing gate fixtures do not prove that gates execute on the candidate merged tree while the feature branch still points to its original commit. A command that always passes or fails would produce the stated result on the wrong checkout, and final snapshots cannot reveal a merge performed before verification and later reset. This violates falsifiability and scenario honesty. Make the gate fixture observe the candidate tree identity and the live feature ref during execution, and assert that every resolved base gate runs before the ref changes.
- **F-02 (BLOCKING)** — P-01 promises preservation of entrypoint routing, provider selection, output channels, and exit behavior for several command categories, but the test plan names no CLI-level preservation scenario. Component tests plus a generic full-suite command cannot fail on untested dispatch wiring. This violates falsifiability and UAT-verifiability. Add automated entrypoint cases for status, stop, clean-failed, a representative pipeline invocation, and help that assert each promised observable.
