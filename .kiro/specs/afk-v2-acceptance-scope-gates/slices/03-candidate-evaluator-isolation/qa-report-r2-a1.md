# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran in this worktree: exit 0. `pnpm run typecheck`
is cited under the skip authorization rather than re-run — PASS at
2026-09-11T04:02:24.001Z (5.2s), evidence artifact
`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-224601/gates/s03/attempt-f96e760c6c2c.json`,
gate attempt `f96e760c-6c2c-4fe4-af2d-ad326f166733`, tree
`23960b39592b7a760e5c6af4a1e97e86df8737ab`. No file under review was modified, so
the authorization stands.

Boundary: `git diff --name-only main...HEAD` lists 25 paths, all in the contract's
declared file list (`ARCHITECTURE.md` matching the manifest's case-insensitive
entry) plus this slice's own spec directory. `src/candidate-gate-phase.ts` is
declared but unchanged, which is permitted. `src/git.ts` is unmodified and neither
new git read routes through `statusPorcelain`, `diffTreePaths`,
`logCommitsWithStat` or `listChangedFiles`. No migration files. The only untracked
file is the prior round's QA report.

Since the last round the tree changed in three commits — `3bd9211` (review
worktree name keeps the `-s<n>` suffix last, which `sliceFromCwd` requires),
`0e5998e` and `169be76` (the two coverage fixes plus their handoff notes). No
source behavior changed; `src/qa-orchestration.test.ts` and `handoff.md` carry
the whole of `169be76`.

Preservation: P-01 through P-05 each retain the assertion recorded last round, and
none of the three new commits touches their scenarios.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The two mutation-invisible halves of B-04 are now load-bearing, and by the
cheapest route available — both were folded into scenarios that already spawn
nothing new, exactly the ladder AGENTS.md prescribes:

- The `--ignored` status read: the B-03/B-04 stub writes
  `.afk/artifacts/deep/approved-baseline.json` inside the review worktree and
  edits the tracked `src/app.ts`, and the violation set is asserted with an exact
  `toEqual` over sorted paths. Deleting the second `readStatusPaths` call
  (`src/qa-review.ts:958-965`) drops one element and the assertion fails.
- The seed-manifest subtraction: the B-01/B-02 scenario's first attempt deletes
  the seeded pair in the review worktree *and* rewrites it with differing bytes in
  `ctx.absSliceDir` before throwing, so attempt 2's seed is a genuine `M` against
  the checkpoint tree. The scenario asserts the evaluator read the amended bytes
  (`seenContract`, `seenManifestScope`) and that no `reviewer-write-violation`
  names either path. Dropping `seededPaths` at `src/orchestrator.ts:4962` reports
  attempt 1's two deletions and attempt 2's two modifications, and the assertion
  fails.

The scenario comments say *why* each write exists ("a write under the gitignored
`.afk/` root that only the second `--ignored` status read can see", "the amendment
case B-02 exists for"), which is what keeps the coverage from being re-broken by a
future simplification. `handoff.md` records the same two traps under Gotchas,
including the non-obvious `--ignored` + `--untracked-files=all` interaction that
the implementation depends on.

QA-03's advisory is cleared both ways it allowed: the evaluator-authored
`approved-baseline.json` case is now a real assertion rather than a deviation, and
the two remaining deviations (P-01's relocation, the FAIL-path baseline absence)
are recorded in `handoff.md` with the reason each would be vacuous where the
manifest places it.

## Resolved findings
- `QA-01` — the gitignored-`.afk/` half of the reviewer-write scan had no test.
  Cleared: `src/qa-orchestration.test.ts:3086-3093` writes under the review
  worktree's `.afk/` root, `:3081-3085` edits the tracked `src/app.ts`, and
  `:3133-3145` names both in an exact-set assertion over the
  `reviewer-write-violation` events. Removing the `--ignored` read fails it.
- `QA-02` — the seed-manifest subtraction was asserted vacuously. Cleared:
  `src/qa-orchestration.test.ts:2894-3018` now seeds bytes that differ from the
  checkpoint tree (the amendment case), asserts the evaluator read them, and
  asserts no violation names either seeded path. Removing `seededPaths` fails it.
- `QA-03` — three declared observable results asserted in weaker form. Cleared:
  the `approved-baseline.json` discard is asserted
  (`src/qa-orchestration.test.ts:3068-3072`, `:3113-3115`, `:3141`); the P-01 and
  FAIL-path-baseline deviations are recorded in `handoff.md:68-81`.

## Findings
None.
