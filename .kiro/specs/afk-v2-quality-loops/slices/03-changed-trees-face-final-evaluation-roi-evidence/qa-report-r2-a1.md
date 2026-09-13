# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` — exit 0, "Done in 8.8s using pnpm v10.33.0".
`pnpm run typecheck` — cited under the skip authorization: PASS at
2026-09-13T14:35:25.090Z (9.5s), evidence artifact
`.afk/logs/afk-v2-quality-loops-claude-code/run-20260913-092420/gates/s03/attempt-d1e453b8cc02.json`,
gate attempt `d1e453b8-cc02-44df-9491-05ffa280a0bf`, tree
`ac5d5b26a816f368bc9e6b462677fac64b9d3be7`. No file under review was modified,
so the authorization holds.

Beyond the pre-QA list, two probes in this disposable worktree — the four routed
findings' clear conditions all name behavior on a run's own stream, so reading
the source was not sufficient evidence:

- `pnpm vitest run src/qa-orchestration-gates.test.ts` — 27 passed, exit 0,
  224.87s. Includes S1 (B-07/B-08/B-12, 28.9s), S2 (P-01/P-06, 12.8s),
  S3 (B-04/B-13, 22.6s) and the new S4 (B-02/B-03/B-07/B-12, 43.1s).
- `pnpm vitest run src/final-evaluation.test.ts src/logger.test.ts src/ship-gate.test.ts src/cleaner-stage.test.ts`
  — 175 passed, 4 files, exit 0, 135.55s. Includes the six `#97` restore-round
  and measured-attempt units in `src/cleaner-stage.test.ts:1043-1236`.

**Boundary compliance.** This slice's own commits (`8bbb969..HEAD`) touch
ARCHITECTURE.md, prompts/cleaner.md, src/cleaner-stage.ts, src/cleaner-stage.test.ts,
src/final-evaluation.ts, src/final-evaluation.test.ts, src/logger.ts,
src/logger.test.ts, src/orchestrator.ts, src/qa-orchestration-gates.test.ts,
src/run-events.ts, src/ship-gate.ts, src/ship-gate.test.ts — every one declared
in the contract's file list — plus the slice's own `.kiro/.../slices/03-*/`
pipeline artifacts. Zero migration files, matching `migrationCount: 0`. No
amendment is needed.

**Preservation.** P-01 and P-06 pass in S2 (reuse with no cleaner declared,
`readQualityStageOutcomes` returns `[]`, header line reads `disabled` and no
table renders). P-02 passes as the re-tagged
`[behavior:#87:P-02] [behavior:#97:P-02]` unit plus S1/S3/S4's `stageCalls`
assertions, which show the stub still invoked synchronously for the stage
itself. P-03 passes in the re-tagged baseline-is-wrong scenario. P-04 passes in
`src/cleaner-stage.test.ts:871`. P-05 passes in `:548`. P-07 passes in S2.
P-08: `git diff 8bbb969..HEAD -- src/orchestrator.ts | Select-String Mutex|acquireLock|lockFile`
returns nothing — the slice introduces no lock primitive.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

`buildWritingStageIds` is pure and exported, so the orchestrator call site is a
call rather than a second copy of the rule, and `routeFinalReviewFinding`'s new
`writingStageIds` is required rather than optional — a forgetful caller gets a
type error instead of the pre-#97 defect. `deriveQualityStageOutcomes` is the one
derivation behind both `readQualityStageOutcomes` and `writeSummary`'s rows, so
the summary and the PR body cannot disagree. `buildQualityStageAttemptEvent`
omits absent optionals rather than writing `undefined`. Each of the three
merged fields on the re-dispatch's result carries a comment naming why it is
merged rather than taken; the `roundsSpent: Math.max(...)` is what keeps ADR
0050's bound from being widened by a restore.

The tests discriminate. S3 seeds two spent rounds so the committing round is 3
of 3: had the code re-derived `roundsAlreadySpent` through
`cleanerRoundsSpent(resumableCleanerStage)` after a `PASS`, a fourth round would
have dispatched and `fixture.cleanerPrompts` would have had length 2 instead of
1. S4's `stageCalls` equality is what fails if a second restore reaches the
stub. The tree-chain assertions read ids off the stream rather than recomputing
them, so they cannot agree with a wrong emitter by construction.

## Resolved findings
- **QA-01** (BLOCKING) — the stale cleaner result behind a second restore. The
  re-dispatch's result now replaces the standing one (`src/orchestrator.ts:8111-8119`)
  and the two tree readings are functions read per attempt (`:7269-7272`). New
  S4 scenario asserts both restores reach the cleaner, the stub is never called
  with `repair: "RESTORE"`, and every attempt's change summary attributes
  README.md to `cleaner` with an empty `post-approval-writing` span. Passes.
- **QA-02** (BLOCKING) — the final-evaluation attempt's `inputTreeId`. Now the
  cited baseline (`src/orchestrator.ts:7747-7749`), with the graded tree as
  `outputTreeId`. S1 asserts both slots and their inequality
  (`src/qa-orchestration-gates.test.ts:1606-1613`). Passes.
- **QA-03** (ADVISORY) — the NUL byte in `src/logger.ts`. Byte scan counts zero
  NULs; `git diff --numstat 8bbb969..HEAD -- src/logger.ts` reports
  `171  4  src/logger.ts`, a textual line diff. The pooling key is now
  `` `${attempt.ghIssue}|${attempt.stage}` ``.
- **QA-04** (ADVISORY) — a restore round's reported input tree.
  `src/cleaner-stage.ts:610-612` resolves the start tree from the worktree on a
  repair, so each restore round names the tree it read. Asserted on the stream
  in S4 (`:1900-1914`) and pinned as a unit at `src/cleaner-stage.test.ts:1138`.
  Passes.

## Findings
None. No new finding was discovered, and all four routed findings are cleared.
