# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

### Pre-QA command evidence

- `pnpm install --frozen-lockfile` — run here, exit 0 (`Done in 4.8s using pnpm
  v10.33.0`; the `prepare` hook's `tsc -p tsconfig.build.json` also completed,
  which is what made `dist/` available for the finding re-checks below).
- `pnpm run typecheck` — skipped under the orchestrator's authorization: PASS at
  2026-09-09T23:39:29.956Z (6.1s), evidence artifact
  `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260909-190141/gates/s05/attempt-e192e1554773.json`,
  gate attempt `e192e155-4773-49b0-a580-f878542a9a18`, tree
  `9cddb40bdbd0b223583d192244f7dacfc950779f`. I modified no file under review,
  so the authorization holds.

The project test suites were not run: the pre-QA list does not name them, and
the orchestrator runs the full suite on the accepted candidate tree.

### Boundary compliance

`git diff --name-only b732ce0..HEAD` (the slice base is the feature-branch tip
`b732ce0`) lists 26 repo files plus this slice's own
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/05-test-cost-split-and-caching/`
process artifacts. All 26 appear in `## Files expected to change`; no declared
file is missing and no undeclared file was touched. `afk.config.json`,
`package.json`, `suite-budgets.json` and `scripts/check-suite-budgets.mjs` remain
untouched, as the non-goals require. New migration files: 0, as declared. The fix
round (`bc8bfef`) touched only `src/skip-gate.ts` and `src/skip-gate.test.ts`,
both declared.

### Preservation check

Unchanged from the round-1 assessment, and nothing in `bc8bfef` reaches these
paths: P-01 (`resolveTestCostPlan` falls back to the documented defaults and an
absent `cost` stays absent), P-02 (`SANITY_STEPS`/`resolveSanityPlan` unmodified;
`resolveScriptStep` is reachable only from the environment-sensitive
declarations, so `test:budgets` cannot enter `resolveSanityCommands` or
`resolveCandidateQACommands`), P-03 (`PRE_QA_GATE_IDS` still
`["typecheck", "lint"]`), P-04 (`resolveBindableGateCatalog` still reads
`resolveBaseGateDeclarations` without cost stamping; a malformed `cost` throws).

## Resolved findings

- **QA-01 — `tests:skipped` failed on this slice's own tree by counting fixture
  string literals.** RESOLVED. `bc8bfef` adds `stripNonCode`
  (`src/skip-gate.ts:139-187`), which blanks comments and string/template
  literals while preserving line breaks, applied once per file in `countAll`
  (`:220-227`) before `countPattern` (`:189-191`). Re-ran the clear condition
  against the live worktree with the freshly built `dist/`:

  ```json
  {
    "status": "PASS",
    "failureKind": null,
    "detail": "No detector counts more disabled tests on this candidate than on feat-claude-code/afk-v2-acceptance-scope-gates (1 detector(s) over 529 candidate path(s))."
  }
  ```

  The negative half was re-run in a scratch git repo outside the tree under
  review (base commit with two live `it("...")` tests, then one rewritten to
  `it.skip("subtracts"`):

  ```json
  {
    "status": "FAIL",
    "failureKind": "COMMAND",
    "detail": "This candidate disables more tests than HEAD does: vitest-ts \"it\\.skip\" 0 → 1. Re-enable the test, or fix what it caught."
  }
  ```

  So a real skip still fails and prose about one does not. `src/skip-gate.test.ts`
  gained a paired assertion covering both halves on one fixture repo.

- **QA-02 — raw NUL bytes made `src/skip-gate.ts` binary to Git.** RESOLVED. The
  separator is now a U+001F escape sequence (`KEY_SEPARATOR`,
  `src/skip-gate.ts:206`), and `countKey` (`:208-210`) still composes
  `detectorId` + separator + `pattern`, so the composite Map key keeps
  distinguishing detector/pattern pairs. Re-checked:
  `git diff --numstat b732ce0..HEAD -- src/skip-gate.ts` → `362  0
  src/skip-gate.ts` (was `-  -`); `git diff b732ce0..HEAD -- src/skip-gate.ts`
  emits a full textual patch (`new file mode 100644 … @@ -0,0 +1,362 @@`); a byte
  scan reports 0 NUL bytes and 0 control bytes other than CR/LF/TAB.
  `src/skip-gate.test.ts` now asserts the module carries no raw control byte and
  that the escape is spelled out, so a regression is caught in-suite.
  (`git show --stat bc8bfef` still prints `Bin 9536 -> 12957 bytes` because the
  pre-fix blob was the binary side of that comparison; the file as shipped at
  `HEAD` is text.)

### Behavior spot-checks that hold

B-01 through B-07 were verified in round 1 and their code is unchanged except
`src/skip-gate.ts`: `POLICY_KEYS` gains `"cost"` and `parseCost` refuses each
malformed shape naming its path; `resolveTestCostPlan` is the single production
reader and every consumer takes its part as a parameter; the `test:budgets`
declaration is assembled outside the sanity plan, `required: false`,
`environmentSensitive: true`, absent when the script or the policy entry is
absent, out of `resolveBindableGateCatalog`, and rendered in `## Advisory Gates`
and the draft PR; the gate cache is keyed on `[gateId, command, JSON(args),
treeId]`, consulted before any spawn, writes only `PASS`, and treats a
mis-filed, malformed or unreadable entry as a miss; `resolveGeneratorTestCommand`
takes the catalog as a parameter (so `base-gates → preship` stays
one-directional), excludes `tests`, normalizes `pnpm x` against `pnpm run x`, and
names the omitted gate ids in the refusal; the prerequisite branch precedes every
other branch, `continue`s rather than breaking, and names the failed prerequisite
in the result, log line and `gateStatusCell`; `GATE_EVIDENCE_VERSION` is `3` with
`SUPPORTED_GATE_EVIDENCE_VERSIONS` `[1, 2, 3]` and the rewritten version-keyed
`findings` docstring; ARCHITECTURE.md's Gates row lists both new modules.

On Pass 2, `stripNonCode`'s two documented limits (regex literals untracked, a
nested template ending the scan early) both fail toward counting more code
rather than losing a line, are recorded in the module docstring and the handoff,
and are the right trade for a scanner that must not need a real parser — not a
maintainability problem.

## Findings

None open.
