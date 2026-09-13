# Contract feedback — round 1 (eval runner, #262)

## What this round fixed

All five findings carried in from the previous attempt are closed, and four of
them are closed the way their clear-conditions asked rather than by weakening
the obligation.

**The exit-1 path is now reachable (F-01).** B-24 names a concrete trigger — an
injected `deps.stdout` that throws on the first per-case line — and that trigger
sits on a seam B-26 already declares as part of `EvalCliDeps`. B-22 puts exactly
one line through that seam as each case completes, and B-21 keeps the summary
line out of it, so the throw lands after exactly one dispatch and before any
report write. B-24 also states the exclusivity rule in the contract text: every
provider-side failure is absorbed as a per-case `ERROR` by B-13 and B-14, so
only a runner-seam throw reaches exit 1. That sentence is what makes the three
exit codes a partition rather than three unrelated claims.

**The versioned per-case schema is closed (F-02).** B-19 now carries
`scratchDir` with the presence rule B-17 needs, admits B-20's `costUsd` and
`toolCallCount`, adds `durationMs` with its own rule, and says outright that the
list is exhaustive and is what `EVAL_REPORT_VERSION = 1` locks. B-17 and B-19
no longer pull an implementation in opposite directions, and B-19's exact
own-key-set assertion still fails on any drift.

**The two output channels are partitioned (F-03).** B-21 states that the summary
line lives only in the returned `output` and never goes through `deps.stdout`,
enumerates what `output` holds on each of the three exit paths, and asserts "no
line appears in both". The double-print that a real `afk eval` run could
otherwise have produced is now excluded by a declared observable rather than
left to implementer taste.

**The seeding assertion declares why its directory survives (F-04).** B-08 says
its case's `expected` deliberately contradicts what the stub writes, so the
outcome is `MISMATCH` and B-17's post-`MATCH` cleanup does not apply.

**Stub affordability is now a stated scope decision (F-05).** The scope lock
commits `src/eval.fixtures.ts` to importing the existing builders instead of
re-deriving schemas by hand, and every citation holds on this checkout:
`writeContractReview` at `src/test-support.ts:33`, `writeQAReview` at `:100`,
`writeAcceptanceManifest` at `src/orchestrator.fixtures.ts:326` and
`REVISION_PLANNER_ESCALATION` at `:48`. The hand-authored residue is bounded to
a five-field `final-review.json` and two guardian markdown files whose parser
never throws. That was the largest hidden cost in the previous attempt and it is
now bounded work rather than open-ended schema authoring.

Two other spot-checks came out in the contract's favour. B-05's evaluator-final
fixture uses `expected.verdict` of `"ACCEPT"`, and `FinalReviewVerdict` is
`"PASS" | "FAIL"` (`src/final-evaluation.ts:139`) — so that value genuinely is
one the role's parser could never produce, and the scenario is honest. The new
readers also bind both halves of the parser-regression evidence: B-01 is the
newly accepted input, B-02 through B-07 are the rejected and boundary inputs,
and B-28 pins one committed refusal fixture at a concrete path.

## What still needs to change

**The import-boundary rule scans a file that has to break it.** B-27's excluded
set is closed: the four `src/eval-*.ts` modules and the three CLI entries.
`src/eval.fixtures.ts` is not a `*.test.ts` file and is not on that list, so it
falls inside the scanned set — but it is the slice's own pack and stub fixture
module, and the pack-building helpers B-06 and B-08 depend on cannot type an
`EvalCase` or drive `readEvalPack` without importing `./eval-pack.js`. The
explorer notes this kind of source-level boundary test is new to the repo with
no existing helper, so "non-test file" has no established local meaning that
settles whether a `.fixtures.ts` module counts.

That leaves two bad outcomes and no declared way to choose between them. Read
literally, the B-27 test flags the slice's own fixture module and the slice
cannot pass. Read loosely, the generator adds an eighth exclusion the contract
never authorized, and the boundary rule that exists to keep `orchestrator.ts`
and the gate modules clear of the eval runner is being asserted in a shape
nobody reviewed. Naming `src/eval.fixtures.ts` in B-27's exclusion set fixes it,
as does stating that the fixture module imports no eval module and is held to
the same prohibition — either sentence turns the gate's evidence back into
evidence for the declared rule.

**Say where the refusing packs live.** B-02 through B-07 need roughly fourteen
refusing packs, and the only declared pack path is
`eval-packs/fixtures/refused/01-unknown-member.json`. That `01-` prefix reads as
the first of a numbered series, but the definition of done requires `git status`
to show only the listed paths, so committing `02-…` through `14-…` would break
the slice's own last checkbox while writing them into a per-test temp directory
would not. B-02's "a sibling fixture pack" and B-06's four `files`-key packs
give no location either way. One sentence in the scope lock — the refusing packs
are built in a temporary directory per test, and the one committed pack is
B-28's — settles it. This is advisory: it costs a rework round if guessed wrong,
but it does not make any behavior untestable.

## Nothing else is in the way

Gate assignments look apt throughout: every behavior carries `tests` and
`acceptance:behaviors`, the schema and signature behaviors add `typecheck`, and
the definition of done requires each anchor id to appear in a test name so
`--testNamePattern <id>` yields evidence per anchor. The preservation terms sit
on real evidence — the CLI dispatch order in P-01, the six unmodified parsers in
P-02, `vitest.config.ts`'s include array in P-03, `.gitignore:3` in P-04, and
the two version constants in P-05 all match the explorer's facts. Non-goals name
the neighbouring work explicitly, including that `--record-prompts` and
`src/prompt-recorder.ts` (#264) are already merged on this branch and are not
this slice's to edit or document, which is the point the parent PRD's stale
"Verified facts" section gets wrong.
