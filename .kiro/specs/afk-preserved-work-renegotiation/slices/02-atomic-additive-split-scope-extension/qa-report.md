# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — run here, exit 0, `Done in 6.4s using pnpm v10.33.0`.
- `pnpm run typecheck` — the skip authorization covers it (evidence artifact
  `.afk/logs/afk-preserved-work-renegotiation-claude-code/run-20260914-231711/gates/s02/attempt-3b2e1543947f.json`,
  gate attempt `3b2e1543-947f-4c6d-8247-381624c8d90d`, tree
  `155be4a05a374ab89bcdbfc76ddd42cf81799005`, PASS at 2026-09-15T05:39:46.174Z).
  I ran it myself anyway, because I probed the tree (see QA-01 below) and the
  authorization is void once a file under review is modified: after
  `git checkout -- src/preserve-work-recovery.ts` restored the tree,
  `pnpm run typecheck` (`tsc --noEmit`) exited 0 with no diagnostics, and
  `git status --porcelain` shows no `src/` entry — only the pipeline-owned spec
  files the checkpoint arrived with.

The change summary the prompt names,
`.afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-02/change-summary.json`,
does not exist in this worktree (no `.afk/` directory at all). I reconstructed
the same facts from git instead: the slice is `9fb7382..HEAD` on base `29cc87f`,
touching eight `src/` files for +2376/-34.

### Probes

Because this worktree is disposable, I ran two probes rather than reasoning
about the code:

1. **The four in-scope test files.** `pnpm vitest run src/cli-options.test.ts
   src/run-state.test.ts src/slice-scope.test.ts
   src/preserve-work-recovery.test.ts` — `Test Files 4 passed (4)`,
   `Tests 407 passed (407)`, 31.80s, exit 0. Not the full suite, which the
   evaluator-qa and pre-ship gate own.
2. **A mutation probe against QA-01's regression test**, to check the test can
   actually fail rather than passing for a reason unrelated to the fix. Detail
   under Resolved findings.

### Boundary compliance

`git diff --name-only 29cc87f HEAD -- src/` returns exactly the eight paths the
contract's `Files expected to change` list and the manifest's `fileScope.paths`
declare, and nothing else. No migration file (`migrationCount: 0` holds; the
diff matches no path containing `migration`). None of #336's reserved files —
`src/run-events.ts`, `src/run-snapshot.ts`, `src/status.ts` — is touched, so the
non-goal holds. No `SCOPE_AMENDMENT` finding is needed.

### Preservation

- **P-01** — `src/cli-options.ts:473-482`: `parseScopeExtensionSelectors` runs
  before #277's `--renegotiate-stale` guard, and the guard's throw is unmoved.
  `src/cli-options.test.ts` adds three P-01 tests, including one asserting the
  refusal still names #335 for a well-formed request that *carries* additions,
  and one asserting the flag parser reads no run state, git or recovery module.
- **P-02** — `resolveRunScope` is untouched; `appendScopeExtensions` is a new
  pure function beside it and is the module's only widening. `src/slice-scope.test.ts`
  adds a P-01-style guard test that the widened scope is what `resolveRunScope`
  *reads*, never what it makes.
- **P-03** — the `[behavior:#278:P-03]` test passes: no ref moved across the
  extension paths, and `runScopeFingerprint`/`encodeRunScopeFingerprintPayload`
  remain the one encoder.
- **P-04** — the `[behavior:#278:P-04]` test passes: #335's three preconditions,
  single lock acquisition and stamped `COMPLETED` members are as shipped, and the
  scope write is inside the existing transaction body (`src/preserve-work-recovery.ts:2496-2498`),
  not a second write.
- **P-05** — `src/run-state.ts:79` still reads `export const RUN_STATE_VERSION = 7`;
  two `[behavior:#278:P-05]` tests assert a v7 file loads with every event intact
  and that `appendRecoveryLineageEvent` stays append-only and state-taking.

### Behaviors

Each of B-01 through B-10 has at least one `[behavior:#278:B-xx]`-tagged test that
asserts observable output rather than a mock. Spot checks:

- **B-01** — a 7-row `it.each` table asserting one distinct thrown message per
  cause on the exported parser *and* on `parsePipelineRuntimeOptions` for the
  same argv, plus a separate test asserting no two of the six messages are
  equal. `--extend-scope " 007 , 4001 "` returns `["007", "4001"]`, so zero
  padding survives as typed and a bare issue id is accepted; `03,#278` throws.
- **B-03** — the resolver call site sits after `completedReplacementFor`
  (`src/preserve-work-recovery.ts:1232-1249`), and `extensionScopeView` subtracts
  the completed event's own additions in the replay branch, so a replay reaches
  B-09's comparison instead of drawing `extension-already-in-scope`.
