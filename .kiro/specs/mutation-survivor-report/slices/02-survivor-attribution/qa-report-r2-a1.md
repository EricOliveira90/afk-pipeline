# QA Report

**Verdict:** PASS
**Failure class:** NONE

Deterministic slice QA, round 2, on the candidate at git tree
`ad32bdfe2d147c027992e206971aa5f7ac3a91ff`. The change summary artifact named in
the brief (`.afk/artifacts/.../slice-02/change-summary.json`) is not present in
this worktree — `.afk/` does not exist here at all — so the slice's actual change
set was read from git instead: `git diff --stat 2a7c983..HEAD`, 22 files, 11 of
them source, all 11 inside the contract's declared file list.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — exit 0. Run here; the skip authorization
  does not cover it.
- `pnpm run typecheck` — exit 0, `tsc --noEmit` silent. Run rather than cited:
  a probe test file was added to this worktree during review, which voids the
  authorization, so the command was executed on the restored tree.

### Behavior verification

Every behavior id was exercised against the candidate's own code through a
throwaway probe (`src/qa-probe.test.ts`, added and removed in this disposable
worktree). Observed:

- **B-01 / B-02** — `parseAfkManifest` returned
  `{"command":"x","reportPath":"r.json","baselinePath":"reports/mutation/incremental.json","decisionsPath":"docs/mutation-decisions.json"}`
  for a declaration spelled `./reports\mutation\incremental.json`: both keys
  come back, normalized. With neither key declared,
  `"baselinePath" in mutationReport` is `false` — absent, not
  `undefined`-valued. All four refusals (blank/whitespace, glob, POSIX and
  drive-letter absolute, `..`) plus non-string values fire on both members and
  name the member at fault.
- **B-03** — asserted on the bytes on disk after
  `trimUnclaimedMigrationPrefixes`, not on the returned object
  (`src/afk-manifest.test.ts`, passing).
- **B-04** — every rejection returned `MALFORMED` with a member-naming detail
  and nothing threw: not JSON, non-object, `version: 2`, absent `decisions`,
  `verdict: "MAYBE"`, blank `reasoning`, missing `reasoning`. Readers separated
  absence from unusability: a path with no file returned `{"status":"ABSENT"}`
  for both readers, a directory at the same path returned `UNREADABLE` for both,
  and `readMutationReport` still calls a missing report `UNREADABLE`.
- **B-05** — a baseline holding the same file, mutator and four position numbers
  under id `77` labelled survivor `1` `pre-existing` and survivor `2`
  `new-in-this-run`: the match ignores the id, as specified.
- **B-06 / B-08** — the full matrix, in one probe run:
  omitted baseline → `unattributed,unattributed` notes `[]`;
  `ABSENT` baseline → same, notes `[]`;
  `MALFORMED` and `UNREADABLE` baseline → same labels, notes
  `["BASELINE_UNUSABLE"]`;
  `ABSENT` decisions over a parsed baseline → `pre-existing,new-in-this-run`
  notes `[]`; `MALFORMED` and `UNREADABLE` decisions → same labels, notes
  `["DECISIONS_UNUSABLE"]`; both unusable → both notes. `ABSENT` and
  `MALFORMED` differ only by the note, which is what B-06 and B-08 jointly
  require.
- **B-07** — two survivors sharing id `1` across `src/a.ts` and `src/b.ts` with
  an ACCEPT entry for `src/a.ts`: `src/a.ts=accepted src/b.ts=new-in-this-run`,
  so `file` really corroborates. A `KILL` entry changed no label and produced no
  note.
- **B-09** — `runMutationStep` on a temp cwd holding a report, a baseline and a
  decisions file returned labelled survivors and, for a malformed baseline plus
  a directory-at-decisions, `attributionNotes: ["BASELINE_UNUSABLE",
  "DECISIONS_UNUSABLE"]` with status still `MUTATION_REPORTED`. The reads sit
  after the awaited command; the pre-spawn abandonment read still has no `await`
  before the runner invocation.
- **B-10** — the formatter emitted one bullet per survivor ending in its label,
  one line per note, and it renders notes on the zero-survivor line too. An
  unlabelled survivor renders exactly as before this slice.
- **B-11** — labels and notes round-trip the event stream and run state;
  `deriveMutationStepOutcome` is the single place that substitutes
  `unattributed` for a pre-attribution record, and `sanitizeMutationStep` copies
  a recognized label through rather than defaulting one.
- **B-12** — the strongest evidence in the slice: two real `runShipGate` runs
  differing only by the two declared paths produced a set-for-set identical gate
  surface, the same verdict, the same `pr` object and the same `failureReason`,
  while the `accepted` survivor still appeared as a bullet in the published PR
  body (`- \`42\` src/cart.ts:3:11 — ArithmeticOperator — accepted`). Marked,
  never suppressed, and nothing gated.

### Preservation

