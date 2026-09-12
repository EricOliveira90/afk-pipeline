# Change summary — PRD 4 slice 08 (#195), file-scope gate

- **version:** 1
- **fromRef:** `4f84374` (the slice's comparison base)
- **toRef:** `8db5ecd` (the candidate)

## Commits

| SHA | Subject |
|---|---|
| `8db5ecd` | docs(#195): record the slice 08 file-scope gate artifacts |
| `d375169` | feat(orchestrator): declare the file-scope gate first in the post-QA phase (#195) |
| `a8efbce` | test(fixtures): declare each stub generator's output path in its fixture manifest (#195) |
| `0462c65` | feat(scope-gate): grade a candidate's changed files against its locked scope (#195) |
| `6a40f16` | feat(gate-runner): let a declaration compute its own result (#195) |

## Files

| Status | Path | + | - |
|---|---|---|---|
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/acceptance-manifest.json` | 227 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/context.md` | 277 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/contract-review.json` | 83 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/contract.md` | 356 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/feedback-r1.md` | 124 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/handoff.md` | 97 | 0 |
| M | `ARCHITECTURE.md` | 5 | 2 |
| M | `src/gate-runner.test.ts` | 533 | 4 |
| M | `src/gate-runner.ts` | 214 | 12 |
| M | `src/orchestrator.fixtures.ts` | 23 | 1 |
| M | `src/orchestrator.test.ts` | 27 | 1 |
| M | `src/orchestrator.ts` | 44 | 1 |
| M | `src/qa-orchestration.test.ts` | 263 | 5 |
| M | `src/resume-integration.fixtures.ts` | 15 | 1 |
| M | `src/resume-integration.test.ts` | 34 | 0 |
| A | `src/scope-gate.test.ts` | 383 | 0 |
| A | `src/scope-gate.ts` | 173 | 0 |
| M | `src/wave-migrations.test.ts` | 38 | 7 |
| M | `src/wave.fixtures.ts` | 23 | 4 |

## Totals

- files: 19
- insertions: 2939
- deletions: 38
- binaryFiles: 0
