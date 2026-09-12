<!--
Hand-reconstructed fixture for eval-packs/afk case 08-prd4-qa-a.

Provenance: the `change-summary.json` the QA evaluator was handed for PRD 4
slice 03 (`03-candidate-evaluator-isolation`, #91). The production artifact is
JSON written by `writeCandidateChangeSummary` (`src/change-summary.ts:223`) into
the slice's `.afk/artifacts/**` directory, which is gitignored and absent from
this checkout; this fixture is the same facts rendered as the Markdown the
evaluator-qa prompt points at with `{{CHANGE_SUMMARY_PATH}}`
(`prompts/evaluator-qa.md:27-29`), because the locked fixture name ends in `.md`.

Every number below was recomputed from this repository with
`git log --format='%h %s' 3b9c78f..3eab903`, `git diff --name-status` and
`git diff --numstat` over the same range: `3b9c78f` is `78c56bb^`, the commit
the slice's first commit was written on, and `3eab903` is the slice's final
commit. The four artifacts the QA stage itself produces — `qa-report-r1-a1.md`,
`qa-report-r2-a1.md`, `qa-report.md` and `qa-review.json` — are excluded,
because they did not exist in the candidate tree the evaluator graded; the
totals are the totals of the rows listed. Nothing else is filtered, and no row's
counts are adjusted.
-->

# Change summary — PRD 4 slice 03 (#91), candidate evaluator isolation

- **version:** 1
- **fromRef:** `3b9c78f` (the slice's comparison base)
- **toRef:** `3eab903` (the candidate)

## Commits

| SHA | Subject |
|---|---|
| `3eab903` | feat(#91): Candidate evaluator isolation |
| `169be76` | test(qa-orchestration): make both halves of the reviewer-write scan load-bearing (#91) |
| `0e5998e` | docs(afk-v2-acceptance-scope-gates): record the review worktree naming gotcha (#91) |
| `3bd9211` | fix(orchestrator): keep the slice suffix last in the review worktree name (#91) |
| `0faca0b` | docs(afk-v2-acceptance-scope-gates): slice 03 handoff (#91) |
| `87356df` | feat(orchestrator): review the candidate in a disposable worktree (#91) |
| `8857443` | feat(logger): render candidate review isolation in run-summary.md (#91) |
| `0ee43a1` | feat(prompts): state the evaluator's judgement frame and probe rule (#91) |
| `154d4a1` | feat(context-envelope): reshape the candidate evaluator manifest in place (#91) |
| `dfb695c` | feat(run-state): version 4 adds a per-slice approved-baseline locator (#91) |
| `b2c20b0` | feat(qa-review): enumerate reviewer writes in the review worktree (#91) |
| `7551628` | feat(post-qa-gates): export the QA-window allowlist as the copy-back boundary (#91) |
| `754b4c5` | feat(change-summary): build a candidate change summary from git (#91) |
| `78c56bb` | feat(events): additive approved-baseline and reviewer-write-violation variants (#91) |

## Files

| Status | Path | + | - |
|---|---|---|---|
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/acceptance-manifest.json` | 217 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/context.md` | 37 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/contract-response.json` | 21 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/contract-review.json` | 39 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/contract.md` | 401 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/feedback-r1.md` | 62 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/feedback-r2.md` | 82 | 0 |
| A | `.kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/handoff.md` | 125 | 0 |
| M | `ARCHITECTURE.md` | 11 | 1 |
| M | `prompts/evaluator-qa.md` | 51 | 1 |
| A | `src/change-summary.test.ts` | 142 | 0 |
| A | `src/change-summary.ts` | 235 | 0 |
| M | `src/context-envelope.test.ts` | 36 | 0 |
| M | `src/context-envelope.ts` | 11 | 0 |
| M | `src/logger.test.ts` | 62 | 0 |
| M | `src/logger.ts` | 31 | 1 |
| M | `src/orchestrator.test.ts` | 2 | 2 |
| M | `src/orchestrator.ts` | 409 | 12 |
| M | `src/post-qa-gates.test.ts` | 56 | 1 |
| M | `src/post-qa-gates.ts` | 6 | 1 |
| M | `src/prompt-template.test.ts` | 56 | 1 |
| M | `src/qa-orchestration.test.ts` | 494 | 3 |
| M | `src/qa-review.ts` | 116 | 0 |
| M | `src/run-events.ts` | 33 | 0 |
| M | `src/run-state.test.ts` | 121 | 7 |
| M | `src/run-state.ts` | 123 | 6 |

## Totals

- files: 26
- insertions: 2979
- deletions: 36
- binaryFiles: 0
