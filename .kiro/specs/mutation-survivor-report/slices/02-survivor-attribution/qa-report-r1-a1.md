# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran in this worktree: exit 0. `pnpm run typecheck`
is cited under the skip authorization — evidence artifact
`.afk/logs/mutation-survivor-report-claude-code/run-20260915-104003/gates/s02/attempt-69746ef0aec3.json`,
gate attempt `69746ef0-aec3-4312-b335-faa9dd3bd359`, git tree
`12720d625fc433b4c53ff787adf9ecc2c051cb1d`. No file under review was modified
(`git status --porcelain` shows only the two slice spec files, and `git diff` on
them is empty — the CRLF warning is the whole difference), so the authorization
holds.

**Behavior coverage.** Every id in the contract has at least one `#304`-qualified
tag: B-01 (2), B-02 (1), B-03 (1), B-04 (6), B-05 (3), B-06 (3), B-07 (3),
B-08 (5), B-09 (4), B-10 (4), B-11 (7), B-12 (2), P-01 (3), P-02 (2), P-03 (3),
P-04 (1), P-05 (5), P-06 (1).

**Probes run in this disposable worktree** (targeted test files, not the full
suite):

- `npx vitest run src/afk-manifest.test.ts src/mutation-report.test.ts src/run-state.test.ts src/logger.test.ts`
  → `4 passed`, `286 passed`, exit 0.
- `npx vitest run src/ship-gate.test.ts` → `1 passed`, `57 passed`, exit 0,
  including `[behavior:#304:B-12] reports the same gate ids, gate results,
  verdict and PR decision with attribution as without it`.

**Boundary compliance.** `change-summary.json` lists 11 source files, all of them
in the contract's declared list and in the acceptance manifest's `fileScope`; the
other 8 are this slice's own spec artifacts. `migrationCount` is 0 and no
migration file was added. Nothing changed outside the file list, so no amendment
is needed.

**Contract behaviors checked.**

- B-01/B-02: `normalizeMutationReport` returns both new keys, absent stays absent
  via conditional spread (`src/afk-manifest.ts:303-308`), and the three path
  members share one refusal helper (`normalizeMutationReportPath`,
  `src/afk-manifest.ts:207`) rather than a third copy. The refusal table covers
  blank, non-string, glob, character-class, absolute, drive-absolute and `..`
  for both members.
- B-03: `trimUnclaimedMigrationPrefixes` needed no edit; the new test asserts the
  bytes re-read from disk, not the returned object.
- B-04: `parseMutationDecisions` is total — 15 malformed cases assert
  `status`/`detail` with no `expect(...).toThrow`, plus an explicit
  never-throws case. `readDeclaredArtifact` gates `ABSENT` on `existsSync` and
  only that; `UNREADABLE` is reached with a real directory at the path, no `fs`
  mocking. `readMutationReport` still returns `UNREADABLE` for a missing report,
  asserted side by side with the baseline's `ABSENT`.
- B-05: match key is file + mutator + all four position numbers; the test loops
  every one of the four numbers and the mutator, and the baseline fixture
  deliberately renumbers ids (`914` vs `1`), so the id-independence is observable
  rather than described.
- B-06/B-08: the silent branch is keyed on omitted-or-`ABSENT` and the noted
  branch on `UNREADABLE`-or-`MALFORMED`, and one test asserts the pair directly —
  identical labels, note the only difference.
- B-07: the id-plus-file corroboration is proven by the id-matches-file-differs
  case landing on `pre-existing`, not `accepted`; `KILL` changes no label; length
  and order are asserted.
- B-09: `attributeStepOutcome` reads after the command exits; the pre-spawn
  window is asserted by source inspection (no `await` between `isAbandoned()` and
  the runner call) and `RunMutationStepArgs` gained no member.
- B-10/B-11: both consumers reach `formatMutationReportLines` through
  `deriveMutationStepOutcome` (`src/logger.ts:893` and `src/logger.ts:341` ←
  `src/ship-gate.ts:1473`), so the labels and the degradation line cannot differ
  between `run-summary.md` and the PR body. `EVENTS_SCHEMA_VERSION` is 1 and
  `RUN_STATE_VERSION` is 7, both asserted; an unlabeled legacy record loads
  unchanged and renders `unattributed`.
