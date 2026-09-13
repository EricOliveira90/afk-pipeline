# Slice Contract — Eval seed pack

**Parent PRD:** .kiro/specs/afk-v2-agent-eval-harness/prd.md
**GH issue:** #263
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

Commit the AFK-owned scenario pack `eval-packs/afk/` — nine hand-reconstructed
cases, one `*.json` file each, valid under slice 01's `readEvalPack` — plus its
`eval-packs/afk/README.md` index, the oversized case inputs it references with
`fromFile` under `eval-packs/afk/fixtures/`, and the one-case fixture consumer
pack `eval-packs/fixtures/consumer-governance/`. A new test file
`src/eval-packs.test.ts` reads both packs through `readEvalPack`, asserts the
per-case invariants, and dispatches only the consumer pack to the stub provider
in `src/eval.fixtures.ts`, asserting `MATCH`/`MISMATCH` through the run's
`report.json`. No production source file, `CONTEXT.md` or `ARCHITECTURE.md`
changes.

### In scope

- [behavior:B-01] `eval-packs/afk/` holds exactly nine case files, named
  `01-`…`09-` with a two-digit numeric prefix so the reader's byte-wise scan
  order (`byBytes`, `src/eval-pack.ts:286-308`) is the declared order; each
  file is a JSON object with exactly the seven `CASE_KEYS` members
  (`version, id, role, source, prompt, files, expected`,
  `src/eval-pack.ts:84-92`) and `readEvalPack("eval-packs/afk")` resolves
  without refusal. Decision recorded here: the count is nine — the minimum the
  four `prd.md` D2 sources yield (3 + 1 + 1 + 4), inside the issue's "roughly
  nine to fourteen" band; no case is invented to reach a number
  (#263 "What to build", plan-debate §7 R3).
- [behavior:B-02] Three `planner` cases reconstruct #192's escalations on PRD 4
  slice 01 in declared order — `01-192-pre-restart-1-planner.json` (D1
  `gatePolicy` shapes) and `02-192-pre-restart-2-planner.json` (D5 waiver
  `path`) with `expected` `{"artifact":"ESCALATION"}`, and
  `03-192-final-planner.json` (D6 glob dialect) with
  `{"artifact":"CONTRACT"}`; each `source` names the `planner-escalation.md`
  under `.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/` it was
  reconstructed from, and each case's `files` carry that escalation's
  `context.md`, the PRD 4 excerpt at `de7b0ec` and the #84 body excerpt
  (#263 AC2, `prd.md` D2 source 1).
- [behavior:B-03] One `evaluator-contract` case
  `04-194-f03-evaluator-contract.json` reconstructs round 1 of
  `run-20260908-014522` (finding F-03, the false premise about `fileScope`
  casing — `normalizePath` lowercases at `src/acceptance-manifest.ts:71`) with
  `expected` `{"verdict":"ACCEPT"}`, and its `source` names the archived
  `contract-review-r1-a1.json` it was reconstructed from. Decision recorded
  here: #194 yields one case, not two — the issue and `prd.md` leave the count
  at "one or two" conditional on `run-20260908-005855`'s archived inputs
  sufficing, and those inputs are not present in this repository
  (#263 AC3, `prd.md` D2 source 2).
- [behavior:B-04] One `evaluator-qa` case
  `05-120-candidate-typecheck-evaluator-qa.json` carries `expected`
  `{"verdict":"FAIL","failureClass":"IMPLEMENTATION"}` and inline `files`
  holding a minimal project whose `typecheck` fails on a type error the
  prompt attributes to the candidate; its `source` names #120 and ADR 0041
  (`docs/adr/0041-uncertain-classification-picks-the-branch-that-cannot-loop.md`,
  cited because it is the decision that a candidate-owned compile failure is
  never `INFRASTRUCTURE`) plus `AGENTS.md:74-77` (#263 AC4, `prd.md` D2
  source 3).
- [behavior:B-05] Four cases reconstruct PRD 4's **final-round** evaluator
  verdicts as they are committed in this repository, at most one case of either
  role per PRD 4 slice and one role per slice: two `evaluator-contract` —
  `06-prd4-contract-a.json` from slice `02-behavior-coverage-gate` and
  `07-prd4-contract-b.json` from slice `05-test-cost-split-and-caching`, each
  `expected` `{"verdict":"ACCEPT"}`, the value of the `verdict` member of
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/<slice>/contract-review.json`,
  with the prompt reconstructed from `prompts/evaluator-contract.md` over that
  slice's committed `contract.md` and `acceptance-manifest.json` (carried as
  the `prd4-contract-a-*` / `prd4-contract-b-*` `fromFile` fixtures) — and two
  `evaluator-qa` — `08-prd4-qa-a.json` from slice
  `03-candidate-evaluator-isolation` and `09-prd4-qa-b.json` from slice
  `08-file-scope-gate`, each `expected` `{"verdict":"PASS","failureClass":"NONE"}`,
  the `verdict` and `failureClass` members of that slice's committed
  `qa-review.json`, with the prompt reconstructed from
  `prompts/evaluator-qa.md` over that slice's committed `contract.md` and
  excerpts of its committed `qa-report-r*-a1.md`, plus the
  `prd4-qa-a-change-summary.md` / `prd4-qa-b-change-summary.md` fixtures. Each
  of the four `source` strings names the repo-relative path of the verdict
  artifact it took `expected` from, under
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/`, and carries the
  confirming fact as the literal substring `confirmed-by: dbd6fdc` (F-08's
  decidable marker, the counterpart of B-06's `hand-reconstructed`). Decision
  recorded here: `prd.md` D2's criterion — the recorded verdict is an
  expectation "only where a human later bore it out … the slice merged on that
  verdict" — is satisfied by material reachable from this checkout, not by the
  operator's absent `.afk/artifacts/**/reviews/` tree. All eight PRD 4 slices
  merged to `main` in PR #256 at merge commit `dbd6fdc` (2026-09-12), an
  ancestor of this branch's HEAD, and the verdict each merged on is the final
  `contract-review.json` / `qa-review.json` committed in its own spec
  directory — so both halves of the criterion (the verdict's content and the
  human confirmation) are in-repo facts the generator can read and the
  reviewer can re-check. Consequently only final-round verdicts are used: a
  round-1 `REVISE` would need the round-1 contract pair, which no commit
  carries, so the `REVISE`-accepted-in-the-next-round branch of D2's criterion
  yields no case here (#263 AC5, `prd.md` D2 source 4).
- [behavior:B-06] Every case in `eval-packs/afk/` carries a non-blank `source`
  that contains the word `hand-reconstructed` and cites only the four
  `prd.md` D2 source names (#192, #194, #120/ADR 0041, a PRD 4 committed
  verdict artifact under
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/`); no two cases share an
  `id`; and every case's `expected` validates against its `role` under
  `EXPECTED_SHAPE` (`src/eval-pack.ts:102-118`). Decision recorded here: where
  the operator's archived inputs are unavailable in this checkout, the prompt
  is reconstructed from material this checkout does carry — for B-02 and B-03
  the excerpts quoted inside `prd.md`, #192 and #194, and for B-05's four
  cases the committed PRD 4 spec artifacts B-05 names — and the `source` still
  names the path it reconstructs from plus `hand-reconstructed`. B-05's four
  `source` strings name no `.afk/artifacts/**/reviews/` path at all: that tree
  is gitignored and absent, so a citation of it as the origin of an `expected`
  value could not be checked (#263 AC1, AC6, AC7).
- [behavior:B-07] `eval-packs/afk/README.md` lists every case's `id`, `role`,
  `source` and `expected`, in the same order the pack declares them, and gives
  the operator command `afk-claude eval --pack eval-packs/afk`; it is a
  `README.md`, so the `*.json`-only scan never treats it as a case
  (#263 AC8, AC9).
- [behavior:B-08] `eval-packs/fixtures/consumer-governance/` holds one case,
  `01-pm-governance.json`, with `role` `pm`, `expected`
  `{"outcome":"FIX-BEFORE-SHIP"}`, a `pm-review`-shaped prompt over a small
  diff, and a `PRODUCT.md` among its `files`;
  `readEvalPack("eval-packs/fixtures/consumer-governance")` resolves without
  refusal (#263 AC10).
- [behavior:B-09] Dispatching the consumer pack to
  `buildEvalStubProvider` (`src/eval.fixtures.ts:85-121`) yields outcome
  `MATCH` when the stub writes `review-pm.md` with `FIX-BEFORE-SHIP` and
  `MISMATCH` when it writes `SHIP`, both asserted from the run's `report.json`
  read back through `readEvalReport` (`src/eval-report.ts`) (#263 AC11).
- [behavior:B-10] No test under `src/`, including `src/eval-packs.test.ts`,
  dispatches `eval-packs/afk/` to any provider — stub included; the AFK pack is
  read and asserted only, so `pnpm test` spends no model call
  (#263 AC12, `prd.md` Testing decision 3).

### Non-goals (explicit out-of-scope)

- No change to the runner: `src/eval-pack.ts`, `src/eval-compare.ts`,
  `src/eval-report.ts`, `src/eval-command.ts` and `src/eval.fixtures.ts` stay
  as slice 01 shipped them.
- No prompt recorder (`src/prompt-recorder.ts`, `--record-prompts`) — slice 03.
- No live-model dispatch of any pack from any test, and no gate that consumes
  an eval report.
- No cases for the sources `decisions-review.md` H2 dropped: PRD 1 envelopes,
  #111–#121 orchestrator defects, classifier cases.
- No spawned pipeline scenario and no new `test:heavy` suite (`AGENTS.md`
  assertion ladder, `prd.md` Testing decision 5).

### Existing behavior to preserve

- [behavior:P-01] `readEvalPack` / `validateEvalCase`
  (`src/eval-pack.ts:230-371`) keep their current refusal behavior: this slice
  adds `src/eval-packs.test.ts` and changes no other file under `src/`
  (#263 "Files expected to change", `prd.md` file-scope map S2 column).
- [behavior:P-02] `eval-packs/fixtures/refused/01-unknown-member.json` is
  untouched and is still refused by `readEvalPack` for its unknown `notes`
  member — it is slice 01's refusal fixture, not a template for this slice's
  cases (`eval-packs/fixtures/refused/01-unknown-member.json:1-12`).
- [behavior:P-03] `CONTEXT.md` and `ARCHITECTURE.md` are unchanged; the
  "Agent eval" row and the D36 vocabulary entries stay exactly as slice 01
  wrote them (#263 AC13, `prd.md` file-scope map).

### Changes to existing behavior (only if the issue asks for it)

- None

## Files expected to change

- eval-packs/afk/01-192-pre-restart-1-planner.json
- eval-packs/afk/02-192-pre-restart-2-planner.json
- eval-packs/afk/03-192-final-planner.json
- eval-packs/afk/04-194-f03-evaluator-contract.json
- eval-packs/afk/05-120-candidate-typecheck-evaluator-qa.json
- eval-packs/afk/06-prd4-contract-a.json
- eval-packs/afk/07-prd4-contract-b.json
- eval-packs/afk/08-prd4-qa-a.json
- eval-packs/afk/09-prd4-qa-b.json
- eval-packs/afk/README.md
- eval-packs/afk/fixtures/192-context-pre-restart-1.md
- eval-packs/afk/fixtures/192-context-pre-restart-2.md
- eval-packs/afk/fixtures/192-context-final.md
- eval-packs/afk/fixtures/192-prd4-excerpt.md
- eval-packs/afk/fixtures/192-issue-84.md
- eval-packs/afk/fixtures/194-contract.md
- eval-packs/afk/fixtures/194-acceptance-manifest.json
- eval-packs/afk/fixtures/194-feedback-r1-a1.md
- eval-packs/afk/fixtures/prd4-contract-a-contract.md
- eval-packs/afk/fixtures/prd4-contract-a-acceptance-manifest.json
- eval-packs/afk/fixtures/prd4-contract-b-contract.md
- eval-packs/afk/fixtures/prd4-contract-b-acceptance-manifest.json
- eval-packs/afk/fixtures/prd4-qa-a-change-summary.md
- eval-packs/afk/fixtures/prd4-qa-a-contract.md
- eval-packs/afk/fixtures/prd4-qa-b-change-summary.md
- eval-packs/afk/fixtures/prd4-qa-b-contract.md
- eval-packs/fixtures/consumer-governance/01-pm-governance.json
- src/eval-packs.test.ts

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- None — uses existing patterns. The case shape is `prd.md` D7/D9 as slice 01
  already enforces it; `fromFile` fixtures and the `NN-` filename prefix follow
  `eval-packs/fixtures/refused/01-unknown-member.json`.

## Test plan

- Given `eval-packs/afk/`, when `readEvalPack` reads it, then it resolves with
  nine cases in `01-`…`09-` filename order, each carrying exactly the seven
  `CASE_KEYS` members.
- Given the nine AFK cases, when each `role` and `expected` pair is inspected,
  then the three `planner` cases read `ESCALATION`, `ESCALATION`, `CONTRACT`;
  the `05-` `evaluator-qa` case reads `FAIL` / `IMPLEMENTATION`; the `04-`,
  `06-` and `07-` `evaluator-contract` cases each read `ACCEPT`; and the `08-`
  and `09-` `evaluator-qa` cases each read `PASS` / `NONE`.
- Given the nine AFK cases, when each `source` is inspected, then it is
  non-blank, contains `hand-reconstructed`, and names one of #192, #194,
  #120/ADR 0041 or a path under
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/`; the four `06-`…`09-`
  cases each name such a path ending in `contract-review.json` (`06-`, `07-`)
  or `qa-review.json` (`08-`, `09-`) and each contain the literal
  `confirmed-by: dbd6fdc`; and all nine `id` values are unique.
- Given `eval-packs/afk/README.md`, when its text is read, then it names every
  case `id` in declared order with that case's `role`, `source` and `expected`,
  and contains `afk-claude eval --pack eval-packs/afk`.
- Given `eval-packs/fixtures/consumer-governance/`, when `readEvalPack` reads
  it, then it resolves with one `pm` case whose `expected.outcome` is
  `FIX-BEFORE-SHIP` and whose `files` include a `PRODUCT.md`.
- Given the consumer pack dispatched to `buildEvalStubProvider`, when the stub
  writes `review-pm.md` with `FIX-BEFORE-SHIP`, then `report.json` read through
  `readEvalReport` records outcome `MATCH`; when it writes `SHIP`, the same read
  records `MISMATCH`.
- Given `src/eval-packs.test.ts`, when its dispatch calls are inspected, then
  none passes `eval-packs/afk` as the pack directory.

## Definition of done

- [ ] `readEvalPack` accepts `eval-packs/afk/` and
      `eval-packs/fixtures/consumer-governance/` in `src/eval-packs.test.ts`.
- [ ] `eval-packs/afk/` contains exactly the nine committed case files listed
      above, with the roles, `expected` values and `source` citations B-02 to
      B-06 require.
- [ ] Every `fromFile` target a case names exists under
      `eval-packs/afk/fixtures/` and is one of the paths listed above.
- [ ] `eval-packs/afk/README.md` lists all nine cases in declared order with
      `id`, `role`, `source`, `expected`, plus the operator command.
- [ ] The consumer-pack stub dispatch asserts `MATCH` and `MISMATCH` through
      `report.json` via `readEvalReport`.
- [ ] No test dispatches `eval-packs/afk/` to any provider.
- [ ] No file under `src/` other than `src/eval-packs.test.ts` changed, and
      `CONTEXT.md`, `ARCHITECTURE.md` and
      `eval-packs/fixtures/refused/01-unknown-member.json` are unchanged.
- [ ] `pnpm run typecheck` and `pnpm vitest run src/eval-packs.test.ts` pass,
      and `pnpm test:fast` is green.
