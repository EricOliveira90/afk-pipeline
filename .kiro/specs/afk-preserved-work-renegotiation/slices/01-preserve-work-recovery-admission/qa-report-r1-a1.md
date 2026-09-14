# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

### Commands run

- `pnpm install --frozen-lockfile` — PASS (13s; the `prepare` script's
  `tsc -p tsconfig.build.json` also succeeded). Run here because the gate
  authorization's install ran in a different checkout.
- `pnpm run typecheck` — PASS. I initially intended to cite the skip
  authorization (gate attempt `5e8b32e9-d843-4d5e-8565-27dbf69fd10c`, tree
  `dd2a57ac9470c792bd75c0ae9866e88ba7239ccd`), but QA-01's probes modified
  `src/cli-options.ts`, which voids it, so I ran `pnpm run typecheck` myself
  after reverting the probes. `tsc --noEmit` exits 0 on the restored tree and
  `git diff -- src/cli-options.ts` is empty.
- Probe (not a pre-QA command, run because test honesty is one of the four
  questions and no gate ran the tests):
  `pnpm vitest run src/preserve-work-recovery.test.ts src/cli-options.test.ts src/run-state.test.ts src/eval-boundary.test.ts src/cli-entries.test.ts`
  — 5 files, **214 tests passed**, 8.03s. Every behavior-ID-named test is green.
  I did not run the full suite: the orchestrator runs it after this stage.

### Behavior coverage

Every ID has at least one test whose name contains it, so
`vitest run --testNamePattern <id>` selects it: B-01 through B-12 and P-01
through P-05 all resolve, and PRD 7's unrelated `P-05` in
`src/eval-boundary.test.ts` is green alongside this slice's.

Spot-checked against observed behavior rather than name alone:

- **B-01/B-02** — the accepted return lives on
  `parseStaleRenegotiationRequest` and the #335 refusal on
  `parsePipelineRuntimeOptions`, exactly as the contract's recorded decision
  requires. Seven refusal rows, each asserted on both functions, with a
  set-cardinality check proving no two messages are equal.
- **B-03** — reason canonicalization is asserted by code point, not just by
  string equality, so a Unicode-normalization pass would be caught.
- **B-04** — the exact byte string is pinned and its SHA-256 compared against
  an independently computed digest; order-, mode- and padding-sensitivity are
  each asserted.
- **B-05** — eight rows, one per refusal code, each failing exactly one
  predicate from a baseline that is separately proven eligible, with branch
  tips, pair bytes and the run-state file asserted byte-identical after each
  refusal.
- **B-07/B-08/B-09** — the snapshot is verified on the bytes *in the temporary
  sibling* (the bytes that get published), the `afterTemporaryWritten` seam
  actually corrupts that copy to prove the check, and B-08's real spawned child
  mutates persisted scope between publication and the lock; the refusal is
  `facts-changed-before-lock`, the published snapshot is inert and
  `recoveryLineage` is absent from the state document.
- **B-10/P-03/P-04** — v3–v6 load without loss, six malformed-lineage shapes
  degrade to `undefined`, and P-04 diffs a fully populated state (resume,
  migrations, baselines, waivers, final evaluations, quality stages) before and
  after the append.
- **B-12** — all three entries are pinned to the shared parser, and the usage
  probes confirm neither flag is advertised.

### Boundary compliance

Every changed file is in the contract's declared list:
`src/cli-options.ts`, `src/cli-options.test.ts`, `src/cli-entries.test.ts`,
`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts`,
`src/run-state.ts`, `src/run-state.test.ts`, `src/eval-boundary.test.ts`,
`ARCHITECTURE.md`. Everything else added is PRD/slice artifact material under
`.kiro/specs/afk-preserved-work-renegotiation/`, which the definition of done
exempts. No new migration file. `src/git.ts`, `src/worktree-processes.ts`,
`src/file-lock.ts`, `src/orchestrator.ts` and `src/wave.ts` are untouched, and
no test in the `orchestrator`, `wave`, `qa-orchestration` or `clean-failed`
suites was added or modified. No `SCOPE_AMENDMENT` is needed.

Two boundary observations that are **not** findings:

- `ARCHITECTURE.md` gains its one module-table row and also reflows the closing
  "Tests:" bullet from three lines to two. That is inside a declared file and
  is how the file stays under its 150-line cap (it is now 140 lines), so it is
  necessary work, not scope creep.
- `src/preserve-work-recovery.ts` imports a fourth `src/git.ts` export,
  `resolveCommit`, alongside the three P-05 pins. B-09 requires the `PENDING`
  event to carry `sliceHead` and `featureHead`, which cannot be obtained
  without a git read, and it is used in admission, never inside
  `evaluateRecoveryEligibility` — where the test proves the surface is exactly
  the three injected probes. The import is declared openly in the test's own
  `GIT_IMPORTS` list rather than hidden, `src/git.ts` is unmodified and no
  signature moved, so the substance of P-05 holds. Reporting it would ask for
  correct, necessary work to be removed.

