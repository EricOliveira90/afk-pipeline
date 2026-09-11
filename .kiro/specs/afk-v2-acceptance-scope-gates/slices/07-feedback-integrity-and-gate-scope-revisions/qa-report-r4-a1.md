# QA Report

**Verdict:** PASS
**Failure class:** NONE

Round 4 deterministic candidate QA. One routed finding was outstanding
(`QA-01`, ADVISORY) and the candidate carries a repair for it; no new finding
was discovered.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands
- `pnpm install --frozen-lockfile` — PASS. `Done in 4.7s using pnpm v10.33.0`,
  exit 0; the `prepare` script's `tsc -p tsconfig.build.json` completed with no
  diagnostics.
- `pnpm run typecheck` — PASS, run here rather than skipped (`tsc --noEmit`,
  no output, exit 0). This agrees with the skip authorization for gate attempt
  `85bc3eed-0af5-47f6-bb02-be1f1c9fe252` on tree
  `75211411162058c8f6f7347ee8772c83c8ea5702`
  (`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260911-134538/gates/s07/attempt-85bc3eed0af5.json`).
- Probe (allowed in this disposable worktree): `pnpm vitest run
  src/logger.test.ts` — `Test Files 1 passed (1) / Tests 33 passed (33)`. Run
  to exercise the QA-01 repair directly, not as a substitute for the suite the
  orchestrator owns.

The full test suite was not run: the pre-QA list does not name it and the
orchestrator runs it on the authorized candidate tree after this stage.

### Boundary compliance
`git diff fb4c4ac..HEAD --stat` (merge base with
`feat-claude-code/afk-v2-acceptance-scope-gates`) changes 37 files. The 23
source and prompt files are exactly the contract's declared list — no source
file outside `acceptance-manifest.json`'s `fileScope` was touched. The
remaining 14 are pipeline-owned artifacts inside the slice's own spec directory
(contract, manifest, context, feedback, prior QA reports, handoff, stuck).
`migrationCount: 0` holds: no migration file appears in the diff. The declared
untouched modules — `src/gate-runner.ts`, `src/post-qa-gates.ts`,
`src/candidate-gate-phase.ts`, `src/base-gates.ts`, `src/gate-policy.ts`,
`src/acceptance-manifest.ts` — are absent from the diff. No scope amendment is
needed.

Note: the change-summary artifact named in the brief
(`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/change-summary.json`)
does not exist in this worktree; the boundary check was performed from git
directly against the merge base.

### Preservation
- P-06 — `src/logger.test.ts:356` still asserts
  `expect(md).not.toContain("## Applied Waivers")` for a run with no waiver
  event, and passes. The section-omission path was the one at risk from the
  QA-01 repair (it now keys off the de-duplicated row list, not the raw event
  list) and it is still bound by a test that would fail if the section leaked.
- B-14's original four-field assertion was updated in lockstep with the new
  `Round` column rather than dropped
  (`src/logger.test.ts:298-303`), so the four named fields are still pinned.
- Handoff gotcha probe: the earlier NUL-byte corruption of `src/logger.ts` is
  gone. A byte scan of `src/logger.ts` reports `0` NUL bytes, and a scan of
  every file in `src/` returns no file containing one.

### The two failures the handoff attributes to a stale base
The handoff states that `src/qa-orchestration.test.ts` (5 assertions pinning the
post-QA gate id list to exactly `["scope","tests:skipped","tests"]`, which
cannot hold once B-03 declares a fourth gate) and
`src/resume-integration.test.ts` (the 5 GB preflight floor) fail here only
because this branch is behind the feature branch. Both claims check out against
the feature branch, and neither file is in this slice's scope:

- `git show feat-claude-code/afk-v2-acceptance-scope-gates:src/qa-orchestration.test.ts`
  contains `declaresInOrder`, `expectDeclaresInOrder` and
  `expectSomeAttemptDeclaresInOrder`; the local copy contains none of them.
- `git show feat-claude-code/afk-v2-acceptance-scope-gates:vitest.config.ts`
  contains `AFK_MIN_FREE_DISK_GB: "0"`.

So the merge resolves both, and neither is a defect in the tree under review.
No finding, and no INFRASTRUCTURE classification — I did not run those suites,
so nothing here is an interrupted measurement.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The only production change since round 3 is `src/logger.ts` (+24/-6). It reads
like the file around it: a `Map` built in one forward pass, the comment above it
saying *why* one slice + risk class + path is one human decision rather than
restating the code, and the event stream deliberately left unchanged so
`events.jsonl` stays a per-round journal. The de-duplication key concatenates
`ghIssue`, `riskClass` and `path` with spaces; `riskClass` is drawn from the
fixed `GATE_RISK_CLASSES` set, so no ambiguous split is reachable.

Test honesty: the new case is not a tautology. It emits three real
`waiver-applied` events through `log.event`, then asserts both a row *count* of
2 and the exact bytes of each row with `toBe`. Dropping the de-duplication
would make the count assertion fail; dropping the `Round` column or keeping the
last application instead of the first would make the `toBe` assertions fail.

## Resolved findings
- `QA-01` (ADVISORY) — **RESOLVED.** `## Applied Waivers` now both
  de-duplicates on slice + risk class + path and carries the round of first
  application in a new column (`src/logger.ts:476-505`, commit 8270065), and
  `src/logger.test.ts:302-354` covers two `waiver-applied` events for one
  waiver in different rounds. `round` is a required `number` on the event
  variant (`src/run-events.ts:191`) emitted from the orchestrator's round
  variable (`src/orchestrator.ts:6058`), so the new column cannot render
  `undefined`. `pnpm vitest run src/logger.test.ts` — 33/33 pass.

## Findings
None newly discovered this round.
