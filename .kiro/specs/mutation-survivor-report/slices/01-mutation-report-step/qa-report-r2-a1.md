# QA review — slice 01-mutation-report-step (mutation-survivor-report, #303)

Round: `qa-review-r2`

**Verdict:** FAIL

**Failure class:** IMPLEMENTATION

The slice implements its contract. All 17 in-scope behaviors are present and
exercised, all 5 preserved behaviors have passing assertions, every changed
file is declared in the acceptance manifest, and both pre-QA commands pass in
this checkout. It fails on one thing: a literal NUL byte makes
`src/mutation-report.test.ts` a binary blob to git, so the slice's largest new
test file cannot be diff-reviewed in the PR, cannot be grepped, and cannot be
blamed — permanently, and silently, because its tests pass.

## Pass 1

- **Pre-QA commands:** PASS
- **UAT verification:** NOT IN SCOPE
- **Boundary compliance:** PASS
- **Preservation check:** PASS

### Pre-QA commands

Both commands were run verbatim, in order, in this worktree:

```
pnpm install --frozen-lockfile   → exit 0
pnpm run typecheck               → exit 0
```

A skip authorization existed for `typecheck` (gate attempt
`e56ab98f-5924-41f0-ae9a-adb12ccb6530`, PASS at 2026-09-15T11:38:42.728Z in
5.6s, evidence
`.afk/logs/mutation-survivor-report-claude-code/run-20260915-071026/gates/s01/attempt-e56ab98f5924.json`).
I did not need it: I ran the command myself and it passed. That matters,
because I later ran a probe that edited `src/ship-gate.ts` — which would have
voided the authorization — and the sanity evidence therefore rests on my own
measurements rather than on the skip. The probe was restored from backup and
`git status --short src/ship-gate.ts` prints nothing; the only modified files
in the tree are `contract.md` and `acceptance-manifest.json`, whose `git diff`
is empty (CRLF noise only).

I did **not** run the project's full test suite, per the pipeline instruction
and `CLAUDE.md`. Targeted runs used as evidence below:

```
npx vitest run src/mutation-report.test.ts src/run-state.test.ts src/logger.test.ts \
  src/preflight.test.ts src/afk-manifest.test.ts src/cli-options.test.ts \
  src/eval-boundary.test.ts     → exit 0
npx vitest run src/ship-gate.test.ts   → 52 passed, exit 0, 33.25s
```

The ship-gate run includes all six P-03 rejecting-guardian cases green across
both serial and parallel mode.

### Boundary compliance

`.afk/artifacts/mutation-survivor-report-claude-code/slice-01/change-summary.json`
does not exist (`.afk/artifacts/` is empty), so the change set was derived from
`git log --oneline main..HEAD` (12 commits) and `git diff --stat main...HEAD`
(38 files, 4413 insertions, 37 deletions).

Every changed source and doc file is declared in the acceptance manifest's
22-path `fileScope`. The additional changed paths are all pipeline-owned PRD and
negotiation artifacts under `.kiro/specs/mutation-survivor-report/**`
(`intent.md`, `issues.md`, `prd.md`, `context.md`, `handoff.md`,
`feedback-r1.md`, `feedback-r2.md`, `contract-review*.json`, `escalations/**`)
plus `afk.json`, which was created by PRD-prep commit `1697e45` (+6 lines, no
`mutationReport` member) rather than by slice work. No scope amendment is
needed and no correct work needs deleting. Note that the manifest lists
`architecture.md` lowercase while the changed file is `ARCHITECTURE.md`; on this
platform both declare the same file, so I treated it as declared.

`ARCHITECTURE.md` is exactly 150 lines (`wc -l` = 150), so the `<= 150` cap
holds and no row was added — the change adds `src/mutation-report.ts` to the
existing `| Ship path |` internals cell.

### Preservation check

- **P-01** (nothing runs, publishes or terminates without the declaration) —
  covered at the real gate in `src/ship-gate.test.ts` and in
  `src/logger.test.ts`'s no-section case, which also re-asserts the other
  summary sections still render.
- **P-02** (manifest version throw; all members returned) — covered in
  `src/afk-manifest.test.ts`.
