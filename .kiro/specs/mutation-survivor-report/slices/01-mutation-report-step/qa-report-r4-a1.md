# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: FAIL
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here and exited 0 (the authorized skip does
not cover it — it ran in a different checkout). `pnpm run typecheck` is covered
by the orchestrator's gate evidence
(`.afk/logs/mutation-survivor-report-claude-code/run-20260915-104003/gates/s01/attempt-6b2dd47b10bd.json`,
gate attempt `6b2dd47b-10bd-4b2e-afb4-a490c4d92f51`, tree
`94ffc016caf8c6fe5c3388b80b856dcd8e9e4b9c`), but I probed the tree and therefore
voided that authorization, so I re-ran it myself after restoring: `tsc --noEmit`
exited 0 with no diagnostics.

The change-summary artifact the prompt names
(`.afk/artifacts/mutation-survivor-report-claude-code/slice-01/change-summary.json`)
does not exist in this worktree — `.afk/artifacts/` is absent entirely. I derived
the change set from git instead (`git diff --name-only main...HEAD`,
`git diff --stat main...HEAD`, `git log --oneline`). That is a missing companion
artifact in a disposable checkout, not a defect in the candidate, so it is not a
finding.

### In-scope test files

Not the full suite (the orchestrator runs that after this stage). Every test file
in the contract's file scope, run verbatim:

- `pnpm vitest run src/mutation-report.test.ts src/cli-options.test.ts src/afk-manifest.test.ts src/preflight.test.ts src/run-state.test.ts src/eval-boundary.test.ts src/logger.test.ts`
  — 7 files, 339 tests, all passed, exit 0 (3.0s).
- `pnpm vitest run src/ship-gate.test.ts` — 55 tests, all passed, exit 0 (40.8s).

### Behaviors spot-checked at their declared seams

- B-11 concurrency: `mutationRun` is invoked before the first guardian review
  runs (`callsWhenFirstGuardianRan` is 1, src/ship-gate.test.ts:2312) and the
  file list it receives is B-10's filtered `["src/cart.ts"]` — the `.test.ts` and
  the `.md` are out.
- B-11 report-file-over-stdout: the seam returns `"stryker: 47% score…"` prose
  while the recorded outcome carries the JSON file's survivors.
- B-12: the origin really is the post-fork instant — `guardianDrivenClock` makes
  the spawn instant and the rejoin instant different numbers and the test asserts
  `clock.readings[0]` is the latter (src/ship-gate.test.ts:2523).
- P-03: both guardian modes, all three cases (already spawned, not yet spawned,
  terminate itself throwing), each asserting the rethrown reason is the
  guardian's own sentinel by identity (`rejects.toBe(sentinel)`) and that the
  path publishes nothing.
- P-01: flag absent leaves no mutation text in the PR body and no seam call.
- P-05: `src/run-state.test.ts:1359` still loads versions 3–6; `grep` over `src/`
  finds no other stale `RUN_STATE_VERSION` pin.

### Boundary compliance

Two files changed outside the contract's declared file list and outside
`acceptance-manifest.json`'s `fileScope.paths`:
`src/qa-orchestration.test.ts` and `src/qa-orchestration-gates.test.ts`. Both
carry only the `RUN_STATE_VERSION` 6→7 pin the authorized bump forces, and both
suites would fail without it. The work belongs in this slice; the declared file
list is what is incomplete, so the remedy is `SCOPE_AMENDMENT` (finding QA-07),
not the removal of working code. Everything else changed is in scope, plus
pipeline-owned negotiation and escalation artifacts under
`.kiro/specs/mutation-survivor-report/`, which the contract's non-goals
explicitly permit.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

`src/mutation-report.ts` is a genuinely self-contained module: pure parser, pure
predicate, pure classifier, one runner, one bounded-await helper, and the bound
as a module constant with no option path to it — pinned negatively by
src/mutation-report.test.ts:516, which asserts `src/ship-gate.ts` contains no
`30 * 60 * 1000` and no assignment to `MUTATION_STEP_BOUND_MS`, and that neither
`src/cli-options.ts` nor `src/orchestrator.ts` mentions a mutation bound or
timeout. The `BoundRace` discriminated union is the right call: `undefined` is a
real step result (the abandonment return), so a sentinel value would have been
ambiguous. Comments say why rather than what throughout.

