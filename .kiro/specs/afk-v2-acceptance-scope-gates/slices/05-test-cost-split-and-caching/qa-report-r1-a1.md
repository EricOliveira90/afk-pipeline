# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

### Pre-QA command evidence

- `pnpm install --frozen-lockfile` — run here, exit 0 ("Lockfile is up to date,
  resolution step is skipped"; the `prepare` hook's `tsc -p tsconfig.build.json`
  also completed).
- `pnpm run typecheck` — skipped under the orchestrator's authorization: PASS at
  2026-09-09T23:23:24.956Z (5.2s), evidence artifact
  `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260909-190141/gates/s05/attempt-7806fd10115b.json`,
  gate attempt `7806fd10-115b-45d5-9911-70713347eb2b`, tree
  `ebca16748f53526079ae7f31d873a0df71fbfe18`. I modified no file under review, so
  the authorization holds.

### Boundary compliance

`git diff --name-only 3490f0a^..HEAD` lists 26 repo files plus this slice's own
`.kiro/.../slices/05-test-cost-split-and-caching/` process artifacts. Every one
of the 26 appears in `## Files expected to change`; no declared file is missing
and no undeclared file was touched. `afk.config.json`, `package.json`,
`suite-budgets.json` and `scripts/check-suite-budgets.mjs` are all untouched by
this slice, as the non-goals require. New migration files: 0, as declared.

### Preservation check

- P-01: `resolveTestCostPlan` (src/base-gates.ts) reads `loadGatePolicy(cwd)?.cost`
  and falls back to `DEFAULT_CHEAP_THRESHOLD_MS` / `[]` /
  `DEFAULT_CACHE_ENABLED` / `DEFAULT_SKIP_DETECTORS` / `DEFAULT_TEST_GLOBS`.
  `parseGatePolicy` spreads `cost` only when present, so an absent member stays
  absent.
- P-02: `SANITY_STEPS` and `resolveSanityPlan` are unmodified in the diff.
  `resolveScriptStep` is a separate `package.json` read reached only from
  `environmentSensitiveDeclarations`; neither `resolveSanityCommands` nor
  `resolveCandidateQACommands` can reach it, so `test:budgets` cannot enter the
  pre-ship or candidate-QA command lists. This repo's `afk.config.json` declares
  no `cost.environmentSensitive`, so no `test:budgets` declaration is emitted
  here at all.
- P-03: `PRE_QA_GATE_IDS` is still `["typecheck", "lint"]`; the pre-QA resolver
  only gained `{ stampCost: true }`, which adds `expectedCostMs` /
  `prerequisiteGateIds` without changing ids or order.
- P-04: `resolveBindableGateCatalog` still reads `resolveBaseGateDeclarations`,
  which is called without `stampCost` and never assembles an
  environment-sensitive declaration, so its answer is unchanged. A malformed
  `cost` throws from `parseCost` rather than degrading.

### Behavior spot-checks that hold

- B-01: `POLICY_KEYS` gains `"cost"`; `parseCost` refuses an unknown sub-key, a
  non-integer `cheapThresholdMs`, empty `patterns`, an empty `testGlobs`, a
  non-compiling pattern and a duplicate detector id, each naming its path.
  `resolveTestCostPlan` is the single production reader and every consumer takes
  its part through a parameter.
- B-02: the declaration is assembled in `environmentSensitiveDeclarations` from
  `ENVIRONMENT_SENSITIVE_STEPS`, appended after `tests`, `required: false`,
  `environmentSensitive: true`, absent when the script or the policy entry is
  absent, out of `resolveBindableGateCatalog`, and rendered in
  `src/logger.ts`'s new `## Advisory Gates` block and
  `buildPrCreationPlan`'s advisory section from the same events.
- B-03/B-04: the cache is consulted before any spawn and before
  `restoreCheckpoint()`, keyed on `[gateId, command, args, treeId]` with args
  JSON-encoded; an entry filed under a key it does not describe is a miss;
  read and write both no-op on `enabled: false`; malformed bytes, a wrong
  `version`, and an unwritable path are all swallowed. Only `PASS` is written.
- B-05: `resolveGeneratorTestCommand(cwd, catalog, override?)` takes the catalog
  as a parameter, so `base-gates → preship` stays one-directional. `lint` has no
  command in this repo and so contributes nothing; `tests` is excluded by
  identity. `normalizeCommandSegment` makes `pnpm typecheck` and
  `pnpm run typecheck` one segment, extra segments are unvalidated, and the
  refusal names gate ids. `AGENTS.md` and `CLAUDE.md` both now carry
  `--test-command "pnpm run typecheck && pnpm test:fast"`, and
  `src/orchestrator.test.ts` reads the value out of both documents rather than
  restating it.
- B-07: the prerequisite branch sits ahead of every other branch in the
  declaration loop, `continue`s rather than breaking, treats a prerequisite
  absent from the phase as satisfied, and names the failed prerequisite in the
  result, the log line and `gateStatusCell`. `GATE_EVIDENCE_VERSION` is `3`,
  `SUPPORTED_GATE_EVIDENCE_VERSIONS` is `[1, 2, 3]`, the docstring carries the
  rewritten version-keyed `findings` rule, and `isGateResult` validates each new
  optional marker's shape.