- **P-03** (a rejecting guardian still rethrows its own reason, in both modes)
  — six cases via `describe.each([["serial",true],["parallel",false]])`, all
  passing: already-started abandon+rethrow, not-yet-spawned via a held
  `mutationScope` with a post-release invocation count of 0, and
  terminate-throws still rethrowing the sentinel.
- **P-04** (`--preflight-report-only` downgrade) — covered in
  `src/preflight.test.ts`, including an assertion that the refusal is *not* a
  preflight finding (`JSON.stringify(report)).not.toContain("mutationReport")`).
- **P-05** (older run states load unchanged) — covered in
  `src/run-state.test.ts` looping versions `[3,4,5,6]` and asserting both
  `mutationStep === undefined` and byte-identical on-disk state, plus
  `EVENTS_SCHEMA_VERSION` still pinned to `1` in `src/eval-boundary.test.ts`.

The guardian mode fork at `src/ship-gate.ts` keeps both branch bodies
byte-unchanged; they are only re-indented inside a new `try`. The abandonment
path reads the flag with no intervening `await` before invoking the runner, and
uses a single `terminate` binding (`quiesceWorktree(reviewDir)`), as the
contract prescribes.

## Pass 2

- **Convention compliance:** PASS
- **Code quality:** PASS
- **Test quality:** NOTES

Convention: the new module follows the codebase's shapes — `mutationReport` is
optional-and-absent when undeclared (spread guards in both `parseAfkManifest`
and `runShipGate`'s call site), the CLI flag mirrors `preflightReportOnly`
exactly as the contract pins, `readMutationStepOutcome` mirrors
`readQualityStageOutcomes`, the refusal is a pure function rather than a
`PreflightCheck` (correct under ADR 0042), `afk.json` stays at `version: 1`
(ADR 0034), and `EVENTS_SCHEMA_VERSION` stays `1` for a purely additive payload.
The one-derivation rule holds: both `run-summary.md` and the draft PR body
render through `readMutationStepOutcome` → `formatMutationReportLines`. No
import cycle: `logger.ts` → `mutation-report.ts` → `change-summary.js` +
`worktree-processes.js`, neither of which imports the logger.

Code quality: B-07's ordering obligation was verified numerically rather than
by eye — byte offsets in `src/orchestrator.ts`, each anchor occurring exactly
once: `assertWithinManifestScope({` 357311 < `refuseUndeclaredMutationReport({`
358002 < `const initialized = updateRunState(` 358205 < `runLaunchPreflight(`
360068 < `runWave(` 385909. The classifier's precedence (bound → command failure
→ unreadable → malformed → reported) matches the contract, and
`sanitizeMutationStep` degrades the whole record on any malformed part rather
than silently dropping survivors.

Test quality carries the notes below. I considered and dismissed several
suspicions as non-defects rather than reporting them: `mutationReport`
defaulting to `false` (the contract pins "in the shape of
`--preflight-report-only`"); the `remaining <= 0` unhandled-rejection path in
`awaitMutationStepWithinBound` (unreachable in production, since both call
sites capture `origin` immediately before calling with real `Date.now`); the
double `terminate` on the abandonment path (the contract prescribes exactly
that order with that single binding); `defaultMutationRun`'s untested
`shell: true` spawn (the contract's non-goal forbids invoking a real mutation
tool, and B-12 substitutes a source assertion for `registerWorktreeProcess(`);
and B-13's round-trip using a provenance slug different from its write key (the
same obligation is asserted at the real gate).

## Resolved findings

none

## Findings

### Finding 1 — QA-01 (BLOCKING, B-08)

A literal NUL byte in `src/mutation-report.test.ts` makes git classify the
slice's largest new test file as binary, so it can never be diff-reviewed or
grepped.

**Evidence.** The byte sits at file offset 7233, line 214 (count 1), inside the
parser's never-throws loop:

```ts
for (const text of ["", "null", "true", '{"files":null}', "\x00"]) {
  expect(() => parseMutationReport(text)).not.toThrow();
}
```