### Preservation

P-01, P-03, P-04 and P-05 all check out: the 75 pre-existing
`src/cli-options.test.ts` cases still pass unchanged, `adaptLoadedState` loads
v3–v6 without loss, the lineage writer mutates only through
`transactRunState`, and the two shared lock primitives keep their exact
signatures (asserted as source text, and confirmed by reading
`src/run-state.ts:598-639`).

P-02 fails — not because the parser misbehaves (it does not; the members are
present and `undefined`, and no recovery code is reachable from
`src/cli-options.ts`), but because the single test that is supposed to prove it
cannot fail. See Finding 1. Preservation is graded on checked evidence, and
here there is none.

## Pass 2: Quality & Craft

Not run: Pass 1 is not clean. What I read while judging Pass 1 was of high
quality — every non-obvious choice in `src/preserve-work-recovery.ts` carries
its reason (why the snapshot publishes outside the lock, why the recheck must
be inside it, why probes are injected rather than imported, why a malformed
event degrades the whole target's list), refusal codes are stable and one per
distinguishable cause, and the version-comment block documents v7 the way
ADR 0018 asks. Nothing in the two advisories below is a material
maintainability problem.

## Resolved findings
- None — this is the first QA round for this slice and no findings were routed
  into it.

## Findings

### Finding 1 — The P-02 test cannot fail: it deep-equals the parsed options against themselves
**Severity:** Blocker
**Pass:** 1
**Evidence:**
`src/cli-options.test.ts:485-503`. The load-bearing assertion is

```js
expect(options).toEqual({
  ...options,
  renegotiateStale: undefined,
  recoveryReason: undefined,
});
```

The expected value is derived from the actual value, so no behavior of
`parsePipelineRuntimeOptions` can turn it red. Two probes in this disposable
worktree confirmed it:

1. Added `...({ qaProbeBogusMember: "leaked" } as Record<string, never>)` to the
   returned object literal in `src/cli-options.ts`, then ran
   `pnpm vitest run src/cli-options.test.ts -t "P-02"` →
   `Tests  1 passed | 74 skipped (75)`.
2. Reverted that, then deleted the `renegotiateStale,` and `recoveryReason,`
   members from the returned object literal outright and re-ran the identical
   command → `Tests  1 passed | 74 skipped (75)`.

Both probes are reverted: `git diff -- src/cli-options.ts` is empty and
`pnpm run typecheck` exits 0 on the restored tree.

The two `toBeUndefined()` calls above it do not rescue the test — reading an
absent property also yields `undefined`, which is why probe 2 stayed green — and
the manifest's third clause, "asserts injected recovery seams recorded zero
calls", has no counterpart anywhere in the file.

**What the contract expected:** acceptance-manifest.json P-02 —
"a unit test named for P-02 deep-equals the parsed options against today's
expected object, asserts both new members are `undefined` by key, and asserts
injected recovery seams recorded zero calls". contract.md P-02 — "the parsed
options carry the new members as `undefined`".

**What I observed:** P-02's behavior is in fact correct in the shipped code, but
its only test asserts nothing: it survives both the addition of an unrelated
member to the parser's result and the complete removal of the two members it
exists to pin. P-02 is covered in name only.

### Finding 2 — B-11's "a retry is always a new attempt ID" is asserted nowhere
**Severity:** Minor
**Pass:** 1
**Evidence:** The transition table is exhaustively covered (16 ordered pairs,
plus a cardinality check that exactly four are legal and none returns to
`PENDING`). The append-only half is covered for "the earlier event survives".
The attempt-ID half is not: `src/run-state.test.ts:1381-1400` reuses
`attemptId: "attempt-1"` on purpose (correct for a terminal event), and
`src/preserve-work-recovery.test.ts:823-841` hand-supplies `"one"` and `"two"`.
Every `admitStaleRenegotiation` call in the suite passes an explicit
`attemptId`, so `args.attemptId ?? randomUUID()` at
`src/preserve-work-recovery.ts:659` — the line that makes a retry a fresh ID —
is never executed.
**What the contract expected:** acceptance-manifest.json B-11 — "a table-driven
unit test named for B-11 asserts accept/refuse for every pair and asserts a
retry produces a new attempt ID with the earlier event still present
byte-identical".
**What I observed:** No assertion that two attempts get different IDs, and the
default ID-minting branch is dead in the suite.

### Finding 3 — src/run-state.test.ts ends without a trailing newline
**Severity:** Minor
**Pass:** 1
**Evidence:** `git diff main...HEAD -- src/run-state.test.ts` ends with
`\ No newline at end of file`. The same diff for the other eight changed files
carries no such marker.
**What the contract expected:** Repo convention — files end with a newline, so
the next append is a one-line diff.
**What I observed:** The file's last byte is `}` at `src/run-state.test.ts:1522`.
