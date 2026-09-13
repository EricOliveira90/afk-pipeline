# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` was run in this worktree: exit 0 (the
authorization's install ran in a different checkout and did not populate this
one). `pnpm run typecheck` was also re-run here rather than only cited, because
probing modified the tree: `tsc --noEmit`, exit 0, no output. The base-gate
authorization for typecheck (attempt `1ad32c43-b491-4424-8f73-8951d354e03f`,
tree `4fbe0a996458fe9a28d72d93e6609081ac1d5a46`) agrees. Every probe was
reverted; `git status --porcelain` afterwards shows only the two slice artifacts
this stage writes, whose working-copy difference is line-ending normalization
(`git diff` on them is empty).

`.afk/artifacts/afk-v2-agent-eval-harness-claude-code/slice-02/change-summary.json`
does not exist in this worktree (`.afk/` is gitignored, so the disposable
checkout carries none of it). The slice's changes were read from git instead:
`git diff --stat e9eb1a3~1..HEAD` over the eight slice commits.

**Boundary.** The 36 changed paths are the 28 declared file-scope paths plus
eight artifacts of this slice's own spec directory
(`contract.md`, `acceptance-manifest.json`, `context.md`,
`contract-response.json`, `contract-review.json`, `feedback-r1.md`,
`feedback-r2.md`, `handoff.md`). Nothing outside the declared list and the
slice's negotiation record changed. No migration files. No scope amendment is
needed.

**Preservation.** P-01: `src/eval-packs.test.ts` is the only `src/` path in the
diff, and the existing eval suites are untouched. P-02:
`eval-packs/fixtures/refused/01-unknown-member.json` does not appear in the
diff, and `src/eval-packs.test.ts:455-464` re-asserts that `readEvalPack` still
refuses that pack for its `notes` member. P-03: neither `CONTEXT.md` nor
`ARCHITECTURE.md` appears in the diff.

**Behavior checks that hold.** `pnpm vitest run src/eval-packs.test.ts` — 19
tests, all passing. B-01: nine `*.json` case files, ids in `01-`…`09-` order,
seven `CASE_KEYS` members each, `readEvalPack` resolves with every `fromFile`
target present under `fixtures/`. B-04: case 05 is inline-only, `FAIL` /
`IMPLEMENTATION`, and its seeded project is uncontaminated. B-05: verified
independently of the test — `git merge-base --is-ancestor dbd6fdc HEAD` exits 0,
and the four committed artifacts read `ACCEPT`, `ACCEPT`, `PASS`/`NONE`,
`PASS`/`NONE`, matching the four cases' `expected`. A mutation probe confirmed
the B-05 assertion is honest: rewriting `06-prd4-contract-a.json`'s `expected`
to `REVISE` failed the test with `expected 'REVISE' to be 'ACCEPT'`; the file
was restored with `git checkout --`. B-07: the README lists all nine cases in
declared order with `role`, `expected` and a verbatim `source`, plus
`afk-claude eval --pack eval-packs/afk`. B-08/B-09: the consumer pack resolves
as one `pm` case and its stub dispatch records `MATCH` and `MISMATCH` through
`report.json`. B-10: `runEvalCli` is the only exported dispatch seam in
`src/eval-command.ts` (its only other exports are `EvalCliDeps` and
`DEFAULT_EVAL_DEPS`), so the test's `runEvalCli(`-argument scan is a complete
one, and no scanned argument list names the AFK pack.

The blocking defect is in the seeded material itself: see Finding 1.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 2 was not completed, because Pass 1 is not clean. What was observed in
passing is good: the test file's header explains why the AFK pack is never
dispatched, `dispatchArguments` matches by parentheses rather than by line, the
B-05 assertion reads the committed verdict off disk instead of restating a
literal, and the README's "Why only final-round verdicts" section records the
D2 reasoning where a reader will find it.

## Resolved findings
- none — this is the first QA round of this slice.

## Findings

### Finding 1 — Four seeded fixtures state the case's graded answer inside the file the role is told to read
**Severity:** Blocker
**Pass:** 1
**Evidence:** A probe (`src/qa-probe.test.ts`, since deleted) dispatched
`03-192-final-planner` through the real runner — `runEvalCli` with
`buildEvalStubProvider` over a temp copy of the pack — and printed the
`inputs/context.md` the stub found in its scratch directory. Lines 18-19 came
through verbatim:

