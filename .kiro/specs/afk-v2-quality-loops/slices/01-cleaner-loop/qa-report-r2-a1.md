# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran in this worktree: `Done in 5s using pnpm v10.33.0`,
exit 0 (the skip authorization does not cover the install — it ran in a different
checkout). `pnpm run typecheck` I ran myself as well rather than only citing the
authorization: `tsc --noEmit`, no diagnostics, exit 0. The authorization for that
gate — evidence artifact
`.afk/logs/afk-v2-quality-loops-claude-code/run-20260913-055550/gates/s01/attempt-58c185de4b59.json`,
gate attempt `58c185de-4b59-4791-bea8-f30ce79e35e0`, tree
`7566b2d2416f7564a70633b743b833d18a972d4d` — agrees. No other pre-QA command is
named by the list, and the full suite was not run.

Beyond the sanity list I probed the two behaviors this round's routed finding turns on.
`pnpm vitest run src/qa-orchestration.test.ts -t "a clean policy"` — both tier-2 spawned
scenarios — passed 8 tests with 28 skipped, exit 0 in 56.5s.
`pnpm vitest run src/qa-orchestration-gates.test.ts` passed 23 tests, exit 0 in 84.9s,
which is the run that observes B-14's second pin (`expect(bumped.version).toBe(6)` at
`src/qa-orchestration-gates.test.ts:1016`). `pnpm test:fast` passed 2273 tests across 100
files, exit 0 in 170.9s, which is the run that observes the first pin
(`expect(RUN_STATE_VERSION).toBe(6)` at `src/eval-boundary.test.ts:127`) and every
P-01…P-10 preservation unit test. That run also printed one unhandled
`[vitest-worker]: Timeout calling "onTaskUpdate"` — a reporter RPC timeout under load in
vitest's own `rpc` chunk, with every test passing and exit 0. It is harness noise on a
loaded Windows host, touches no file this slice changed, and is not reported as a defect.

**Boundary.** Every file this slice's own commits touched is in the locked list. The
`#87` commits between `5b77dd1` and `060dd25` touch 30 of the 31 declared paths plus
`.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/escalation.md` (a superseded
artifact inside the slice directory, deleted by `a2ff5dc` after the focused-scope revision
was accepted and re-locked). The three `.kiro/specs/afk-v2-quality-loops/{afk.json,
issues.md, prd.md}` paths that show up in a naive `main...HEAD` diff belong to the
`docs(#73)` PRD-prep commits, not to this slice — they only matched a subject-line grep for
"#87" because those subjects name the issue the PRD selects. `afk.config.json` is not
edited, `suite-budgets.json` is not edited (the 178.7s `test:heavy:qa` overrun against the
151s budget is reported in the handoff for an operator decision, as the contract requires
rather than a number being raised), and `src/qa-review.test.ts` is untouched, which is what
keeps B-09's file scope closed.

**Preservation and behavior coverage.** All 24 mandatory ids carry at least one
`[behavior:#87:<id>]`-tagged test (`B-01` 16 through `P-09` 1, `P-10` 4; no id at zero).
`GATE_EVIDENCE_VERSION` still reads 4 at `src/gate-runner.ts:51`,
`SUPPORTED_GATE_EVIDENCE_VERSIONS` still `[1, 2, 3, 4]` at `:54`, and the pin at
`src/acceptance-gate.test.ts:306` still reads 4 — none bumped further, none moved back.
No version-5 pin against `RUN_STATE_VERSION` survives in `src/`: the only remaining
`version: 5` literals are `src/run-state.test.ts:1001`'s deliberate legacy-file fixture and
`src/gate-runner.test.ts`'s two "unsupported gate evidence version: 5" cases.
`QA_REVIEW_STAGES` at `src/qa-review.ts:95-99` still holds exactly the three original
members while the union at `:88-92` carries `"cleaner"`, and the docstring at `:77-86`
records that exception explicitly. `ARCHITECTURE.md:26,30,56-63` names
`src/cleaner-stage.ts`, `src/suppression-gate.ts`, the post-approval writing-stage seam and
`suppressions` under `GateDeclaration`. The handoff notes the `role`-source call site on
`#226` without closing it.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

`src/cleaner-stage.ts` (798 lines) reads as one loop with named exit paths, each commented
with the behavior it discharges and the ADR that forbids the alternative; the continuation
is `while (cleanerRoundsRemaining({ spent, limit }) > 0)` rather than a counter, as B-05
requires. The QA-01 repair is the right shape rather than the minimal one: the log stream is
opened *before* `phase-started` so a stream that fails to open can never enter the journal's
open-stage set, and `closeAgentLog` is awaited inside the `finally` before `phase-ended` is
emitted — the regression `6026c0a` documents, where the block form of `finally` silently
stopped awaiting what `.finally(cb)` had awaited, is fixed with a comment saying why the
await matters. One minor note (QA-02, advisory) is recorded below.

## Resolved findings
- **QA-01 — the cleaner dispatch journalled `phase-started` but never `phase-ended`.**
  Cleared. `src/orchestrator.ts:6843-6930` now opens the agent log, journals
  `phase-started` with `round: cleanerRound`, and in a `finally` awaits
  `closeAgentLog(cleanerLog)` and then journals `phase-ended` with the same
  `round: cleanerRound`, so each cleaner round pairs under its own
  `stageInvocationKey` (`ghIssue|agent|round`, `src/stage-durations.ts:52-55`) and
  `RunJournal.observeStageDuration` (`src/run-journal.ts:133-149`) deletes the key it
  paired. `src/qa-orchestration.test.ts:2913-2946` pins the whole cleaner event sequence for
  the three-round exhaustion run — `phase-started:1, phase-ended:1, stage-duration:1,
  …:2, …:3` — and it passes (exit 0, 8 tests). Two probes in this disposable worktree showed
  the assertion is not vacuous: collapsing both events back to the generator `round` failed
  with `expected [ 1, 1, 1 ] to deeply equal [ 1, 2, 3 ]` (line 2924, exit 1), and deleting
  the `phase-ended` emit failed with `expected [] to deeply equal [ 1, 2, 3 ]` (line 2925,
  exit 1). Both probes were reverted; `git status --porcelain` shows no `src/` change.

## Findings
### Finding 1 — `round` and `attempt` are inverted between a cleaner round's archive name and its persisted record
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/orchestrator.ts:6947-6971` archives with `round` = the generator round
and `attempt: cleanerRound`, yielding `cleaner-log-r2-a1.log` for generator round 2 /
cleaner round 1. `src/cleaner-stage.ts:558-563` (and `:601`, `:623`, `:735`, `:772`,
`:787`) persists the same round as `{ round: roundNumber /* cleaner round */, attempt:
round /* generator round */ }`, which `src/qa-orchestration.test.ts:2775-2787` reads back as
`{ round: 1, attempt: 2 }` — the mirror image of the filename for the same round.
**What the contract expected:** B-09 names the archive
`cleaner-log-r<round>-a<attempt>.log`; B-14 names the record `{ round; attempt;
inputTreeId; outputTreeId?; gateIds; outcome }`. Neither pins which number is which, so
this is a craft note, not a contract violation.
**What I observed:** Within one slice the two numbers swap names between the archive and
the persisted record, and neither module's comments say so. An operator correlating
`cleaner-log-r2-a1.log` with `{ round: 1, attempt: 2 }` has to work the inversion out.
Advisory only: it changes no observable outcome and blocks nothing.