Test honesty checked by probe, not by reading:

- Removing `mutationAbandoned = true;` from `terminateMutationStep`
  (src/ship-gate.ts:1023) makes src/ship-gate.test.ts:2449 fail with
  'expected "spy" to be called +0 times, but got 1 times'.
- Reintroducing a `report.reason ?? "COMMAND_FAILED"` substitution in
  `formatMutationReportLines` makes src/mutation-report.test.ts:692 fail with
  "expected '- Not run: `COMMAND_FAILED` …' not to contain 'COMMAND_FAILED'".

Both probes were reverted with `git checkout --` before typecheck was re-run.

One minor note is recorded as QA-08: the location guard is named `positiveInt`
but accepts `0` and fractional numbers, which a temporary probe confirmed
(`line: 0, column: 3.5` parses as a valid survivor position). Nothing downstream
misbehaves, so it is advisory.

## Resolved findings
- **QA-05** — the bound-reached rejoin exit left the pre-spawn window open. Now
  cleared: `terminateMutationStep` (src/ship-gate.ts:1022-1027) sets the
  abandonment flag before `quiesceWorktree(reviewDir)`, so the single `terminate`
  binding closes the window on *every* terminating exit rather than only on
  `abandonMutationStep`. The declared observable exists at
  src/ship-gate.test.ts:2449 and is load-bearing: with the flag assignment
  deleted it fails on `expect(mutationRun).toHaveBeenCalledTimes(0)` while the
  sibling BOUND_REACHED case still passes.
- **QA-06** — a reasonless `MUTATION_NOT_RUN` report rendered a substituted
  `COMMAND_FAILED`. Now cleared: src/mutation-report.ts:505-516 renders
  "- Not run: reason not recorded — …" with no fallback reason anywhere, and
  src/mutation-report.test.ts:692-712 asserts the rendered line names none of the
  four `MutationNotRunReason` values. Reintroducing the substitution fails that
  case.

## Findings
### Finding 1 — Two forced version pins sit outside the declared file list
**Severity:** Minor
**Pass:** 1
**Evidence:** `git diff --name-only main...HEAD` lists
`src/qa-orchestration.test.ts` and `src/qa-orchestration-gates.test.ts`; neither
appears in the contract's "Files expected to change" nor in
`acceptance-manifest.json`'s `fileScope.paths`. The diffs are exactly
`src/qa-orchestration-gates.test.ts:1043` `expect(bumped.version).toBe(6)` → `toBe(7)`
and `src/qa-orchestration.test.ts:1025-1028` `expect(state.version).toBe(6)` →
`toBe(7)` with its comment reworded to name #303's `mutationStep` record. Both
read a state loaded through `adaptLoadedState`, which returns
`RUN_STATE_VERSION` (`src/run-state.ts:1160`), so leaving them at `6` fails both
suites.
**What the contract expected:** B-13 — "`src/eval-boundary.test.ts` is in the
file scope for exactly this one literal and its comment wording; it is the only
hard pin anywhere else in the suite".
**What I observed:** That claim is inaccurate: two further hard pins exist in the
qa-orchestration suites and the bump forces both. The edits are correct and
minimal, so the remedy is a scope amendment declaring the two paths — asking the
generator to revert them would mean deleting working code to satisfy a file list.

### Finding 2 — `positiveInt` accepts zero and fractional numbers
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/mutation-report.ts:103-107` reads
`typeof value === "number" && Number.isFinite(value) && value >= 0`. A temporary
`src/probe08.test.ts` calling `parseMutationReport` on a `Survived` mutant with
`location.start = { line: 0, column: 3.5 }` passed, i.e. the survivor came back
with `startLine: 0` and `startColumn: 3.5`. The probe file was deleted; no
existing case in `src/mutation-report.test.ts` pins either boundary — the
malformed-location cases all use missing or non-numeric values.
**What the contract expected:** B-08 — survivors are returned with their
"identity, file, position, and mutator" parsed from the
mutation-testing-elements schema, whose line and column numbers are 1-based.
**What I observed:** A guard whose name promises a positive integer accepts `0`
and `3.5`. Nothing downstream misbehaves — the value is only rendered into a
report line — so this is a naming and strictness nit rather than a behavioral
defect, and it does not block.
