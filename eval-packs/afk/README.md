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

Every file under `fixtures/` is the reconstructed document and nothing else: no
header, no comment, no note about which case seeds it or what that case expects.
A `fromFile` payload is copied byte-for-byte into the case's scratch directory
(`src/eval-command.ts`) and the prompt orders the role to read it, so a fixture
that named its own case or its own graded answer would hand the role under test
the answer. Provenance lives in the two places the role never reads: each case's
`source` member, and the fixture table at the end of this file.

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
  prompts/planner.md over the material the repository carries and each seeded
  fixture's provenance is recorded in eval-packs/afk/README.md rather than
  inside the bytes the role reads

### 2. `192-pre-restart-2-planner` — `02-192-pre-restart-2-planner.json`

- **role:** `planner`
- **expected:** `{"artifact":"ESCALATION"}`
- **source:** hand-reconstructed from
  .afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-2/planner-escalation.md,
  the LOAD_BEARING_SILENCE escalation GH #192 records for launch
  run-20260907-225023 on PRD 4 slice 01 (#84); that artifact tree is gitignored
  and absent from this checkout, so the prompt is rendered from
  prompts/planner.md over the material the repository carries and each seeded
  fixture's provenance is recorded in eval-packs/afk/README.md rather than
  inside the bytes the role reads

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
  each seeded fixture's provenance is recorded in eval-packs/afk/README.md
  rather than inside the bytes the role reads

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

## Fixture provenance

Where each `fixtures/` payload came from, and what was reconstructed. This is
the record that used to sit in a comment at the top of the file itself; it lives
here because the role under test reads the file and must not read this.

### `192-context-pre-restart-1.md` — case 1

The explorer evidence map the PRD 4 slice-01 planner read on launch
`run-20260907-223720`, archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-1/context.md`
(#192 "Evidence"). That tree is gitignored and absent from this checkout, so the
map is rebuilt from what the repository does carry: the shape and still-true
FACTs of the committed
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/context.md`
(the later Claude-backend run's map), GH #84 as of 2026-09-07, and PRD 4's
`prd.md` at `93bf6bd`. Two deliberate differences from the committed map put it
back at this launch's state of knowledge: the `#194` casing FACT and the
`src/gate-policy.ts` naming inferences are absent (both post-date 2026-09-08),
and D1's `gatePolicy` member shapes stand as an UNKNOWN, because `fe2628a`
("fix D1's version-1 gatePolicy member shapes") had not been written when this
launch ran.

### `192-context-pre-restart-2.md` — case 2

The same map at launch `run-20260907-225023`
(`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-2/context.md`),
rebuilt from the same in-repo material. D1's member shapes are settled here
(`fe2628a`, 22:50, is the amendment that restarted the run) and the open
question has moved to D5 — how a waiver's `path` is matched against a changed
path. The `#194` casing FACT is absent, because it post-dates 2026-09-08.

### `192-context-final.md` — case 3

The same map at launch `run-20260907-231823`
(`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/context.md`),
rebuilt from the same in-repo material. D1's member shapes (`fe2628a`) and D5's
remaining silences (`3cbf09c`) are settled, and only D6's `testGlobs` matcher
dialect is left open. The map carries the repository facts that decide it — AFK
has no runtime dependencies and `src/` holds no glob matcher — which is what
#192 records the operator finding "in one grep". The `#194` casing FACT is
absent, because it post-dates 2026-09-08.

### `192-issue-84.md` — cases 1, 2 and 3

An excerpt of GH issue #84 ("Gate policy reader"), the slice body the three
2026-09-07 planner launches were handed. GitHub keeps no versioned body, so the
live body was read with `gh issue view 84 --json body` and reduced to the parts
that existed on 2026-09-07 and that the three escalated questions turn on.
Removed, because each post-dates those launches: the "Scope history" paragraph
and every mention of #193 and #195 (slice 01 was split on 2026-09-08,
`9e888b8`, `71eb394`, so on 2026-09-07 this slice still carried feedback
integrity and the file-scope gate); the "Two exports, and both need a
success-path assertion" section, which cites "Round 1 on 2026-09-08"; and the
"Round 2 on 2026-09-08 died at 105,796 bytes" sentence in the size-discipline
note. Nothing was added, and the sections kept are verbatim.

### `192-prd4-excerpt.md` — cases 1, 2 and 3

An excerpt of `.kiro/specs/afk-v2-acceptance-scope-gates/prd.md` (PRD 4) as
committed at `93bf6bd` (2026-09-07 17:14 -0300), which is the PRD text the three
launches read. PRD 7's `prd.md` D2 names the base commit `de7b0ec` for this
excerpt; PRD 4's `prd.md` is untracked at `de7b0ec` (`git ls-tree de7b0ec` lists
no `.kiro/specs/afk-v2-acceptance-scope-gates/` path) and was added one commit
later at `93bf6bd` the same day, so `93bf6bd` is the reachable state of the same
document, and `de7b0ec` is the code base commit whose `package.json` carries the
"no runtime dependencies" fact case 3 turns on. Only D1, D5 and D6 are
excerpted — the three decisions the three escalations named. Nothing is edited;
the amendments that later settled D1's member shapes (`fe2628a`), D5's remaining
silences (`3cbf09c`) and the last three decisions (`7b2dcea`) are deliberately
absent, because none existed when these launches ran.

