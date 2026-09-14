# QA Report

**Verdict:** PASS
**Failure class:** NONE

Round 2. All three routed findings (`QA-01` BLOCKING, `QA-02`, `QA-03`) are
cleared, each confirmed by the probe its clear condition asked for rather than by
reading the fix commit's message. No new finding.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` — exit 0, run here (the skip authorization does
not cover it; it ran in a different checkout).

`pnpm run typecheck` — run here rather than cited, because the probes below
modified `src/cli-options.ts` and `src/preserve-work-recovery.ts` and voided the
authorization. `tsc --noEmit`, no output, exit 0, on the reverted tree
(`git status --porcelain -- src ARCHITECTURE.md` empty). The orchestrator's own
gate evidence for the same tree
(`.afk/logs/.../gates/s01/attempt-d29e62ae6724.json`, tree
`494aa2cadc75dbc1021d8d20f27ba9e8f15f961a`) agrees.

Slice test files, all green:

```
npx vitest run src/cli-options.test.ts src/preserve-work-recovery.test.ts \
  src/run-state.test.ts src/cli-entries.test.ts src/eval-boundary.test.ts
Test Files  5 passed (5)     Tests  216 passed (216)     exit 0
```

**Boundary.** `git diff --stat <merge-base> HEAD -- src ARCHITECTURE.md` touches
exactly the nine paths the contract declares — `src/cli-options.ts`,
`src/cli-options.test.ts`, `src/cli-entries.test.ts`,
`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts`,
`src/run-state.ts`, `src/run-state.test.ts`, `src/eval-boundary.test.ts`,
`ARCHITECTURE.md` — and nothing else. `git diff --exit-code` over
`src/git.ts`, `src/worktree-processes.ts`, `src/orchestrator.ts`, `src/wave.ts`
and `src/file-lock.ts` exits 0, so the five explicitly out-of-scope files are
untouched. `ARCHITECTURE.md` is 140 lines, inside its 150-line cap, with one new
module-table row. `src/eval-boundary.test.ts`' only edit is the pinned literal
`RUN_STATE_VERSION` 6 -> 7 (one line). No new migration file. No spawned pipeline
scenario, and no `orchestrator`/`wave`/`qa-orchestration`/`clean-failed` test
touched.

**Behavior coverage.** All 17 IDs have at least one test whose name contains
them: B-01 4, B-02 3, B-03 5, B-04 3, B-05 3, B-06 2, B-07 3, B-08 2, B-09 2,
B-10 5, B-11 5, B-12 4, P-01 1, P-02 2, P-03 1, P-04 1, P-05 3.

**Preservation.** P-01's exact error strings, P-02's flagless shape (probed
below), P-03's v3–v7 load and round-trip, P-04's `transactRunState`-only
mutation, and P-05's three-stub git surface are each asserted and green.
`src/eval-boundary.test.ts`' `P-05 ... leaves both schema versions alone` — the
name collision the contract flagged — is green with `EVENTS_SCHEMA_VERSION`
still 1.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The tests are substantive, not shape-checking. B-08 spawns a real child process
inside the module's own `beforeLockAcquired` seam and asserts the
`facts-changed-before-lock` refusal, the inert published snapshot, absent lineage
and byte-identical accepted pair. B-07's failure case corrupts the temporary
sibling through `afterTemporaryWritten` and asserts no published directory, no
temporary sibling and no lineage. `sanitizeRecoveryLineage` follows
`sanitizeQualityStages`' precedent and documents why a malformed event drops the
whole target's list. The one seam the contract does not name,
`afterTemporaryWritten`, is not a contention seam, lives inside the declared
module, and is the only way to reach the publication-failure scenario the
contract's own test plan requires — no finding.

## Resolved findings

- **QA-01 (BLOCKING) — the only P-02 test cannot fail.** Cleared.
  `src/cli-options.test.ts:484` now asserts `toStrictEqual` against a
  hand-written 17-key literal, plus an explicit `Object.keys(options).sort()`
  list and two `in` checks. Both probes the clear condition named turn it red:
  deleting `renegotiateStale` from the returned object gives
  `Tests 1 failed | 1 passed` with `- "renegotiateStale": undefined` in the diff
  at line 484 — which is also the present-but-`undefined` vs absent distinction,
  since the key was absent and the literal had it present-and-undefined — and
  adding `probeUnrelatedMember` gives the same failure. A second P-02 case at
  line 539 discharges the manifest's "recovery seams recorded zero calls" clause
  as a source-level assertion that the parser references neither the recovery
  module nor `git.js`, `run-state.js` or `file-lock.js`, which is the only way it
  is true here — the parser cannot reach a seam it does not import.
- **QA-02 (ADVISORY) — no B-11 test asserts "a retry is always a new attempt
  ID".** Cleared. `src/preserve-work-recovery.test.ts:843` admits twice with no
  `attemptId` supplied, resolves the first attempt in between via the legal
  `PENDING -> COMPLETED`, and asserts the two minted IDs differ, the lineage has
  three events, `JSON.stringify(lineage[0])` equals the bytes captured before the
  retry, and two snapshot directories exist. Probe: replacing
  `args.attemptId ?? randomUUID()` with a constant makes it red at line 869
  (`expected false to be true` — the reused ID collided with the
  published-never-overwritten rule), so the minting path really is executed.
- **QA-03 (ADVISORY) — src/run-state.test.ts lost its trailing newline.**
  Cleared. `git diff <merge-base> HEAD -- src/run-state.test.ts` contains no
  `\ No newline at end of file` marker.

All probes were reverted; the tree under review is unmodified.

## Findings

None.
