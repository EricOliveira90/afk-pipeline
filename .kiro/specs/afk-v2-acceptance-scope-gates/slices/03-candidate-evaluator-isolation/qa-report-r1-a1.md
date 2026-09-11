# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` was run in this worktree: exit 0, "Done in 4.3s
using pnpm v10.33.0". `pnpm run typecheck` is cited under the skip
authorization rather than re-run — PASS at 2026-09-11T03:37:11.022Z (9.0s),
evidence artifact
`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-224601/gates/s03/attempt-72f6d4612e81.json`,
gate attempt `72f6d461-2e81-4056-96b8-dd69e731f1a6`, tree
`175ec97c2e54f5ece688d4a76e30f5754e397173`. No file under review was modified.

Boundary: every path in `git diff --stat main...HEAD` is in the contract's
declared list (`ARCHITECTURE.md` matches the manifest's case-insensitive
`architecture.md` entry), plus this slice's own spec directory. `src/git.ts` is
unmodified, and neither new git read goes through `statusPorcelain`,
`diffTreePaths`, `logCommitsWithStat` or `listChangedFiles`. No migration files.

Behavior spot-checks that hold up:

- B-01/B-02: `runQAStage` splits into a thin wrapper owning
  `try { … } finally { await isolation.dispose() }` and `runQAStageAttempts`;
  `dispose()` cannot throw (`removeWorktreeOrWarn` warns, `deleteBranch`
  swallows), so cleanup never masks a verdict or a cancellation. The worktree
  name keeps the `-s<n>` suffix last, which `sliceFromCwd` requires.
- B-04: probed the load-bearing git semantics in a scratch repo outside this
  tree — `git -c core.quotePath=false status --porcelain=v1
  --untracked-files=all --ignored -- .afk` prints
  `!! .afk/artifacts/deep/approved-baseline.json` while the plain read prints
  nothing, and `line.slice(3)` parses it. The implementation is correct; only
  its coverage is not (QA-01).
- B-05: `buildChangeSummary(cwd, fromRef, toRef)` holds no run state, tolerates
  a bare tree ref by emptying `commits`, and records binary files as `null`
  line counts.
- B-06: `approved-baseline.json` is orchestrator-authored at the pre-QA call
  site, filters gate evidence to the graded tree, and the run-state record is
  written after the file exists, so the locator never names a missing file.
- P-01 through P-05 each have an assertion; P-04's is strong (asserts UAT cwds
  are `repo`, deterministic cwds are not, and no `qa-review` worktree exists).

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES — two blocking gaps (QA-01, QA-02) and one advisory
  (QA-03)

Code quality is genuinely good: the isolation lifecycle is one seam with the
four things that only make sense together, the seed manifest and the copy-back
allowlist are kept as separate lists for stated reasons, `copyBack` runs in the
invoke promise's `.finally` so it precedes `archiveAttemptEvidence` on both
paths without replacing the evaluator's own error, and `run-state.ts` keeps
`version: 3 | 4` for out-of-boundary fixtures with a comment saying why. What
fails is the demonstration, not the mechanism: the two halves of B-04 the
contract's Definition of done calls out by name are both mutation-invisible —
delete the `--ignored` status read or stop passing `seededPaths`, and the suite
stays green.

## Resolved findings
- none (no findings were routed to this stage)

## Findings

### Finding 1 — The gitignored-`.afk/` half of the reviewer-write scan has no test
**Severity:** Blocker
**Pass:** 2
**Evidence:** `Select-String -Path src\*.test.ts -Pattern
"scanReviewWorktreeWrites|IGNORED_REVIEW_ARTIFACT_ROOTS|reviewer-write-violation"`
returns only `logger.test.ts` (rendering) and `qa-orchestration.test.ts:3046`.
The single scan scenario (`src/qa-orchestration.test.ts:2996`) has its stub
write `README.md`, `probe.txt`, `notes.md` and `nested/qa-report.md` — all
visible to the plain `--untracked-files=all` read — and asserts exactly those
four paths. Nothing writes under the review worktree's `.afk/` root, and
`scanReviewWorktreeWrites` (`src/qa-review.ts:965`) has no unit test. Deleting
the `--ignored` branch at `src/qa-review.ts:983-989` breaks no assertion.
**What the contract expected:** "Every non-allowlisted evaluator write in the
review worktree is discarded and named by a `reviewer-write-violation` run
event, including a write under the gitignored `.afk/` root." (Definition of
done); B-04's `observableResult`: "asserts events.jsonl holds one
reviewer-write-violation naming the src/ path and one naming the .afk/ path".
**What I observed:** No test writes under `.afk/` in the review worktree, and
none writes under `src/` either — the source-edit case uses `README.md` at the
repo root. The second git read that exists specifically to see ignored paths is
uncovered. I verified by probe that it works, so this is a coverage defect, not
a behavior defect.

### Finding 2 — The seed-manifest subtraction is asserted vacuously
**Severity:** Blocker
**Pass:** 2
**Evidence:** `makeContext` (`src/qa-orchestration.test.ts:235-260`) writes the
pair into the repo before the stage runs, and the checkpoint tree is built with
`git add -A` (`src/gate-runner.ts:301`), so the review worktree's HEAD already
holds those bytes. `seed()` (`src/orchestrator.ts:4487-4501`) copies identical
bytes over them, so `git status` reports nothing for the pair whether or not
`seededPaths` is subtracted. The only assertion for it
(`src/qa-orchestration.test.ts:3060-3068`) therefore passes with `seededPaths`
removed from the call at `src/orchestrator.ts:4956`. The B-01/B-02 re-seed
scenario (`:2893`) has the same property: attempt 1 deletes the pair, attempt 2
restores identical bytes.
**What the contract expected:** "The per-attempt seed manifest is subtracted
from the violation scan, and the scope-amendment attempt emits no violation for
`contract.md` or `acceptance-manifest.json`." (Definition of done); test plan:
"Given a deterministic attempt granted by an applied scope amendment … no
`reviewer-write-violation` event names either path, and the evaluator's attempt
reads the amended bytes."
**What I observed:** No scenario seeds bytes that differ from the checkpoint
tree — which is the amendment case the subtraction exists for — so nothing
distinguishes "subtracted by the seed manifest" from "never reported at all".

### Finding 3 — Three declared observable results are asserted in weaker form
**Severity:** Minor
**Pass:** 2
**Evidence:** B-03's `observableResult` names `notes.md`,
`approved-baseline.json` and `nested/qa-review.json`; the scenario writes
`notes.md` and `nested/qa-report.md` but never `approved-baseline.json` — the
one name `contract.md:75-78` singles out ("an evaluator-authored
`approved-baseline.json` … cannot reach the repo by construction"). P-01's
`observableResult` names `src/orchestrator.test.ts` and the `slice-outcome`
event's `evalRounds`; it is asserted in `src/qa-orchestration.test.ts:1364` on a
per-run dispatch count instead, for the reason `handoff.md` records. P-05's and
B-06's "no `approved-baseline.json` is written" halves are unasserted and would
be vacuous where they sit, since `writeApprovedBaseline` is called from the
`runSliceExecute` call site (`src/orchestrator.ts:6187`) that no direct
`runQAStage` scenario reaches.
**What the contract expected:** The `observableResult` recorded for each of
those behaviors in the locked `acceptance-manifest.json`.
**What I observed:** Narrower or relocated assertions. Each deviation is
individually defensible and one is already documented; widening them, or
recording the remaining two in `handoff.md`, clears this.