- P-01/P-02/P-04/P-05/P-06 are retitle-only, as the DoD requires. Checked
  mechanically: the removed-line side of `git diff 2a7c983..HEAD` over the five
  test files contains **only** `describe`/`it` name strings and two additions
  (an import line and a comment), no assertion, expected string, fixture or
  `it.each` row. Each named line number was confirmed against
  `git show 2a7c983:<file>` — e.g. `src/logger.test.ts:1719` is the P-01 test
  and was retitled only; the one behavioral test edit in that file is at
  `:1698`, a `[behavior:#303:B-14]` test this contract does not preserve, and
  its new expectation (`label: "unattributed"`) is exactly what B-11 says such a
  record means.
- P-03 verified directly: `MutationNotRunReason` gains no member, and four
  degraded baseline/decisions configurations all classify `MUTATION_REPORTED`.
- `pnpm vitest run src/afk-manifest.test.ts src/mutation-report.test.ts
  src/run-state.test.ts src/logger.test.ts src/ship-gate.test.ts` — **343
  passed, 5 files, exit 0, 63.5s.** Every `B-01`–`B-12` and `P-01`–`P-06` tag is
  present in a passing full name.

### Boundary compliance

All 11 changed source files are in the declared list; nothing outside it was
touched. The remaining changed paths are the pipeline's own
`.kiro/specs/mutation-survivor-report/**` artifacts (contract, handoff, prior QA
reports), not code. Migration count 0, as declared. No amendment is needed.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The one shared `normalizeMutationReportPath` helper keeps `reportPath`'s
messages byte-identical while giving each new member its own noun, which is why
the P-02 table needed no edit. `attributeMutationSurvivors` maps rather than
filters, with the reason in a comment. `KEY_FIELD` as an escaped NUL instead of a
literal one keeps the module text rather than binary. Absence discipline is
consistent across the manifest object, the event payload, the persisted record
and `attributionNotes`.

Test honesty was checked by mutation, not by reading: four independent breaking
edits — treating `KILL` as `ACCEPT`, making an `ABSENT` baseline produce a note,
dropping the label suffix in the formatter, and defaulting the label in
`sanitizeMutationStep` — turned **9 tests red** across
`src/mutation-report.test.ts` and `src/run-state.test.ts`. The tree was restored
and `git status` confirmed clean afterwards. B-12's source-scan half hardcodes a
gate-module list, so a future gate module would not be scanned, but the
behavioral half (two real gate runs) covers that case; not worth a finding.

## Resolved findings
- None. `QA-01` is repeated below as `OPEN`.

## Findings
### Finding 1 — QA-01: samePath folds backslashes but not a leading `./`, on both match keys
**Severity:** Minor
**Pass:** 2
**Evidence:** Probe on this candidate tree
(`pnpm vitest run src/qa-probe.test.ts`), one survivor id `1` file
`src/cart.ts`:

```
decisions entry file spelled:
  "src/cart.ts"     -> accepted
  "./src/cart.ts"   -> unattributed
  "  src/cart.ts  " -> accepted
  "src\cart.ts"     -> accepted

baseline survivor file spelled "./src/cart.ts", same location:
  -> new-in-this-run   (expected pre-existing)
```

Root cause is one function shared by both keys: `src/mutation-report.ts:445-447`
`samePath` is `file.replace(/\\/g, "/")` — the backslash half of the already
exported `normalizeWaiverPath` (`src/afk-manifest.ts:146-148`,
`value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")`) with the `./` strip
dropped — and both `baselineKey` (`:465`) and `decisionKey` (`:490`) call it.

Round 1's clear condition offered two ways out and neither holds on this tree.
The whitespace half is now satisfied, but by `parseMutationDecisions`'s per-field
`.trim()` (`:374`) rather than by `samePath`; the `./` half is unsatisfied on
both keys. `samePath` carries no record of the divergence — its comment is "One
spelling for a path, so a baseline and a report compare the same bytes" — and no
test asserts the `./` spelling (`grep -n '\./' src/mutation-report.test.ts`
returns only import specifiers). `git log -p` since `2a7c983` shows `samePath`
unchanged since round 1.

**What the contract expected:** B-07 fixes the decisions key as the tool's `id`
"corroborated by `file`" and B-05 fixes the baseline key on "`file`, `mutator`
and all four `position` numbers"; neither mandates path normalization, so partial
tolerance is inside the contract. The expectation this sets is one `samePath`
itself creates: it exists to fold a path-spelling difference, and `afk.json`'s
own `baselinePath`/`decisionsPath` go through `normalizeWaiverPath`, so the
manifest tolerates `./` where the artifacts' own `file` members do not.

**What I observed:** A `./`-prefixed `file` resolves nothing on either key — the
ACCEPT entry leaves its survivor at the baseline label, or a genuinely
pre-existing survivor is reported `new-in-this-run` — and no note is produced,
so the operator gets no signal that their spelling matched nothing. The harm is
bounded exactly as B-07 and B-12 describe and as `src/ship-gate.test.ts:2577`
proves: one report bullet, read by no gate, verdict or PR-open condition, with
the survivor still in the list at full detail. Advisory, not blocking.
