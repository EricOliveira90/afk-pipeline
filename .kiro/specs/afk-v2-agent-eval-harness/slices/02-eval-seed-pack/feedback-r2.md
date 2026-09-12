# Contract feedback — round 2, eval seed pack (#263)

## What the revision fixed

The round-1 blocker was that four of the nine cases hung on facts nobody in
this worktree could read: which PRD 4 verdicts a human "later bore out", and
what those verdicts said. The revision solved that by re-grounding the
criterion in committed material instead of the operator's absent
`.afk/artifacts/**/reviews/` tree, and I checked every load-bearing claim in
this checkout rather than taking the planner's word for it:

- `.kiro/specs/afk-v2-acceptance-scope-gates/slices/02-behavior-coverage-gate/contract-review.json`
  and `.../05-test-cost-split-and-caching/contract-review.json` both carry
  `"verdict": "ACCEPT"`.
- `.../03-candidate-evaluator-isolation/qa-review.json` and
  `.../08-file-scope-gate/qa-review.json` both carry `"verdict": "PASS"` with
  `"failureClass": "NONE"`.
- `dbd6fdc` is the merge commit of PR #256 (2026-09-12) and is an ancestor of
  this branch's HEAD, so the "a human bore it out" half of `prd.md` D2 is now
  an in-repo fact the generator can read and a reviewer can re-check.
- Every prompt-reconstruction input B-05 names — each slice's committed
  `contract.md`, `acceptance-manifest.json` and `qa-report-r*-a1.md` — is
  present in those directories.
- `{"verdict":"PASS","failureClass":"NONE"}` is admissible for `evaluator-qa`
  under `EXPECTED_SHAPE` (`src/eval-pack.ts:106-109`), so the new expectations
  will not be refused at read time.

Two things about how the fix was made are worth naming, because they are what
made it reviewable. First, the contract states the consequence of its own
decision instead of hiding it: only final-round verdicts are usable, because a
round-1 `REVISE` would need the round-1 contract pair and no commit carries
one. Second, B-06 now forbids citing the gitignored artifacts tree as the
origin of an `expected` value at all — which is the rule that lets a reviewer
at QA time tell a genuine reconstruction from an invented one.

The round-1 advisory is fixed the same way B-06 already worked: the confirming
fact is the literal substring `confirmed-by: dbd6fdc`, and the manifest's B-05
`observableResult` now asserts that literal plus an in-repo cross-check — read
the artifact path out of the `source`, load that committed JSON, deep-equal the
case's `expected` against its verdict projection. That is a property the
`acceptance:behaviors` gate can decide, not prose a test has to judge. Naming
the tests "for B-05" and "for B-06" also matters, since the gate selects by
`--testNamePattern {behaviorId}`.

## What I would still change

Neither of these blocks the slice.

**The pack no longer discriminates on the contract role.** With `04-`, `06-`
and `07-` all expecting `ACCEPT`, a candidate that answers `ACCEPT` to every
contract prompt scores three out of three; the two PRD 4 QA cases are the same
story for a candidate stuck at `PASS`. Round 1 left `06-`/`07-` open
("a `verdict` in `ACCEPT`/`REVISE`"), so this is a consequence of the fix, not
a pre-existing gap. The reason recorded in B-05 is sound and I am not asking
you to invent a `REVISE` case to fix the arithmetic — `05-`'s
`FAIL`/`IMPLEMENTATION` and `04-`'s false-premise `ACCEPT` still carry real
signal. What is missing is the caveat: one sentence in B-05, the non-goals or
the README requirement saying the pack holds no `REVISE` contract expectation
and no `FAIL` QA expectation from PRD 4, so a per-role score on those cases
cannot separate a correct evaluator from a degenerate one, and naming where the
counter-case would come from later. Without it, the first person to run this
pack will read a clean contract-role score as evidence of evaluator quality.

**One `fileScope` entry was lowercased to `eval-packs/afk/readme.md`.**
Everything else in the pair — the scope lock, B-07, the file list, the test
plan, the manifest's own B-07 text — says `README.md`. No gate fails on it,
because `normalizePath` lowercases both sides before comparing
(`src/acceptance-manifest.ts:71`), but the scope of record now disagrees with
itself about a filename, and reconciling it requires knowing about that
lowercasing. Restore the capitalized form.
