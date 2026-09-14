# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run
- `pnpm install --frozen-lockfile` — exit 0 (run here; the authorized install ran in a different checkout).
- `pnpm run typecheck` — exit 0, run by me rather than cited: I patched
  `src/preserve-work-recovery.ts` for the mutation probes below, which voids the
  skip authorization even though the patch was reverted (`git checkout --` and a
  clean `git status --porcelain` for `src/`). The authorization's evidence
  artifact `attempt-bbdd38e11c99.json` / tree `a4977fda…` agrees.

### Behavior evidence
- `npx vitest run src/preserve-work-recovery.test.ts` — 72 passed, exit 0
  (B-01…B-09, P-01…P-04 all present and named).
- `npx vitest run src/resume-integration.test.ts -t "preserved-work recovery attempt execution"`
  — 1 passed / 29 skipped, exit 0 (the fixture-built B-06 assertion).
- B-05/B-07 hold behaviorally, not just by shape: `inspectExactStageCheckpoint`
  returns `action: "resume"` with the seeded checkpoint *before* execution and
  `action: "reevaluate"` with reason "no exact-stage checkpoint was recorded for
  this slice" after, and the second slice's checkpoint and lineage survive.

### Boundary compliance
`git diff --stat a7a97c2 HEAD` touches exactly the five declared files
(`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts`,
`src/resume-integration.fixtures.ts`, `src/resume-integration.test.ts`,
`ARCHITECTURE.md`) plus this slice's own spec artifacts. No amendment is needed.
`src/exact-stage-resume.ts`, `src/contract-convergence.ts` and
`src/cli-options.test.ts` are unmodified (`git diff --stat` empty for all three),
satisfying P-03 and the P-02 scoping decision. `ARCHITECTURE.md` is 140 lines,
under its 150-line cap.

### Preservation
- P-01: admission still appends exactly one `PENDING` event; the #277 admission
  tests pass unmodified.
- P-02: `parsePipelineRuntimeOptions` still throws the #335 refusal, asserted from
  this slice's own test file; `parseStaleRenegotiationRequest`'s five validation
  messages are re-pinned verbatim.
- P-04: live `contract.md` / `acceptance-manifest.json` bytes are unchanged and
  the module still holds one pair validator and no writer of `**Status:** LOCKED`.
- B-08: branch tips, worktree tree digest, resume counters and `slices` are all
  unchanged, and `rev-list --count feature..slice` is still `1`.

### Test honesty (mutation probes, reverted)
- Probe A — guarded both clear calls behind `QA_PROBE_A`:
  `Tests  3 failed | 69 passed`, failing exactly B-05 ("drops the target's
  checkpoint and lineage"), B-06 and B-07. The clears are genuinely measured.
- Probe B — deleted the live negotiation files immediately after the temporary
  history was written, before verification and `renameSync`:
  `Tests  1 failed | 71 passed`, failing exactly B-02 "deletes nothing and
  publishes nothing when the copy fails verification". The publish-before-delete
  ordering is genuinely pinned, not merely commented.
- Tree restored afterwards: `npx vitest run src/preserve-work-recovery.test.ts`
  → `Tests  72 passed`.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES (see findings — both advisory)
- Test quality: PASS

Notes: the entry point reads its locator from the admitted event rather than
re-deriving it, verifies the copy in the temporary sibling (not the source), and
routes both clears through single-call wrappers, matching the contract's recorded
decisions. Fixtures extend `resume-integration.fixtures.ts` rather than spawning a
pipeline, as the Definition of done requires, and the B-06 test guards its own
fixture (`rounds`, `filedFindings`, `claims`, `attempts`) so the "unchanged"
assertions cannot pass vacuously.

## Resolved findings
- None — this is the first QA round for this slice and no findings were routed.

## Findings
### Finding 1 — Missing attempt snapshot directory is fabricated rather than refused
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/preserve-work-recovery.ts` — `attemptDir` is joined from
`admitted.snapshotPath` and never existence-checked; `mkdirSync(temporary, {
recursive: true })` then creates it. The only `existsSync` guard is on the
`negotiation/` child.
**What the contract expected:** B-02 — the history is "a `negotiation/` directory
beneath the attempt's already-published snapshot directory", the attempt's one
immutable directory identity.
**What I observed:** If that directory is absent, execution recreates it empty,
publishes `negotiation/` inside it, deletes the live files, clears both controls
and returns `ok: true` — a negotiation history with no accepted pair beside it.
Advisory: the path is unreachable from admission, which always publishes the pair
first.

### Finding 2 — `prdSlug` is documented as artifact identity but is only a run-slug default
**Severity:** Minor
**Pass:** 2
**Evidence:** `ExecuteRecoveryAttemptArgs` declares `/** PRD slug — artifact
identity. */ prdSlug: string;`, and its sole use is
`const runSlug = args.runSlug ?? args.prdSlug;`. The artifact directory arrives
separately as `sliceDir`.
**What the contract expected:** No contract clause; this is a Pass 2
maintainability note.
**What I observed:** A caller passing a PRD slug that differs from the run slug
and omitting `runSlug` would read and clear the wrong run-state file, with a doc
comment that reads as if the field were unrelated to state location.