- ARCHITECTURE.md's Gates row lists `src/skip-gate.ts` (primary) and
  `src/gate-cache.ts` (supporting).

## Resolved findings
- none (no findings were routed to this stage)

## Findings

### Finding 1 — `tests:skipped` fails on this slice's own candidate tree by counting fixture string literals
**Severity:** Blocker
**Pass:** 1
**Evidence:**
The feature branch tip is `b732ce0`
(`git log --oneline -1 feat-claude-code/afk-v2-acceptance-scope-gates`), which is
also `3490f0a^`, this slice's base. Running the shipped gate against the live
worktree with the shipped defaults:

```js
import { runSkipGate } from "<worktree>/dist/skip-gate.js";
import { DEFAULT_SKIP_DETECTORS } from "<worktree>/dist/gate-policy.js";
runSkipGate({
  worktreeDir: "<worktree>",
  featureRef: "b732ce0",
  detectors: DEFAULT_SKIP_DETECTORS,
  testFileGlobs: ["**/*.test.ts"],
});
```

returns:

```json
{
  "status": "FAIL",
  "failureKind": "COMMAND",
  "detail": "This candidate disables more tests than b732ce0 does: vitest-ts \"it\\.skip\" 0 → 8; vitest-ts \"it\\.todo\" 0 → 2; vitest-ts \"describe\\.only\" 0 → 1. Re-enable the test, or fix what it caught."
}
```

All 11 counted occurrences are quoted string literals, not calls:
`src/skip-gate.test.ts:39`, `:44`, `:110`, `:126` (the gate's own fixture
suites) and `src/gate-policy.test.ts:444`, `:492`, `:505`, `:506`, `:514`,
`:515` (parser examples). A grep for `it\.skip|it\.todo|describe\.only` across
`src/*.test.ts` finds no actually disabled test in the tree.

`skipGateDeclaration` (`src/skip-gate.ts:260-269`) emits `required: true`, and
`src/orchestrator.ts:5936-5943` declares it in `postQaDeclarations`, which
`src/post-qa-gates.ts:235-240` hands to `decideCandidateGatePhase` — so this
FAIL is a required post-QA gate failure and the phase returns REPAIR.

**What the contract expected:**
"[behavior:B-06] A `tests:skipped` gate catches a newly introduced TypeScript or
Vitest skip. … It counts each detector's `patterns` over files matching its
`testGlobs` on the base tree and the candidate tree and fails only on an
increase, so pre-existing occurrences do not fire." Definition of done:
"`tests:skipped` … fires on a newly introduced skip or `.only` and not a
pre-existing one".

**What I observed:**
`countPattern` (`src/skip-gate.ts:122-124`) is a bare
`content.match(new RegExp(pattern, "g"))` over whole file text, so the detector
text counts wherever it appears — including inside the quoted fixture strings
the gate's own tests must contain in order to test it. The result is that the
gate blocks the exact slice that introduces it, and every future slice that
writes a detector's text inside a fixture string, a comment or a docstring
inherits the same false positive. Nothing in the tree is a disabled test.

### Finding 2 — raw NUL bytes make `src/skip-gate.ts` a binary file to Git
**Severity:** Blocker
**Pass:** 2
**Evidence:**
`[System.IO.File]::ReadAllBytes("src/skip-gate.ts")` contains three `0x00`
bytes, at offsets 7911, 8072 and 8841 — inside the three template literals
`` `${entry.detectorId}<NUL>${entry.pattern}` `` at `src/skip-gate.ts:219`,
`:225` and `:248`, where the separator is written as a literal control character
rather than an escape. A byte scan over every `.ts`/`.md`/`.json` file under
`src/` plus `ARCHITECTURE.md`, `AGENTS.md` and `CLAUDE.md` reports
`skip-gate.ts` as the only file carrying one, and `git check-attr -a
src/skip-gate.ts` returns no attribute (the repo's `.gitattributes` covers only
`*.mjs`). Consequences, reproduced:

- `git diff --stat 3490f0a^..HEAD` → `src/skip-gate.ts | Bin 0 -> 9536 bytes`
- `git diff --numstat 3490f0a^..HEAD -- src/skip-gate.ts` → `-	-`
- `git diff 3490f0a^..HEAD -- src/skip-gate.ts` → only
  `Binary files /dev/null and b/src/skip-gate.ts differ`, no patch text

**What the contract expected:**
`## New patterns / deps / schema`: "`src/skip-gate.ts`: `SKIP_GATE_ID =
"tests:skipped"`, declared through `run`" — a TypeScript source module in
`src/`, listed in ARCHITECTURE.md's Gates row beside `src/scope-gate.ts` as a
"worked example" a reader is meant to follow. A source file in this repo is a
text file: reviewable by `git diff` and mergeable by Git's text merge driver
(ADR 0010's atomic merge attempts operate on these files).

**What I observed:**
Git classifies the module as binary. No stage that reads a diff — architect
review, guardian review, the draft PR, a human reviewer — can see one line of
its 269 lines, now or on any future change to it. A wave merge touching it
conflicts as a binary file with no textual resolution. And because the separator
is an invisible control character, a formatter or editor that silently drops it
would change the composite Map key's semantics with no visible diff to catch the
change. Writing the separator as an escape (a NUL escape sequence, or a printable-safe
sentinel such as `\x1f`) preserves the behavior exactly and restores the file to
text.
