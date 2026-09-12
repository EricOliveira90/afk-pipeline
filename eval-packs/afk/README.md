# AFK eval pack

Nine agent-eval cases reconstructed from AFK's own recorded failures and from
the verdicts PRD 4 merged on. Each `*.json` file directly in this directory is
one case; `fixtures/` holds only `fromFile` payloads and is never scanned for
cases. Cases are declared in byte-wise ascending filename order, which is what
the `NN-` prefixes control.

Run the pack:

```bash
afk-claude eval --pack eval-packs/afk
```

Every prompt here is **hand-reconstructed**: no run recorded the prompt an agent
actually received, so each case renders the role's template from `prompts/` over
the material this checkout carries, and each `source` names what it was
reconstructed from. No test dispatches this pack to a provider — `pnpm test`
reads and asserts it, and spends no model call.

Each case below quotes its `source` verbatim; only the line wrapping is added.

## Cases, in declared order

### 1. `192-pre-restart-1-planner` — `01-192-pre-restart-1-planner.json`

- **role:** `planner`
- **expected:** `{"artifact":"ESCALATION"}`
- **source:** hand-reconstructed from
  .afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-1/planner-escalation.md,
  the LOAD_BEARING_SILENCE escalation GH #192 records for launch
  run-20260907-223720 on PRD 4 slice 01 (#84); that artifact tree is gitignored
  and absent from this checkout, so the prompt is rendered from
  prompts/planner.md over the material the repository carries and the seeded
  fixtures name their own provenance

### 2. `192-pre-restart-2-planner` — `02-192-pre-restart-2-planner.json`

- **role:** `planner`
- **expected:** `{"artifact":"ESCALATION"}`
- **source:** hand-reconstructed from
  .afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-2/planner-escalation.md,
  the LOAD_BEARING_SILENCE escalation GH #192 records for launch
  run-20260907-225023 on PRD 4 slice 01 (#84); that artifact tree is gitignored
  and absent from this checkout, so the prompt is rendered from
  prompts/planner.md over the material the repository carries and the seeded
  fixtures name their own provenance

### 3. `192-final-planner` — `03-192-final-planner.json`

- **role:** `planner`
- **expected:** `{"artifact":"CONTRACT"}`
- **source:** hand-reconstructed from
  .afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/planner-escalation.md,
  the third LOAD_BEARING_SILENCE escalation GH #192 records for launch
  run-20260907-231823 on PRD 4 slice 01 (#84) - D6's testGlobs matcher dialect,
  the one #192 calls a decision the repository already made, so the graded
  artifact for this case is the contract that escalation should have been; that
  artifact tree is gitignored and absent from this checkout, so the prompt is
  rendered from prompts/planner.md over the material the repository carries and
  the seeded fixtures name their own provenance

### 4. `194-f03-evaluator-contract` — `04-194-f03-evaluator-contract.json`

- **role:** `evaluator-contract`
- **expected:** `{"verdict":"ACCEPT"}`
- **source:** hand-reconstructed from
  .afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/reviews/contract-review-r1-a1.json,
  the round-1 REVISE GH #194 records for launch run-20260908-014522 on PRD 4
  slice 01 (#84), whose blocking finding F-03 rests on the false premise that
  manifest fileScope comparison is case-sensitive; that artifact tree is
  gitignored and absent from this checkout, so the prompt is rendered from
  prompts/evaluator-contract.md and the contract pair is hand-authored to
  reproduce the one condition #194 quotes - the manifest declares architecture.md
  while the contract and B-16 say ARCHITECTURE.md

### 5. `120-candidate-typecheck-evaluator-qa` — `05-120-candidate-typecheck-evaluator-qa.json`

- **role:** `evaluator-qa`
- **expected:** `{"verdict":"FAIL","failureClass":"IMPLEMENTATION"}`
- **source:** hand-reconstructed from GH #120 (a candidate's own compile failure
  classified INFRASTRUCTURE, burning both retries on byte-identical attempts) and
  docs/adr/0041-uncertain-classification-picks-the-branch-that-cannot-loop.md,
  the decision that a candidate-owned compile failure is never INFRASTRUCTURE,
  plus AGENTS.md:74-77 on the self-run verification command; the incident's own
  logs under .afk/logs/afk-v2-evidence-backbone-codex/run-20260827-1442* are
  gitignored and absent from this checkout, so the inline project reproduces the
  TS2820 shape #120 quotes (a warn reason emitted from src/orchestrator.ts that
  src/run-events.ts does not carry in its union) rather than copying the incident
  tree

### 6. `prd4-contract-a` — `06-prd4-contract-a.json`

- **role:** `evaluator-contract`
- **expected:** `{"verdict":"ACCEPT"}`
- **source:** hand-reconstructed from
  .kiro/specs/afk-v2-acceptance-scope-gates/slices/02-behavior-coverage-gate/contract-review.json,
  whose verdict member is ACCEPT (confirmed-by: dbd6fdc, PR #256's merge commit,
  an ancestor of this branch's HEAD: the slice merged to main on that verdict);
  the pair under review is that slice's committed contract.md and
  acceptance-manifest.json, carried here as fixtures, and the prompt is rendered
  from prompts/evaluator-contract.md

### 7. `prd4-contract-b` — `07-prd4-contract-b.json`

- **role:** `evaluator-contract`
- **expected:** `{"verdict":"ACCEPT"}`
- **source:** hand-reconstructed from
  .kiro/specs/afk-v2-acceptance-scope-gates/slices/05-test-cost-split-and-caching/contract-review.json,
  whose verdict member is ACCEPT with F-14 (BLOCKING) and F-15 (ADVISORY) both
  RESOLVED (confirmed-by: dbd6fdc, PR #256's merge commit, an ancestor of this
  branch's HEAD: the slice merged to main on that verdict); the pair under review
  is that slice's committed contract.md and acceptance-manifest.json, carried
  here as fixtures, and the prompt is rendered from
  prompts/evaluator-contract.md

### 8. `prd4-qa-a` — `08-prd4-qa-a.json`

- **role:** `evaluator-qa`
- **expected:** `{"verdict":"PASS","failureClass":"NONE"}`
- **source:** hand-reconstructed from
  .kiro/specs/afk-v2-acceptance-scope-gates/slices/03-candidate-evaluator-isolation/qa-review.json,
  whose verdict is PASS and failureClass NONE with QA-01, QA-02 and QA-03 all
  RESOLVED (confirmed-by: dbd6fdc, PR #256's merge commit, an ancestor of this
  branch's HEAD: the slice merged on that verdict); the prompt is rendered from
  prompts/evaluator-qa.md over that slice's committed contract.md and excerpts of
  its committed qa-report-r1-a1.md, with the change summary carried as the
  prd4-qa-a-change-summary.md fixture

### 9. `prd4-qa-b` — `09-prd4-qa-b.json`

- **role:** `evaluator-qa`
- **expected:** `{"verdict":"PASS","failureClass":"NONE"}`
- **source:** hand-reconstructed from
  .kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/qa-review.json,
  whose verdict is PASS and failureClass NONE while QA-01 stays OPEN as an
  ADVISORY (confirmed-by: dbd6fdc, PR #256's merge commit, an ancestor of this
  branch's HEAD: the slice merged on that verdict); the prompt is rendered from
  prompts/evaluator-qa.md over that slice's committed contract.md and excerpts of
  its committed qa-report-r1-a1.md, with the change summary carried as the
  prd4-qa-b-change-summary.md fixture

## Why only final-round verdicts for cases 6–9

`prd.md` D2 admits a recorded verdict as an expectation only where a human later
bore it out — the slice merged on that verdict. All eight PRD 4 slices merged to
`main` in PR #256 at merge commit `dbd6fdc` (2026-09-12), and the verdict each
merged on is the final `contract-review.json` / `qa-review.json` committed in
its own spec directory, so both halves of the criterion are in-repo facts. A
round-1 `REVISE` would need the round-1 contract pair, which no commit carries,
so those four `source` strings name no `.afk/artifacts/**/reviews/` path at all.
