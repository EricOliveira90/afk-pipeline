# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here (exit 0) — the skip authorization does
not cover it. `pnpm run typecheck` I ran myself rather than citing the
authorization, because I probed the tree (see QA-09) and that voids it; `tsc
--noEmit` exited 0 after the probe was reverted and `git status -s` showed no
source file modified.

Behavior suites: `pnpm vitest run src/final-evaluation.test.ts
src/qa-orchestration.test.ts` → `Test Files 2 passed (2)`, `Tests 98 passed
(98)`, exit 0, 199s. The two scenarios the routed findings turn on both pass:
`[behavior:B-02] records a reuse in all three stores and dispatches no evaluator
when the writing stage writes nothing` (7.6s) and `[behavior:B-03] runs an
injected post-approval writing stage and evaluates the tree it dirtied exactly
once` (10.1s).

Boundary: `git diff --name-only $(git merge-base main HEAD) HEAD` touches 21
source/doc paths, every one of them declared in `## Files expected to change`,
plus this slice's own `.kiro/.../04-final-evaluation-and-reuse/` artifacts. No
undeclared path, no migration. `src/gate-runner.ts` is absent from the diff, as
the contract requires.

Preservation: P-06's enumerated scope holds exactly — `git diff` on
`src/run-state.test.ts` is the eight version assertions moved `4` → `5` plus the
one retitle at `:1491`, and the four `version: 4` input fixtures (`:250`,
`:275`, `:1564`, `:1575`) are untouched, so the "a v4 file still loads"
coverage survives. P-01 through P-05 are covered by the green suites above and
by the wave-suite citation discussed under QA-08.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

`src/final-evaluation.ts` reads well: closed repair vocabulary, a
`REPAIRS_BY_CLASS` table that refuses an inadmissible pairing at parse time,
`decideFinalVerdict` naming every blocker independently and failing closed on
`null`. The `baselineAuthorizedTreeId` IIFE in `src/orchestrator.ts` carries the
reason it exists in its own doc comment and reuses the accept seam's own window
check rather than inventing a second rule. One note, carried as QA-09: the
operator-facing prose for the reuse was not updated alongside it.

## Resolved findings

- **QA-07 (BLOCKING) — the reuse decision was unreachable.** Resolved.
  `FinalReuseBaseline` gained `approvedTreeId`, and `src/orchestrator.ts` offers
  the accepted tree there only after `reviewArtifactViolations` (the accept
  seam's own check, with the same audited amendment blobs) proves the QA window
  explains every path by which it differs from the graded baseline tree; absent,
  the comparison falls back to the graded tree and answers `evaluate`.
  `postApprovalWriteChangedTree` and its branch are deleted, so
  `decideFinalReuse` is the only comparison deciding the dispatch. The
  `[behavior:B-02]` assertion is now a spawned run with the writing stage set to
  production's no-op, reading the decision, the single journaled event, the
  summary section and `finalCalls === []` back out of that run; the
  hand-seeded store tests were retitled to claim only the round-trip they check.
  The tree-changing case still dispatches exactly one evaluator (`[behavior:B-03]`).

- **QA-08 (ADVISORY) — P-01 grepped for `mergeMutex` instead of observing a
  serialized merge.** Resolved via the second remedy the clear condition allows.
  The in-slice test is retitled `introduces no second lock primitive anywhere in
  this slice's modules`, widened to all ten of the slice's modules, and matches
  lock identifiers rather than the word. The behavior claim is cited by exact id
  to `src/wave-migrations.test.ts:1452` `it("B-05: holds the merge mutex across
  the refused attempt, the round and the retry")`, which I read: it instruments
  the mutex, queues a competitor inside the critical section, performs a real
  `git merge` and commit, and asserts the acquisition count never moves and the
  competitor only ran after the retry landed. `handoff.md` records the split.

## Findings

### Finding 1 — the reuse summary tells the operator the wrong reason
**Severity:** Minor
**Pass:** 2
**Evidence:** Probe in this disposable worktree — two `console.log`s added to the
`[behavior:B-02]` scenario, then `pnpm vitest run src/qa-orchestration.test.ts -t
"records a reuse in all three stores"`:

```
QA-PROBE finalTreeId=ca73af39ebc5d6ea3843adf34caadd09d8d3fb0a baselineTreeId=6e874143d63a38bcf223f1529f0945c5b9732e3e equal=false
QA-PROBE SECTION>>>
## Final Evaluation Reuse

The final checkpoint was byte-identical to the approved baseline, so no final
evaluator was dispatched (#96, PRD D20 — exact tree equality, no cosmetic
exception).

| Slice | Round | Final tree | Baseline tree | Evaluator invocations |
|-------|-------|------------|---------------|-----------------------|
| 70 | 1 | ca73af39ebc5d6ea3843adf34caadd09d8d3fb0a | 6e874143d63a38bcf223f1529f0945c5b9732e3e | 0 |
<<<
```

Reverted with `git checkout -- src/qa-orchestration.test.ts`; typecheck re-run
green afterwards. This is structural rather than a fixture artefact:
`src/orchestrator.ts:6272` records the baseline at `checkpoint.treeId` (the
pre-QA-artifact tree) and the event at `:6743-6750` carries that same
`baselineTreeId`, so the two columns differ in every production reuse.

**What the contract expected:** B-02 — "the reuse fact is written to three
in-scope stores", one of them "the slice's `run-summary.md` section in
`src/logger.ts`", so that an operator can see why zero final evaluators ran.
**What I observed:** `src/final-evaluation.ts` and `handoff.md` were updated to
the authorized-tree wording; `src/logger.ts:590-604` and the
`final-evaluation-reuse` doc comment in `src/run-events.ts:248-252` still assert
byte-identity and "exact tree equality" directly above a row whose two tree
columns are different strings, and neither the section nor the event carries the
authorized tree ID that would reconcile them. The behavior is right; the
explanation the operator reads is not. Advisory: no assertion or shipped
decision depends on the wording, and the existing test only checks that the
section contains `finalTreeId`.