- B-12: the ship-gate test runs the gate twice for real, differing only in the
  two declared paths, and asserts an identical `events.jsonl` gate surface,
  verdict, `pr` and `failureReason`, plus that no gate module names a label or a
  note. The diff adds no `GateDeclaration`, `GateFindings` field, gate id,
  threshold or percentage — grep over the diff returns only comments and those
  assertions.

**Preservation.** The only removed lines across the five test files are
`describe`/`it` name strings (retitled to carry the `#304` tag alongside the
`#303` one), one `import` line, and one comment. No `#303` tag was removed or
renumbered. `MutationNotRunReason` still holds exactly `BOUND_REACHED`,
`COMMAND_FAILED`, `REPORT_UNREADABLE`, `REPORT_MALFORMED`, asserted
structurally. One `#303` assertion did change —
`src/logger.test.ts`'s `[behavior:#303:B-14] reads the outcome back out of the
persisted stream` now expects `label: "unattributed"` — and that test is not in
P-01/P-02/P-04/P-05/P-06's preserved set; the change is exactly what B-11 says
such a record means and is authorized by the contract's "Changes to existing
behavior".

The step's `runMutationStep` returns the outcome unlabeled when *neither* path is
declared, rather than calling `attributeMutationSurvivors` with both arguments
omitted. I checked whether that contradicts B-09's "calls once on a
`MUTATION_REPORTED` outcome": it does not produce a divergence in observable
behavior, because both render sites go through `deriveMutationStepOutcome`, which
substitutes `unattributed` — and the short-circuit is what makes P-05's preserved
`toEqual` assertions pass unedited, which the contract requires. The handoff
records the same reasoning. Not a finding.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

Naming, doc-comment density and the absence discipline (conditional spread rather
than an `undefined`-valued key, in all four places a new optional member is
written) match the surrounding module. The `KEY_FIELD` escaped-NUL constant is a
good call — a literal NUL would have made `src/mutation-report.ts` binary to
`git diff` and `rg`. Error handling is total everywhere the contract requires it:
no new throw path reaches a gate. Tests assert real returned values and rendered
strings, not mocks; the two source-inspection tests (`RunMutationStepArgs`,
gate-module scan) are the right shape for the negative claims they make, and each
would fail if the claim broke.

One note, reported as advisory below: `samePath` folds backslashes but not a
leading `./`, so it implements half of the already-exported `normalizeWaiverPath`.

## Resolved findings
- none (no findings were routed into this stage)

## Findings
### Finding 1 — a `./`-prefixed decisions `file` silently corroborates nothing
**Severity:** Minor
**Pass:** 2
**Evidence:** Probe against the candidate tree — one survivor `id: "1"`,
`file: "src/cart.ts"`, and one `ACCEPT` entry with the same id and the file
spelled two ways:

```
"src/cart.ts"   -> accepted
"./src/cart.ts" -> unattributed
```

`samePath` in `src/mutation-report.ts` is `file.replace(/\\/g, "/")` — the
backslash half of `normalizeWaiverPath` (`src/afk-manifest.ts:146-148`:
`value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")`), with the trim and
the `./` strip dropped. Both new manifest members go through
`normalizeWaiverPath`, so the manifest tolerates `./` while the human-written
decisions file's `file` member does not.

**What the contract expected:** B-07 — "A survivor whose `id` **and** `file`
both match a `verdict: "ACCEPT"` entry is labeled `accepted`". The contract
mandates no path normalization, so partial tolerance is inside the contract;
what makes it worth stating is that `samePath` deliberately folds one
path-spelling difference and stops there.

**What I observed:** an operator who writes `"./src/cart.ts"` in the decisions
file gets no `accepted` label and no note — the entry resolves nothing, silently.
The harm is bounded exactly as B-07 and B-12 describe: one report bullet, read by
no gate, verdict or PR-open condition, and the survivor stays in the list at full
detail. Advisory, not blocking.