```
one grep". The expected artifact for this case is therefore a CONTRACT: the
planner should decide the dialect and record it, not escalate.
```

and `expect(seen[0]).toContain("The expected artifact for this case is therefore a CONTRACT")`
passed. Seeding is `copyFileSync` (`src/eval-command.ts:147`), so nothing
strips the comment. Three more seeded files carry the same disclosure:

- `eval-packs/afk/fixtures/192-context-pre-restart-1.md:19` and
  `192-context-pre-restart-2.md:16` — "That UNKNOWN is what the planner
  escalated." Cases 01 and 02 expect `ESCALATION`.
- `eval-packs/afk/fixtures/194-feedback-r1-a1.md:21-23` — "The point of this
  fixture in the case is the lineage pressure it puts on the reviewer … The
  graded answer is that inheriting it is wrong — the repository decides the
  comparison, and the finding is at most advisory." Case 04 expects `ACCEPT`.
- `eval-packs/afk/fixtures/194-contract.md:12-15,22` additionally names the
  defect the fixture injects: "This file is therefore hand-authored to reproduce
  the one condition #194 records … the casing mismatch is the load-bearing
  detail."

Each file is a `fromFile` target of the case whose answer it states, and each of
those cases' prompts instructs the role to read it: "The explorer's evidence map
for this slice is seeded in this working directory at `inputs/context.md`. Read
it as if it were inlined here."

**What the contract expected:** B-02 — "each case's `files` carry that
escalation's `context.md`, the PRD 4 excerpt at `de7b0ec` and the #84 body
excerpt"; B-06 — every case "carries a non-blank `source`" naming "the path it
reconstructs from plus `hand-reconstructed`". `prd.md` D2 fixes that "S2 owns
the exact prompt text and `files` of each case", and slice 01 defines the two
members as what the role receives: `prompt` is "the exact `InvokeOptions.prompt`
the role receives" and `files` are "Seeded into the case's fresh scratch
directory" (`src/eval-pack.ts:69,71`). Provenance has a home the role never
reads — the `source` member — and the README already repeats it for humans.

**What I observed:** Four of the eight seeded Markdown fixtures open with a
hand-authored HTML comment that names the eval case, announces the file is a
reconstruction, and states the artifact or verdict the case expects. Cases 01,
02, 03 and 04 therefore cannot discriminate: a model that reads its seeded input
— which the prompt orders it to do — has been handed the answer, so a dispatch
returns `MATCH` independently of the judgment the case exists to measure. That
is four of the nine cases, including all three of B-02's and the only one of
B-03's. Nothing in `src/eval-packs.test.ts` asserts over the fixture bytes, so
the suite is green with the leak in place.

### Finding 2 — The other four seeded fixtures announce themselves as eval fixtures to the role under test
**Severity:** Minor
**Pass:** 1
**Evidence:** `eval-packs/afk/fixtures/192-issue-84.md:1-2`,
`192-prd4-excerpt.md:1-2`, `prd4-qa-a-change-summary.md:1-2` and
`prd4-qa-b-change-summary.md:1-2` each open with
`<!--` / `Hand-reconstructed fixture for eval-packs/afk case <id>.` and continue
with reconstruction bookkeeping — "Removed, because every one of them post-dates
the launches this case reconstructs", "Every number below was recomputed from
this repository with `git log --format='%h %s' 3b9c78f..3eab903` …". Confirmed
with `foreach ($f in Get-ChildItem eval-packs/afk/fixtures) { Get-Content $f.FullName -TotalCount 1 }`:
eight of sixteen fixtures start with `<!--`. `src/eval-command.ts:147` copies
them byte-for-byte.

**What the contract expected:** B-02 seeds "the PRD 4 excerpt at `de7b0ec` and
the #84 body excerpt"; B-05 seeds the change summaries "the
`prd4-qa-a-change-summary.md` / `prd4-qa-b-change-summary.md` fixtures". Those
are the documents as the graded agent saw them, and no real run's inputs carry a
note about which eval case they belong to.

**What I observed:** Four documents the role reads as a live issue body, PRD
excerpt and change summary instead tell it that it is inside a reconstructed
eval case and what was trimmed. No expected answer is disclosed, so this is a
fidelity note rather than a leak — but the fix is the same one Finding 1 needs,
and the two are best cleared together.
