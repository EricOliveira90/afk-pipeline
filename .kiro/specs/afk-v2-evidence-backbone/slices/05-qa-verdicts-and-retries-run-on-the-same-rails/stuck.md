# Stuck

## What the evaluator wants

The latest report clears every finding from QA rounds 1 and 2. These three
findings remain unresolved:

> ### Finding 1 — The required full suite was terminated by the command runner
> **Severity:** Blocker
> **Pass:** 1
> **Evidence:** `pnpm run test` returned exit 124 after 604.067 seconds.
> `.vitest-reports/fast.json`, `orchestrator.json`, and `wave.json` record exit 0
> after 90.040, 332.632, and 173.110 seconds. The runner then killed
> `resume-integration` after 7.317 seconds. `scripts/timed-suite.mjs` maps a
> signal-terminated child with null status to exit 1, explaining that report.
> **What the contract expected:** The test plan requires verdict-driving fixtures
> to verify canonical artifact outcomes, and the assigned sanity pass requires
> `pnpm run test` to complete.
> **What I observed:** The external command wrapper enforced 600 seconds of total
> runtime rather than 600 seconds of output inactivity. It interrupted the suite
> after about 604 seconds, so QA and clean suites were never attempted and the
> full sanity result is unavailable.

> ### Finding 2 — Ordinary resumes can exceed the three-round implementation cap
> **Severity:** Major
> **Pass:** 1
> **Evidence:** `src/orchestrator.ts:2567` restores `firstRound` from archived
> evidence, but `src/orchestrator.ts:2569-2576` grants every non-STUCK resume
> three additional implementation attempts. After a round-1 implementation
> failure, an ordinary resume can therefore execute rounds 2, 3, and 4. The
> ordinary-resume fixture passes in round 2 and has no exhaustion assertion.
> **What the contract expected:** "Changes to ... the three implementation-round
> cap ... [are out-of-scope]." ADR 0014 says implementation failures advance the
> generator round, "which remains capped at three."
> **What I observed:** Restored round numbering is global, but the attempt limit
> is reset per ordinary resumed invocation. The fourth implementation round is
> reachable, changing preserved retry accounting.

> ### Finding 3 — Evidence archive failures do not prevent PASS
> **Severity:** Major
> **Pass:** 1
> **Evidence:** `src/orchestrator.ts:2212-2235` catches a raw canonical archive
> failure and continues. `src/orchestrator.ts:2307-2325` likewise catches a
> lifecycle-record archive failure and continues. The subsequent canonical
> verdict can still return PASS and merge while `artifactReferences` names a
> missing or stale archive.
> **What the contract expected:** "Preserve raw canonical attempts and
> code-derived lifecycle records at the exact paths below" and "Every attempt
> preserves the specified evidence."
> **What I observed:** Required archive writes are best-effort warnings. A
> collision, permission error, or other local write failure can leave required
> raw or lifecycle evidence absent without preventing the slice from passing.

## What you tried

- The initial implementation added strict canonical QA/UAT parsing, finding
  lifecycle transitions, raw/validation/record archives, canonical stage
  control, independent QA and UAT histories, unresolved-only retry routing, and
  fixtures for deterministic QA and shared-preview UAT.
- After QA round 1, the canonical prompt example was changed to a schema-valid
  `PASS/NONE` example and parsed in its prompt test. STUCK resume began restoring
  code-derived stage histories, unresolved findings, and the next evidence
  round instead of rebuilding state from Markdown reports.
- After QA round 2, the same restoration and unresolved routing were applied to
  ordinary preserved-tree resumes. Valid canonical output left behind by a
  failed evaluator invocation began creating a lifecycle record and carrying
  its transition into the infrastructure retry. STUCK resume was limited to its
  documented single extra implementation attempt.
- The first two QA runs completed install, typecheck, and the full suite
  successfully. The latest run completed install and typecheck; its `fast`,
  `orchestrator`, and `wave` suites passed before the external 600-second limit
  terminated the full-suite command.

## Your best guess at the blocker

### Implementation ambiguity

There is little remaining contract ambiguity. Ordinary resume should restore
the global round and run only the attempts remaining through round 3; the
current code restores the round but resets a three-attempt invocation-local
budget. Required raw and lifecycle archive writes must also fail closed instead
of being logged as warnings. Both are localized implementation defects in
`runSliceExecute` and `runQAStage`, not unresolved product decisions.

### Test-framework gaps

The ordinary-resume fixture passes on round 2, so it never proves that a resumed
failure stops after round 3. There is also no failure-injection assertion that
forces raw or lifecycle archive creation to throw and verifies that PASS and
merge are refused. Those missing negative paths allowed both defects to survive
otherwise broad integration coverage.

### Dependencies

No package, service, schema, or sibling-slice dependency is blocking the fixes.
The remaining implementation work is local to retry accounting, archive error
propagation, and their tests.

### Infrastructure evidence

The latest full-suite result is unavailable because the external wrapper killed
the command at 604.067 seconds. The already-completed suites consumed about
596 seconds before `resume-integration` had meaningfully run, while earlier QA
runs completed the full suite in 994.8 and 728.3 seconds. This supports a
wrapper-timeout diagnosis rather than a test failure. A verdict-driving rerun
needs a total wall-clock allowance above the measured full-suite duration; the
partial latest run does not clear the sanity requirement.