- **B-08** — the atomicity claim is asserted the way the contract authorizes it:
  one test reloads the published document and asserts both halves plus
  `differing.sort()` equalling exactly `["recoveryLineage", "scope"]` (so
  `resume`, `slices`, `migrations` and `reviewPhase` are carried forward), and a
  second counts writers structurally — one `transactRunState<`, one
  `changed: true`, no `saveRunState` anywhere in the module, exactly one
  `.scope = ` in the module, and `appendRecoveryLineageEvent` ordered before
  `appendScopeExtensions` inside the locked body.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

Conventions hold: trailing newlines are back (QA-03), every new export carries a
doc comment that argues its own decision, refusal codes are one-per-cause per the
code-not-prose rule, and the new tests use the repo's `[behavior:#278:B-xx]` tag
form. The one code-quality note is QA-04 below — the canonical set order is
implemented once per module. It is a maintainability note, not a defect: the two
implementations agree on every input the parser and the sanitizer can produce.

## Resolved findings

- **QA-01 (BLOCKING) — completion revalidation re-derived selectors from
  `ghIssue`.** Fixed structurally, not patched around.
  `ScopeExtensionMember = string | PersistedScopeSlice`
  (`src/preserve-work-recovery.ts:323`) lets the resolver take a stored identity
  directly, and `matchScopeExtensionMember` (`:504-521`) matches a pair on *both*
  halves while a typed selector still matches on either — so the ambiguity that
  storage closed is not re-opened. The completion hands the pairs back whole:
  `const additions = current.extensions;` then `selectors: additions`
  (`:2442-2448`). The regression test is
  `src/preserve-work-recovery.test.ts:4669`, over `COLLIDING_SLICES` =
  `EXTENSION_SLICES` + `declaredSlice("15", "9")` (`:4138-4144`) — slice 15's
  issue id `9` is also declared slice `09`'s canonical number, exactly the shape
  the finding named. **I verified the test can fail:** changing `:2444` to
  `selectors: additions.map((entry) => entry.ghIssue)` and running
  `pnpm vitest run src/preserve-work-recovery.test.ts -t "completes an addition
  whose issue id is another slice's number"` gives
  `- Expected completed: true / + Received completed: false` at test line 4687,
  `Test Files 1 failed`. `git checkout -- src/preserve-work-recovery.ts` restores
  green. The finding's other half also holds: the `REVALIDATION_CASES` table
  (`:4589-4666`) drives all three genuine-drift causes and asserts
  `facts-changed-before-lock`, trigger `completion-cas-lost`, trailing events
  `["PENDING", "ROLLED_BACK"]` and an unchanged `scope` for each.
- **QA-02 (ADVISORY) — untested absent-scope refusal naming an unobserved
  cause.** Cleared on both limbs of its clear condition. The branch now reports
  `"no persisted slice scope for the additions to widen"`
  (`src/preserve-work-recovery.ts:2463-2464`), distinct from `identityDrift(...)`,
  and `:2449-2456` argues why the guard stays fail-closed. The test at
  `src/preserve-work-recovery.test.ts:4735` plants the state so the branch is
  genuinely reached — it deletes `document.scope` *and* rewrites every event's
  `scopeFingerprint` to `RECOVERY_FINGERPRINT_ABSENT`, without which the earlier
  fingerprint recheck would answer first — then asserts the ending, the trigger,
  that the message contains the absent-scope wording and that it does *not*
  contain `"a different identity set"`.
- **QA-03 (ADVISORY) — missing trailing newlines.** `git diff 29cc87f HEAD --
  src/ | Select-String 'No newline at end of file'` returns no output for any of
  the eight files.

## Findings

### Finding 1 — Two implementations of the one canonical extension-set order
**Severity:** Minor
**Pass:** 2
**Evidence:** `compareScopeExtension` (`src/preserve-work-recovery.ts:529-535`,
delegating to `compareGhIssue` at `:2728-2735`) and `compareScopeIdentity`
(`src/slice-scope.ts`, delegating to `compareIdPart`) each document themselves as
*the* canonical order for the same `{number, ghIssue}` set. Their numeric tests
differ: `compareGhIssue` accepts anything `Number.isInteger(Number(x))` admits,
so `""`, `" 9"` and `"9.0"` compare numerically, while `compareIdPart` requires
`/^\d+$/` and sends those same values to a string comparison. They agree on every
digits-only input, which is all B-01's digits-only parser rule and
`sanitizeRecoveryLineage`'s non-blank pair rule can currently produce, so no
shipped path orders a set two ways today and no test pins the two to each other.
**What the contract expected:** B-08 — the helper "appends the additions in
canonical set order", and B-02 — the set is "sorted by canonical slice number,
then GitHub issue, before it is stored or compared (PRD 'Canonical request and
scope identity')", i.e. one order shared by the `PENDING` record, B-09's replay
comparison and the persisted scope. The module itself states the principle at
`src/preserve-work-recovery.ts:358-361`: "a second differently-shaped
normalization of one identity is how two callers come to disagree about which
slice was named."
**What I observed:** That normalization exists twice, once per module, with
divergent numeric-detection rules. The divergence is latent behind two
validators rather than reachable, which is why this is Minor and does not block:
it is a maintainability risk, not a behavior defect.
