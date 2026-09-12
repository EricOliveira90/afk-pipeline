<!--
Hand-reconstructed fixture for eval-packs/afk case 09-prd4-qa-b.

Provenance: the `change-summary.json` the QA evaluator was handed for PRD 4
slice 08 (`08-file-scope-gate`, #195). The production artifact is JSON written by
`writeCandidateChangeSummary` (`src/change-summary.ts:223`) into the slice's
`.afk/artifacts/**` directory, which is gitignored and absent from this
checkout; this fixture is the same facts rendered as the Markdown the
evaluator-qa prompt points at with `{{CHANGE_SUMMARY_PATH}}`
(`prompts/evaluator-qa.md:27-29`), because the locked fixture name ends in `.md`.

Every number below was recomputed from this repository with
`git log --format='%h %s' 4f84374..8db5ecd`, `git diff --name-status` and
`git diff --numstat` over the same range: `4f84374` is `6a40f16^`, the commit the
slice's first commit was written on, and `8db5ecd` is the slice's final commit.
The three artifacts the QA stage itself produces — `qa-report-r1-a1.md`,
`qa-report.md` and `qa-review.json` — are excluded, because they did not exist in
the candidate tree the evaluator graded; the totals are the totals of the rows
listed. Nothing else is filtered, and no row's counts are adjusted.
-->

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
