# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here and succeeded (the prepare `tsc -p
tsconfig.build.json` completed, 10.8s). `pnpm run typecheck` also ran clean in
this worktree, matching the skip authorization for tree
`75edd1a8cea9151b8cf4f0c2c749a1c0de31989c` (attempt
`bee9a020-fbc3-4f64-b26a-03862c72101f`).

Behavior-ID coverage: every ID has at least one test whose name carries it —
B-01 4, B-02 3, B-03 5, B-04 3, B-05 3, B-06 2, B-07 3, B-08 2, B-09 2, B-10 5,
B-11 5, B-12 4, P-01 1, P-02 2, P-03 1, P-04 1, P-05 3 (counted by
`behavior:#277:<id>` occurrences across `src/*.test.ts`).

Ran the slice's own files (a probe, not a substitute for the suite the
orchestrator owns):
`npx vitest run src/preserve-work-recovery.test.ts src/cli-options.test.ts
src/run-state.test.ts src/eval-boundary.test.ts src/cli-entries.test.ts`
→ `Test Files 5 passed (5) / Tests 216 passed (216)`, 11.96s.

Boundary: `git diff 0e064d2..HEAD --stat` touches only declared paths —
`src/cli-options.ts`, `src/cli-options.test.ts`, `src/cli-entries.test.ts`,
`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts`,
`src/run-state.ts`, `src/run-state.test.ts`, `src/eval-boundary.test.ts`,
`src/qa-orchestration.test.ts`, `src/qa-orchestration-gates.test.ts`,
`ARCHITECTURE.md` — plus this slice's own spec artifacts. `src/git.ts`,
`src/worktree-processes.ts`, `src/file-lock.ts`, `src/orchestrator.ts`,
`src/wave.ts` and the three entry files are untouched. No migration file. No
scope amendment is needed.

Preservation, checked rather than assumed:
- P-01 — `--test-command requires a value` and the paired preview-command
  message still throw verbatim; the new flag reuses `optionValue`, so
  `--renegotiate-stale requires a value`.
- P-02 — a flagless argument list `toStrictEqual`s an independently written
  expected object; both new keys are present-and-`undefined` and
  `src/cli-options.ts` imports nothing from the recovery, git, run-state or
  file-lock modules.
- P-03 — v3/v4/v5/v6 documents load without loss and rewrite through
  `updateRunState` differing only in the version stamp.
- P-04 — a state carrying resume counters, migrations, baselines, waivers, final
  evaluations and quality stages comes back equal to itself plus
  `recoveryLineage`.
- P-05 — signatures verified against source: `hasUncommittedChanges(cwd)`
  (`src/git.ts:476`), `countCommitsAhead(repoRoot, source, target)` counting
  `target..source` (`:683-689`), `isAncestor(repoRoot, ancestor, descendant)`
  (`:1446`); the module calls them at that argument order
  (`countCommitsAhead(repoRoot, sliceBranch, featureBranch)`,
  `isAncestor(repoRoot, featureBranch, sliceBranch)`), so the semantics are the
  ones the codes claim. `src/eval-boundary.test.ts`'s unrelated `P-05` is green.
- No stale schema pin survives the bump: `Select-String` over `src/*.ts` finds no
  remaining `toBe(6)` version assertion, and the only `version: 6` literals left
  are deliberate v6 *inputs* in `src/run-state.test.ts:1319` and `:1369`.

### Falsifiability probes (temporary edits, all reverted)

Each mutation below was applied in this disposable worktree and the tree
restored with `git checkout --` afterwards; `git status --porcelain src/` is
clean.

1. Disabled the locked scope-fingerprint recheck
   (`if (false && recheck.facts.scopeFingerprint !== facts.scopeFingerprint)`)
   → B-08's cross-process test fails: `- "code": "facts-changed-before-lock"` /
   `+ "admitted": true` at `src/preserve-work-recovery.test.ts:680`.
2. Changed the appended event's `extensions: []` to `["probe-injected"]`
   → B-09's "appends one event carrying every recorded member" fails.
3. Made `sanitizeRecoveryLineage` return the raw value instead of validating it
   → 5 of the 6 B-10 malformed-lineage rows fail.