### `194-contract.md` and `194-acceptance-manifest.json` — case 4

The round-1 contract pair the contract evaluator reviewed on
`run-20260908-014522` for PRD 4 slice 01 (#84), archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/` (#194
"Evidence"). That tree is gitignored and absent, and the pair committed at
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/` is the
*later* successful run's: slice 01 was split on 2026-09-08 (`9e888b8`,
`71eb394`), so the committed contract carries twelve behaviors, no `B-16`, and
no casing difference. The pair here is therefore hand-authored to reproduce the
one condition #194 records about the round it lost — the contract and `B-16` say
`ARCHITECTURE.md` while the manifest's `fileScope` declares `architecture.md` —
from #194's quotation of that disagreement, #84 as of 2026-09-08 (pre-split, so
the slice still carries the feedback channel and the file-scope gate that became
#193 and #195), the committed slice-01 pair for section order, heading set and
citation style, and PRD 4's `prd.md` D1–D6. Nothing else about the pair is
asserted as archived fact; the casing difference is quoted verbatim from the
issue.

### `194-feedback-r1-a1.md` — case 4

The durable finding lineage that round was handed: the feedback document of the
*previous* attempt, `run-20260908-005855`, archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/reviews/feedback-r1-a1.md`
(#194 "Evidence"), also absent from this checkout. Rebuilt from #194's two
quotations of that round — that its round-1 review raised the same point ("The
manifest's ARCHITECTURE.md path casing does not match the file") and that the
run "died at 105,796 bytes" when the revision prompt overflowed its inline
budget — plus the shape, heading set and voice of the committed
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/feedback-r1.md`.
Its part in the case is the lineage pressure it puts on the reviewer: a prior
round already raised the casing, so the reviewer under test is invited to
inherit it as blocking.

### Cases 6 and 7 — the two PRD 4 contract pairs

- `prd4-contract-a-contract.md` and
  `prd4-contract-a-acceptance-manifest.json` — the committed `contract.md` and
  `acceptance-manifest.json` of PRD 4 slice `02-behavior-coverage-gate`.
- `prd4-contract-b-contract.md` and
  `prd4-contract-b-acceptance-manifest.json` — the same two files of PRD 4 slice
  `05-test-cost-split-and-caching`.

Both pairs are verbatim copies from
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/`, and each is the pair its
slice's recorded `contract-review.json` verdict was returned on.

### Cases 8 and 9 — the two PRD 4 QA contracts

`prd4-qa-a-contract.md` and `prd4-qa-b-contract.md` are verbatim copies of the
committed `contract.md` of PRD 4 slices `03-candidate-evaluator-isolation` and
`08-file-scope-gate`.

### `prd4-qa-a-change-summary.md` — case 8

The `change-summary.json` the QA evaluator was handed for PRD 4 slice 03
(`03-candidate-evaluator-isolation`, #91). The production artifact is JSON
written by `writeCandidateChangeSummary` (`src/change-summary.ts:223`) into the
slice's `.afk/artifacts/**` directory, which is gitignored and absent; this
payload is the same facts rendered as the Markdown the evaluator-qa prompt
points at with `{{CHANGE_SUMMARY_PATH}}` (`prompts/evaluator-qa.md:27-29`),
because the locked fixture name ends in `.md`. Every number in it was recomputed
from this repository with `git log --format='%h %s' 3b9c78f..3eab903`,
`git diff --name-status` and `git diff --numstat` over the same range: `3b9c78f`
is `78c56bb^`, the commit the slice's first commit was written on, and `3eab903`
is the slice's final commit. The four artifacts the QA stage itself produces —
`qa-report-r1-a1.md`, `qa-report-r2-a1.md`, `qa-report.md` and `qa-review.json`
— are excluded, because they did not exist in the candidate tree the evaluator
graded; the totals are the totals of the rows listed. Nothing else is filtered,
and no row's counts are adjusted.

### `prd4-qa-b-change-summary.md` — case 9

The same document for PRD 4 slice 08 (`08-file-scope-gate`, #195), rendered the
same way for the same reason, with every number recomputed from
`git log --format='%h %s' 4f84374..8db5ecd` and the matching
`git diff --name-status` / `--numstat`: `4f84374` is `6a40f16^`, the commit the
slice's first commit was written on, and `8db5ecd` is the slice's final commit.
The three artifacts the QA stage itself produces — `qa-report-r1-a1.md`,
`qa-report.md` and `qa-review.json` — are excluded for the same reason. Nothing
else is filtered, and no row's counts are adjusted.
