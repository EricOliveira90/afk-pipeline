# Handoff

The AFK run was stopped mid-slice after five commits (c58a93b, tagged
`rescue/76-c58a93b`); the rest was completed by hand outside the
pipeline, on the same slice branch.

## What shipped
- Version 2 manifest schema: `src/acceptance-manifest.ts:parseAcceptanceManifest` validates a non-empty `behaviors` array — exact keys, non-blank strings, boolean `preservation`, a non-empty list of distinct non-blank `gateIds` — and unique behavior IDs. Version 1 still parses for archived evidence.
- Anchor coverage: `src/acceptance-manifest.ts:validateAcceptanceManifestCoverage` reads only `^- \[behavior:ID\] ` lines inside the exact `### In scope` and `### Existing behavior to preserve` sections and refuses with the complete missing and duplicate sets. Every other character of `contract.md` is ignored.
- Executable bindings: `src/acceptance-manifest.ts:validateAcceptanceManifestBindings` refuses every gate ID that is absent from the derived baseline catalog or has no discovered command.
- ID stability: `src/acceptance-manifest.ts:validateAcceptanceManifestStability` compares each schema-valid planner manifest with the previous round's by behavior evidence (source, Given/When/Then, observable result, preservation) and refuses a renumbered unchanged behavior, naming both IDs. Gate changes stay legal.
- Refusal accounting: `src/orchestrator.ts:runSliceNegotiate` runs all four checks before review, so each refusal spends one planner round, invokes no evaluator, writes no `feedback-r*.md`, and reaches the next planner prompt.
- Review context: `prompts/evaluator-contract.md` receives the validated manifest and the formatted gate catalog, and judges scenario honesty and binding aptness.
- Planner output: `prompts/planner.md` emits the behavior anchors, the version 2 manifest, and the ID-stability rule, and carries the derived gate catalog as the only bindable IDs.

## Decisions made during implementation
- The planner is told the gate catalog (`{{BASE_GATE_CATALOG}}`, fed from the same `resolveBaseGateDeclarations` the binding check reads). Bindable IDs are not derivable from the repo by reading, so without this the planner could only guess and burn rounds on refusals.
- Behavior identity is the evidence tuple minus `gateIds`, which is what AC6 asks for: "a revision does not renumber untouched behaviors", and gates may change.
- `wave.test.ts` and `resume-integration.test.ts` fixture repos gained the one sanity script (`test:run`) the derived catalog reads. Consequence to know: a repo with no sanity script has no executable gate, so no manifest can bind and no contract can lock there.

## Gotchas / learnings
- Any fixture that negotiates a contract now needs a version 2 manifest whose `gateIds` name a gate with a command in *that* fixture repo — the catalog is resolved per worktree.
- One orchestrator case ("unknown version") had been passing on the planner template's own `"version": 1` text rather than on the refusal message. It now declares version 3 and matches the parser's message. Watch for the same trap when asserting an objection against a rendered prompt.
- The anchor grammar is deliberately narrow: an anchor-shaped line in prose or in any other section is not control data.

## Status
Full `pnpm test` green in this worktree. No regressions.
