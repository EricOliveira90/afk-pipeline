# QA review — slice 01 "Cleaner loop" (#87)

**Verdict:** FAIL

**Failure class:** IMPLEMENTATION

One BLOCKING finding, `QA-01`, against contract behavior B-06: the cleaner dispatch
journals `phase-started` and never `phase-ended`, so the `stage-duration` sample B-06
says "exists without new code" is never produced, and no test would notice.

Everything else in Pass 1 is clean. Pass 2 was not entered, because Pass 1 is not clean.

## Pass 1

### Pre-QA commands

PASS. Both commands were run verbatim in this checkout, before any probe edit of mine:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm run typecheck` | exit 0, no diagnostics |

The offered skip authorization for `typecheck` (gate attempt
`ffe0e539-4b01-4c5d-a222-cc65293dda98`, PASS at 2026-09-13T08:39:37.351Z, evidence
`.afk/logs/afk-v2-quality-loops-claude-code/run-20260913-052918/gates/s01/attempt-ffe0e5394b01.json`)
was not relied on: I ran `typecheck` myself on the tree as handed to me. I later modified
`src/qa-orchestration.test.ts` for the probe described under QA-01, which voids the
authorization — but the command evidence above predates that edit, so Pass 1's evidence
stands on its own. The probe edit is discarded with this worktree and is not part of the
candidate.

The project's full test suite was not run.

### UAT

NOT IN SCOPE for this stage.

### Boundary compliance

PASS. The 31 non-spec files changed against `main` are exactly set-equal to the
acceptance manifest's `fileScope` (`kind: "paths"`, 31 entries), which is itself
set-equal to the contract's "Files expected to change" list. Commit `a2ff5dc`
additionally deletes `.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/escalation.md`,
a path inside the slice's own artifact directory, which the `candidate` scope source
exempts by prefix. No remedy is needed, so no finding carries `SCOPE_AMENDMENT`.

The contract's two outstanding version-literal pins (its only remaining Definition of
Done work) landed exactly in `a2ff5dc`: both `5` → `6`, one line in each file, nothing
else in either. All 24 `[behavior:#87:<id>]` tags are present.

*Caveat, not a defect:* `.afk/artifacts/afk-v2-quality-loops-claude-code/slice-01/change-summary.json`
does not exist in this worktree — the whole `.afk/` tree is absent. The change set was
derived from git (`git log`, `git diff --stat main...HEAD`, `git diff --name-only main...HEAD`)
instead. That is a harness artifact absence, not candidate work.

### Preservation check

PASS on every property I checked (checked, not assumed):

- **P-10** — `outOfScopeChangedPaths` (`src/escalation.ts:305-372`) still tests the
  `orchestratorOwned` carve-out *before* the declared-path and artifact-directory
  continues, so the unwaivable offender still cannot be exempted; the new
  `artifactDirPolicy` defaults to `"exempt-prefix"`, preserving prior behavior.
- **P-09** — `QA_REVIEW_STAGES` is unchanged. `"cleaner"` widens `QAReviewStage` and
  reaches only the archive-prefix and filename maps in `src/qa-review.ts`; resume replay
  is untouched.
- **P-04** — `src/candidate-gate-phase.ts` is unedited and absent from the file scope;
  `runCandidateGatePhase` still takes `declarations` plus the optional pass-through
  `cache`, and gate evidence stays at version 4.
- **B-06 gate order and bundle** — the round's declarations are, in order,
  `clean:*`, `scope`, `feedback-integrity`, `tests:skipped`, `suppressions`, then
  `...regressionDeclarations`, and the regression bundle at `src/orchestrator.ts:6204-6211`
  does include `acceptance:behaviors`.
- **B-12** — `prompts/cleaner.md` carries all eight declared placeholders, both
  anti-gaming sections and the no-redefinition line, and correctly omits
  `{{TEST_COMMAND}}` (ADR 0038).
- **Bounds** — the loop condition is `cleanerRoundsRemaining({ spent, limit }) > 0`,
  a comparison against the remainder rather than an incremented counter (ADR 0050/0041),
  and each of the four exit paths has one reset target and one recorded outcome
  (ADR 0051).

### Findings

`QA-01` — BLOCKING, OPEN, `SOURCE_CHANGE`, behavior B-06.

The full evidence, expected/observed and clear condition are in `qa-review.json`. In
short: `src/orchestrator.ts:6836-6847` is the only place in the tree that journals
`agent: "cleaner"`, and it emits `phase-started` only. Because
`RunJournal.observeStageDuration` (`src/run-journal.ts:133-169`) appends `stage-duration`
only when a `phase-ended` pairs with an open `phase-started` under
`stageInvocationKey({ghIssue, agent, round})`, the cleaner never yields a duration
sample and leaves its stage open. A probe against the real spawned exhaustion scenario
printed `PROBE cleaner events: ["phase-started","phase-started","phase-started"]` —
three rounds, three starts, zero ends. Two aggravating details: the payload's `round` is
the generator round, not `cleanerInput.round`, so up to three cleaner rounds collide on
one key and "last start wins" discards the rest; and no test observes cleaner journaling
at all, since `src/cleaner-stage.test.ts` stubs the dispatch seam and no `phase-ended` or
`stage-duration` assertion in `src/` mentions the cleaner. B-06's clause "so
`stage-duration` exists without new code" is therefore unsatisfied in behavior, and
unguarded in test.

Test honesty elsewhere in the slice is otherwise good: `src/cleaner-stage.test.ts` uses
real git fixtures and real marker gates, asserts the exact `gateIds` order, the sweep
commit message, HEAD after each exit path, and `gateRuns === 0` on the
malformed-escalation path — all assertions that would fail if the behavior broke. Two
smaller gaps are noted for context and are folded into `QA-01`'s clear condition rather
than filed separately: the `phase-started`/`phase-ended` journaling sits behind the
stubbed `ctx.dispatch` seam and so is unobserved, and the `ctx.signal?.aborted`
cancellation branch is untested.

## Pass 2

NOT RUN — Pass 1 is not clean.

## Resolved findings

None. No prior findings were routed to this review.