The source holds a raw `0x00` there rather than an escape sequence. (Locating it
took two tries: `grep -c $'\x00'` returns 747 under Git Bash because the pattern
degenerates to empty and matches every line. Enumerating distinct byte tokens
with `od -An -c | tr ' ' '\n' | sort -u` and then a Python one-liner over the
raw bytes gave the exact offset and count.)

Observable consequences in this worktree:

```
$ git diff --stat main...HEAD -- src/mutation-report.test.ts
 src/mutation-report.test.ts | Bin 0 -> 28258 bytes

$ git diff main...HEAD -- src/mutation-report.test.ts
Binary files /dev/null and b/src/mutation-report.test.ts differ

$ git grep -n "not.toThrow" -- src/mutation-report.test.ts
Binary file src/mutation-report.test.ts matches
```

Every other new file in the slice reports a line count in `--stat`; only this
one reports `Bin`. `.gitattributes` contains only `*.mjs text eol=lf`, so no
attribute overrides git's binary heuristic for `*.ts`. The refusal to print
matches is how I found the problem: `git grep` would not show me the file's
lines and I had to fall back to the Read tool, which renders the NUL as a space.

**Expected.** The new test files the slice adds are reviewable as text:
`git diff` renders their contents, `git grep` / `git log -p` search and show
their lines, and the GitHub PR shows a line-by-line diff — the ordinary way any
reviewer or future agent reads B-08's parser coverage.

**Observed.** `src/mutation-report.test.ts` is a binary blob to git. Its 746
lines never appear in any diff, local or in the draft PR. `git grep` will not
print a match inside it, `git blame` and `git log -p` are useless on it, and
every future edit to the file inherits the same silence. The slice's single
largest test file — the one carrying the parser's eight malformed-input cases,
the eligibility matrix, and the source-text assertions the contract
deliberately substitutes for real mutation runs — is unreviewable. Nothing
warns anyone, because the tests pass: `npx vitest run src/mutation-report.test.ts`
exits 0.

**Clear condition.** `git diff main...HEAD -- src/mutation-report.test.ts`
prints a textual line-by-line diff (not `Binary files ... differ`), and
`git grep -n 'not.toThrow' -- src/mutation-report.test.ts` prints the matching
line rather than `Binary file ... matches`, with
`npx vitest run src/mutation-report.test.ts` still exiting 0.

**Remedy.** `SOURCE_CHANGE`. Replacing the raw byte with a JavaScript escape
sequence for code point zero (backslash-`u`-`0000`, or backslash-`x`-`00`)
yields the identical runtime string, so the test's meaning is unchanged and only
the file's on-disk bytes differ. A guard rule in `.gitattributes` is not needed;
the escape is sufficient. (Writing this report hit the same trap — the escape I
typed here first landed as a raw NUL and briefly made `qa-report.md` itself
binary to git, which is a fair measure of how quietly this happens.)

### Finding 2 — QA-02 (ADVISORY, B-11 + B-16)

The gate-id half of B-11's and B-16's observable — that the gate ids and gate
results a run reports are identical with the flag set and with it absent — is
asserted nowhere.