4. Disabled both `hasOpenRecoveryAttempt` guards → B-09's "refuses a second
   admission while the last event is PENDING" fails.

So the load-bearing assertions can fail, and the cross-process interleave is
real rather than staged: the child process changes the persisted scope inside
`beforeLockAcquired` and the recheck is what refuses.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

Notes, none material:
- `ARCHITECTURE.md` gains the one required module row and is 140 lines; the diff
  also reflows the unrelated "Tests:" bullet (two lines to two lines) to stay
  under the 150-line cap. In-scope file, cosmetic.
- `src/run-state.test.ts`'s #87 B-14 pin moved from `expect(RUN_STATE_VERSION)
  .toBe(6)` to `toBeGreaterThanOrEqual(6)` and the test was renamed. The exact
  pin now lives in the new B-10 test (`toBe(7)`), so nothing is unpinned, and
  `src/run-state.test.ts` is a declared file — but the #87 scenario itself is
  now weaker in isolation.
- B-06's "no merge, reset or rebase" is asserted as a word scan over
  comment-stripped module source. That is what the contract's `observableResult`
  asks for; it is brittle to an innocuous identifier (`mergeBase`) and would
  read green for a merge invoked through an aliased import. The companion
  tips-unmoved assertion is the substantive half.
- Two advisory findings below concern latent correctness rather than any
  behavior this slice can observably reach today.

## Resolved findings
- None: this stage was handed no routed findings, and no prior QA report was
  reconstructed.

## Findings
### Finding 1 — Provider-unqualified default run-state slug
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/preserve-work-recovery.ts:621` — `const runSlug =
args.runSlug ?? args.prdSlug;` — feeds `loadRunState`/`transactRunState`, whose
path is `.afk/state/<slug>.json` (`src/run-state.ts:594-596`). Real runs key
that file by run slug: `src/orchestrator.ts:738`
(`runSlugForProviderName(prdSlug, provider.name)`) and `:2188-2191`, i.e.
`<prdSlug>-claude-code` for every non-kiro provider
(`src/run-identity.ts:23-28`). The same admission call already
provider-qualifies branch and worktree names
(`src/preserve-work-recovery.ts:383-392`). The fixture hides it: the test uses
`PROVIDER = "claude-code"` (`src/preserve-work-recovery.test.ts:61`) but writes
state at `${PRD_SLUG}.json` (`:206`), a pairing no real launch produces.
**What the contract expected:** B-05's recorded decision — "worktree and feature-branch
names resolve through `src/run-identity.ts:16-50` rather than re-derived
strings" — with B-08's recheck and B-09's append landing in the run's own
run-state file under the ADR 0056 lock.
**What I observed:** Omitting `runSlug` for a non-kiro provider targets a
provider-unqualified state file: admission would refuse with `scope-absent`
against an absent file, or append the `PENDING` event beside the real run's
state rather than into it. Not reachable from any entry point today, because
`parsePipelineRuntimeOptions` refuses every well-formed request until #335
(B-12), so this is latent rather than a shipped defect.

### Finding 2 — Worktree registration inferred from a `.git` entry
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/preserve-work-recovery.ts:397` —
`if (!existsSync(worktreeDir) || !existsSync(join(worktreeDir, ".git")))` — is
the entire `worktree-unregistered` check, chosen (per the comment at
`:393-396`) to keep eligibility's git surface at the three predicates P-05
pins. `src/preserve-work-recovery.test.ts:167-169` satisfies it by writing a
`gitdir: ...` file into a plain directory, so no test separates a real linked
worktree from a leftover one. Worktree survivors are a condition this repo
already handles elsewhere (`src/git.ts:469-472`).
**What the contract expected:** B-05 — the target "has a recorded slice branch
and a **registered** worktree at it".
**What I observed:** Any directory holding a `.git` entry at the derived path
passes, including a worktree whose removal failed and which git no longer
lists, so a `PENDING` attempt can be recorded against a worktree git does not
track. Low harm at this slice's scope — the event is a record, and nothing
dispatches on it until #332-#335 — hence advisory.
