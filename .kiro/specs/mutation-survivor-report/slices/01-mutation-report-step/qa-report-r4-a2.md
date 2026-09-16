# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

Both pre-QA commands ran in order on this tree and passed:

- `pnpm install --frozen-lockfile` — "Lockfile is up to date, resolution step is
  skipped / Already up to date", `prepare` ran `tsc -p tsconfig.build.json`
  clean, exit 0.
- `pnpm run typecheck` — `tsc --noEmit`, no output, exit 0.

No skip authorization was in force (base gates ran on tree
`94ffc016…`, this tree is `3bf556cb…`), so both were run here rather than
inherited.

The change-summary artifact named in the brief
(`.afk/artifacts/mutation-survivor-report-claude-code/slice-01/change-summary.json`)
does not exist in this worktree — `.afk/artifacts/` is absent entirely. I
derived the same facts from git instead (`git log --oneline main..HEAD`,
`git diff --stat main...HEAD`, `git diff --name-only 8303aae^..HEAD`). This is
a missing QA input, not a defect in the candidate, so it is not filed as a
finding.

### Behavior verification

Every in-scope test file was run as a probe. All pass:

| Command | Result |
| --- | --- |
| `pnpm vitest run src/mutation-report.test.ts src/cli-options.test.ts src/afk-manifest.test.ts src/preflight.test.ts src/run-state.test.ts src/eval-boundary.test.ts src/logger.test.ts` | 7 files, 339 tests passed, exit 0 |
| `pnpm vitest run src/ship-gate.test.ts` | 1 file, 55 tests passed, exit 0 |
| `pnpm vitest run src/qa-orchestration.test.ts src/qa-orchestration-gates.test.ts` | 2 files, 59 tests passed, exit 0 |

453 tests, no failures. Named coverage exists for every behavior id B-01
through B-17 and P-01 through P-05. The contracted scenario matrix for the
guardian fork is complete and present under both modes: `src/ship-gate.test.ts`
runs "abandons an already-started step, terminates it, and rethrows the
guardian's own reason", "never starts a step still deriving its scope when the
guardian rejects", and "still rethrows the guardian's reason when termination
itself fails" once under `[P-03] a rejecting guardian in serial mode` and once
under `[P-03] a rejecting guardian in parallel mode`.

The three round-4 fixes each land where the routed findings asked:

- **QA-05 / B-12 pre-spawn window on the bound-reached exit** (d91f38d):
  `terminateMutationStep` now sets `mutationAbandoned = true` before calling
  `quiesceWorktree(reviewDir)` (`src/ship-gate.ts:1030-1033`), so the
  bound-reached rejoin closes the window through the same code the rejection
  exits do. The new case
  `[behavior:#303:B-12] never spawns a step still deriving its scope once the bound is spent`
  holds the step on a `mutationScope` promise, releases it only after the gate
  has returned, and asserts `mutationRun` invocation count 0.
- **QA-06 / B-14 reasonless report** (b04e4ee): `formatMutationReportLines`
  no longer substitutes `COMMAND_FAILED` for a missing reason
  (`src/mutation-report.ts:505-515`); it renders "reason not recorded". The new
  case asserts the line names none of the four `MutationNotRunReason` values.
- **Version pins** (7b6740f): the two loaded-state pins in
  `src/qa-orchestration-gates.test.ts` and `src/qa-orchestration.test.ts` now
  read `7`, and both files pass.

**Probe — B-07 is falsifiable.** The contract makes the refusal's source
position the observable, so I checked the assertion can actually fail. I moved
the `refuseUndeclaredMutationReport({ … })` call and its throw from inside the
manifest fail-closed block (`src/orchestrator.ts:8522-8526`) to after
`const initialized = updateRunState(`, then ran
`pnpm vitest run src/mutation-report.test.ts -t "B-07"`:

```
× [behavior:#303:B-07] sits inside the manifest fail-closed block, ahead of state, preflight and the first wave
  → expected 358628 to be less than 357969
    648|     expect(scopeAt).toBeLessThan(refusalAt);
```

`src/orchestrator.ts` was restored from a backup afterwards; `git status`
confirms it is unmodified. The -1 cases are also covered: because
`expect(scopeAt).toBeGreaterThan(-1)` pins the first anchor above -1, deleting
any later anchor breaks the `toBeLessThan` chain rather than passing vacuously.

**Boundary compliance.** Every source file the slice touched
(`git diff --name-only 8303aae^..HEAD`) is declared in the contract's file
list and in `acceptance-manifest.json` `fileScope.paths`, including the two
`qa-orchestration` files added by the QA-07 amendment. The other paths in the
range are pipeline-owned negotiation artifacts under the slice directory
(`context.md`, `contract-review.json`, `feedback-r1.md`, `feedback-r2.md`,
`handoff.md`, `intervention.json`, `stuck.md`, the QA reports), which the
contract's last non-goal explicitly leaves to the planner and evaluator roles.
`.kiro/specs/mutation-survivor-report/afk.json` also differs from `main`, but
`git log -- <path>` attributes it to `1697e45 docs: prepare
mutation-survivor-report PRD for AFK`, before the slice began. No undeclared
change, and no new finding.

**Preservation.** Checked rather than assumed:

- P-01 — `[behavior:#303:P-01] runs nothing, publishes nothing and terminates nothing without the declaration` passes.
- P-02 — `src/afk-manifest.test.ts` 29 tests pass, including the version throw and waiver members.
- P-03 — six cases pass (three per guardian mode), as listed above.
- P-04 — `src/preflight.test.ts` 52 tests pass; the refusal is a pure function, not a `PreflightCheck`/`PreflightFinding`.
- P-05 — `src/run-state.test.ts` (58 tests) and `src/eval-boundary.test.ts` (8 tests) pass; `ARCHITECTURE.md` is exactly 150 lines and its `| Ship path |` row's internals cell names `src/mutation-report.ts` (`ARCHITECTURE.md:33`), so the `<= 150` cap assertion needed no edit, as the contract predicted.
- B-16 — `[behavior:#303:B-16] changes only the body text, never the decision` passes for each outcome.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

The module is well-shaped for what it does: `src/mutation-report.ts` keeps the
parser, classifier, predicate, runner and bounded helper pure and total, every
rejection path is a value rather than a throw, and the comments explain the
*why* (why the bound wins over a partial report, why the flag read has no
`await` after it, why the empty-survivor case renders its own line) in the
register the rest of the repo uses. Three notes, all ADVISORY, none material
enough to fail:

- `positiveInt` still accepts 0 and non-integers (QA-08, unchanged from round 3).
- `sanitizeMutationStep` validates four fields and casts the fifth (QA-09, new).
- A stale orphan doc comment on `BoundRace` (QA-10, new).

Test quality is genuinely good. The assertions are falsifiable rather than
decorative — B-07 was verified to fail when the call site moves, the
pre-spawn cases assert an invocation *count* of 0 after an explicit release
and flush rather than merely that nothing threw, and B-11's stdout case makes
the seam return a differently-shaped report so that reading the file rather
than stdout is what the assertion distinguishes. No test invokes a real
mutation tool and none waits on a real 30-minute bound.

## Resolved findings
- **QA-07 (scope amendment for the two loaded-state version pins) — RESOLVED.**
  `contract.md:419-420` now declares `src/qa-orchestration.test.ts` and
  `src/qa-orchestration-gates.test.ts`, and
  `acceptance-manifest.json` `fileScope.paths:28-29` declares both bare paths.
  Commit 7b6740f moves the two pins to `7`, and
  `pnpm vitest run src/qa-orchestration.test.ts src/qa-orchestration-gates.test.ts`
  passes 59 tests, exit 0.

## Findings
### Finding 1 — `positiveInt` accepts 0 and non-integers, and neither rejects nor renames
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/mutation-report.ts:103-107` is unchanged from round 3 —
`typeof value === "number" && Number.isFinite(value) && value >= 0` — and the
function is still named `positiveInt`. A temporary probe test (since deleted)
handed `parseMutationReport` a `Survived` mutant with
`location: { start: { line: 0, column: 1.5 }, end: { line: -0, column: 2.25 } }`:

```
PROBE RESULT: {"status":"PARSED","survivors":[{"id":"m1","file":"src/a.ts","mutator":"Arith","position":{"startLine":0,"startColumn":1.5,"endLine":0,"endColumn":2.25}}]}
```

`formatMutationReportLines` would render that survivor as `src/a.ts:0:1.5`. No
case in `src/mutation-report.test.ts` pins zero or non-integer rejection; all
66 tests pass without one.
**What the contract expected:** B-08 — "a pure function that parses a
mutation-testing-elements report (the schema StrykerJS and peers emit) into a
survivor list of mutant identity, file, position, and mutator".
**What I observed:** The guard admits positions the schema cannot produce
(line 0, fractional columns) while its name claims to check for positive
integers. Report-only text, so nothing is gated on it — hence advisory.

### Finding 2 — `sanitizeMutationStep` casts `reason` instead of validating it
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/run-state.ts:983-985` reads
`...(nonblank(record.reason) ? { reason: record.reason as MutationNotRunReason } : {})`.
Every other field in that function is validated and a failure degrades the
whole record to `undefined`: `runSlug` must be nonblank (`:959`), `status` must
be one of the two literals (`:960-965`), and a single bad `survivors` entry
drops the record rather than shortening the list (`:977-979`). A temporary
probe (since deleted) wrote `.afk/state/slug.json` with `reason: "banana"`:

```
PROBE loaded: {"runSlug":"slug","status":"MUTATION_NOT_RUN","reason":"banana","survivors":[]}
```

and handing that record to `formatMutationReportLines` yields
``- Not run: `banana` — no survivor list was produced. Nothing was gated on this (ADR 0063).``
**What the contract expected:** B-13 — "the reader for the schema fact is the
load adapter (`adaptLoadedState`)"; the function's own doc says "Keep the
mutation-step record only when it is whole … a malformed record degrades to
absent rather than throwing" (`src/run-state.ts:945-948`).
**What I observed:** An arbitrary nonblank string on disk is returned typed as
`MutationNotRunReason`. No consumer reads `state.mutationStep.reason` today —
the report text is derived from the event stream (`src/logger.ts:877`,
`src/ship-gate.ts:1467`), which is why this is advisory and not blocking — so
the reachable consequence today is a type that lies rather than wrong report
text. It becomes reachable text the moment a reader derives from the persisted
record, which slice 2 (#304) extends.

### Finding 3 — stale orphan doc comment on `BoundRace`
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/mutation-report.ts:439-447` carries two consecutive doc
comments on one type. Line 439:
`/** Sentinel for "the bound fired first" — never a value the step can produce. */`
Lines 440-444: "Race arms, discriminated rather than sentinel-valued:
`undefined` is a real step result (the abandonment return), so the bound arm
cannot be represented by any value the step arm could also produce."
**What the contract expected:** No contract clause; this is a Pass 2
convention note.
**What I observed:** The first comment documents the sentinel design the second
comment explicitly says was rejected, and it is attached to nothing. A reader
meets the discarded design first.