**Evidence.** B-11 requires that "the gate ids the run reports with the flag set
are identical to those it reports with the flag absent, so the step holds no
gate id and constructs no `GateDeclaration`", and B-16's manifest observable
says the check "asserts gate ids, verdicts and the PR-open decision are equal
across the two runs". The `describe("[behavior:#303:B-16] ...")` block in
`src/ship-gate.test.ts` compares only the results of two `buildPrCreationPlan(...)`
calls — one with `mutationStep` supplied, one without. Grepping the whole new
mutation describe range (`src/ship-gate.test.ts:2094-2695`) for `gateId`,
`gateIds`, `GateDeclaration` and `gates` returns no assertion. `ShipGateResult`
is `{ verdict, failureReason?, pr }`, so gate ids are not reachable from the
value the tests already hold.

**Expected.** One assertion comparing the gate identity/result surface across a
flag-set run and a flag-absent run. This is feasible with machinery the slice
already built: `teeing(fixture)` adds the `events.jsonl` tee the fixture journal
lacks, so the emitted gate events — and the absence of any mutation gate id
among them — can be compared set-for-set between the two runs.

**Observed.** Verdict equality and the PR-open decision *are* covered at the
real gate (the flag-absent P-01 case and the B-16 plan comparison). Gate-id and
gate-result equality is only argued structurally: `runShipGate` never builds a
`GateDeclaration` for the step, and `journal.event({ type: "mutation-step", ... })`
is a plain event. The claim is almost certainly true today; it is simply
unpinned, so a later change that promoted the step to a declared gate would not
fail a test — which is precisely the regression ADR 0063's "reported, never a
gate" rule exists to prevent.

**Clear condition.** A test in `src/ship-gate.test.ts` runs the gate twice —
once with `mutationReport` declared, once without — and asserts the gate ids /
gate results it reports are equal across the two runs (for example by comparing
the gate-bearing entries of the teed `events.jsonl`), and that no gate id names
the mutation step.

**Remedy.** `SOURCE_CHANGE`.

### Finding 3 — QA-03 (ADVISORY, B-12)

B-12's "the rejoin origin is the post-fork instant at which both guardian
results are in hand" is not distinguished by any assertion.

**Evidence.** The BOUND_REACHED test drives the gate with `spentClock()`, which
returns `0` on its first reading and `MUTATION_STEP_BOUND_MS + 1` on every
reading after (`readings++ === 0 ? 0 : MUTATION_STEP_BOUND_MS + 1`). In
`src/ship-gate.ts`, `mutationClock` is read nowhere between the step's launch
and `const mutationRejoinOrigin = mutationClock();`, so that capture is always
the first reading and always yields `0` — identically whether it sits before the
guardian mode fork or after it. The subsequent `now()` inside
`awaitMutationStepWithinBound` yields the spent value, so `remaining <= 0` and
the BOUND_REACHED branch is taken either way.

I tried to confirm this by relocating the capture above the fork. The first
attempt left the source unparsable (esbuild `failureErrorWithLog`, "Tests no
tests") and was restored from the backup I had taken first; the second attempt
failed to match its anchor and made no edit, so the file was never actually
mutated and the tree is clean. The conclusion therefore rests on inspection of
the two clock reads rather than on a passing mutated build — but it does not
depend on the probe: with only one clock read before the capture, the position
of that read cannot change its value.

**Expected.** An assertion that fails if the origin were captured at the wrong
instant — for example a clock returning distinguishable timestamps at spawn, at
each guardian's completion and at rejoin, with the test asserting the origin
equals the post-fork reading, so a run whose guardians consumed most of the
bound gets the correctly shortened remaining window.

**Observed.** The bound arithmetic itself is well covered (the `delay` case
asserts a `20 * 60 * 1000` remaining window). But the specific claim that the
origin is taken *after* both guardian results are in hand is not observable from
any test in the slice. Moving that capture earlier — which would silently grant
the step a longer wall-clock window than the contract allows once guardians are
slow — keeps the suite green.

**Clear condition.** A test in `src/ship-gate.test.ts` drives the gate with a
clock whose readings are distinguishable across spawn / guardian completion /
rejoin and asserts the bounded wait's origin is the post-fork reading, failing
if the capture is moved above the guardian mode fork.

**Remedy.** `SOURCE_CHANGE`.

### Finding 4 — QA-04 (ADVISORY, B-08)

The ARCHITECTURE.md line-cap assertion filters with an always-true predicate.

**Evidence.** `src/mutation-report.test.ts:232` reads:

```ts
const lines = architecture.split("\n").filter((line) => line !== "" || true);
```

The `|| true` makes the predicate unconditionally true, so no line is ever
dropped and `filter` is a no-op that only obscures what is being counted.

**Expected.** Either no filter (count every line) or a filter whose predicate can
actually exclude something, so a reader can tell which of the two the `<= 150`
cap is asserted against.

**Observed.** The assertion still does its job — `ARCHITECTURE.md` is exactly
150 lines and no row was added, so the cap check passes and is meaningful — but
the dead predicate misleads the next reader, and it will survive as noise in a
file that, per QA-01, nobody can grep.

**Clear condition.** `src/mutation-report.test.ts:232` no longer contains an
always-true filter predicate, and the ARCHITECTURE.md line-cap assertion still
passes.

**Remedy.** `SOURCE_CHANGE`.
