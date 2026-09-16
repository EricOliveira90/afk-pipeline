# Stuck diagnosis

## Reason

AFK exhausted deterministic base-gate repair capacity with failed gate(s) tests. Structured intervention: .kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/intervention.json. Inspect QA-01, tests on preserved candidate tree cd949ba8a7013c2493e2c925a78515bb7193683f, make one targeted implementation repair that keeps resolved behavior intact, then resume the slice.

## Finding lifecycle

### RESOLVED

- [QA-01] BLOCKING RESOLVED
  - Stage: deterministic
  - Summary: A literal NUL byte in src/mutation-report.test.ts made git classify the slice's largest new test file as binary, so it could never be diff-reviewed or grepped.
  - Clear condition: `git diff main...HEAD -- src/mutation-report.test.ts` prints a textual line-by-line diff (not `Binary files ... differ`), and `git grep -n 'not.toThrow' -- src/mutation-report.test.ts` prints the matching line rather than `Binary file ... matches`, with `npx vitest run src/mutation-report.test.ts` still exiting 0.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`
- [QA-02] ADVISORY RESOLVED
  - Stage: deterministic
  - Summary: The gate-id half of B-11's and B-16's observable — that the gate ids and gate results a run reports are identical with the flag set and with it absent — was asserted nowhere.
  - Clear condition: A test in src/ship-gate.test.ts runs the gate twice — once with `mutationReport` declared, once without — and asserts the gate ids/gate results it reports are equal across the two runs (for example by comparing the gate-bearing entries of the teed `events.jsonl`), and that no gate id names the mutation step.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`
- [QA-03] ADVISORY RESOLVED
  - Stage: deterministic
  - Summary: B-12's "the rejoin origin is the post-fork instant at which both guardian results are in hand" was not distinguished by any assertion — the fake clock returned the same origin whether the capture sat before or after the guardian fork.
  - Clear condition: A test in src/ship-gate.test.ts drives the gate with a clock whose readings are distinguishable across spawn / guardian completion / rejoin and asserts the bounded wait's origin is the post-fork reading, failing if the capture is moved above the guardian mode fork.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`
- [QA-04] ADVISORY RESOLVED
  - Stage: deterministic
  - Summary: The ARCHITECTURE.md line-cap assertion filtered with an always-true predicate, so the filter was dead code that read as if it excluded blank lines.
  - Clear condition: src/mutation-report.test.ts:232 no longer contains an always-true filter predicate, and the ARCHITECTURE.md line-cap assertion still passes.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`

### OPEN

- [QA-05] ADVISORY OPEN
  - Stage: deterministic
  - Summary: The bound-reached rejoin exit terminates the step but never sets the abandonment flag, so unlike every guardian-rejection exit it leaves the pre-spawn window open and a command can spawn after the quiesce and after the gate has returned.
  - Clear condition: The bound-reached exit sets the same abandonment flag before it invokes `terminate` (as `abandonMutationStep` already does), and a test in src/ship-gate.test.ts holding the step ahead of the `mutationRun` seam with `mutationNow` past the rejoin origin plus the bound asserts `mutationRun` invocation count is `0` after the gate returns and the held scope is released.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`
- [QA-06] ADVISORY OPEN
  - Stage: deterministic
  - Summary: `formatMutationReportLines` substitutes a concrete `COMMAND_FAILED` when a `MUTATION_NOT_RUN` report carries no reason, so the run summary and the PR body can state a not-run reason the run never observed.
  - Clear condition: `formatMutationReportLines` renders an explicitly unknown reason (rather than a substituted `COMMAND_FAILED`) when a `MUTATION_NOT_RUN` report carries none, asserted by a case in src/mutation-report.test.ts that passes a reasonless `MUTATION_NOT_RUN` report and expects the rendered line not to name any specific `MutationNotRunReason`.
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`

## Scope escalations

(none)

## Round evidence

- Round 2 attempt 1 (deterministic): FAIL / IMPLEMENTATION
  - Lifecycle record: `qa-review-r2-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r2-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r2-a1.md`
- Round 3 attempt 1 (deterministic): PASS / NONE
  - Lifecycle record: `qa-review-r3-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/mutation-survivor-report-claude-code/slice-01/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/qa-report-r3-a1.md`
- Additional artifact: `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/intervention.json`
- Additional artifact: `C:/Code/afk-run-prd11/.afk/logs/mutation-survivor-report-claude-code/run-20260915-071026/gates/s01/attempt-d7b0096e0656.json`
- Additional artifact: `C:/Code/afk-run-prd11/.afk/logs/mutation-survivor-report-claude-code/run-20260915-071026/gates/s01/attempt-f92c5fd4e7c6.json`
- Additional artifact: `C:/Code/afk-run-prd11/.afk/logs/mutation-survivor-report-claude-code/run-20260915-071026/gates/s01/gate-logs/d7b0096e0656-04-tests.log`
- Additional artifact: `C:/Code/afk-run-prd11/.afk/logs/mutation-survivor-report-claude-code/run-20260915-071026/gates/s01/gate-logs/f92c5fd4e7c6-03-acceptance_behaviors.log`

## Commit evidence

```text
commit ddc7755837409611462b7c39b828f83fceaac634
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 09:06:20 2026 -0300

    docs(#303): record the round-3 gate-id, origin and file-encoding learnings

 .../slices/01-mutation-report-step/handoff.md      | 29 ++++++++++++++++++++++
 1 file changed, 29 insertions(+)

commit a9581b7c3bc4a85a6f24e1afa40fb8cc87506776
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 09:04:57 2026 -0300

    test(#303): make the mutation test file text and pin the gate-id and origin claims
    
    QA-01: a raw NUL byte in `src/mutation-report.test.ts` made git classify the
    slice's largest new test file as binary, so it could never be diff-reviewed,
    grepped or blamed. The byte is now a `\u0000` escape — the identical runtime
    string, so the parser's never-throws case is unchanged.
    
    QA-02 (B-11, B-16): a new case runs the real gate twice — once with
    `mutationReport` declared, once without — and compares the gate-bearing
    entries of the teed `events.jsonl` set-for-set, asserting no gate id names the
    mutation step. Promoting the step to a declared gate now fails a test rather
    than passing silently (ADR 0063).
    
    QA-03 (B-12): a new case drives the gate with a clock the guardians move, so
    spawn and rejoin are distinguishable readings, and asserts the bounded wait's
    origin is the rejoin reading. Each guardian burns a whole bound, so an origin
    captured above the guardian mode fork leaves a negative window and reports
    BOUND_REACHED instead of MUTATION_REPORTED.
    
    QA-04 (B-08): the ARCHITECTURE.md line-cap assertion's `|| true` predicate is
    gone; it now counts lines the way `wc -l` does, dropping only a trailing
    newline's empty tail element.

 src/mutation-report.test.ts | Bin 28258 -> 28424 bytes
 src/ship-gate.test.ts       | 145 ++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 145 insertions(+)

commit 903e36f24f49685f34c22c7e9e2401ba04aef1a5
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:38:16 2026 -0300

    test(#303): name the draft PR body's mutation section as B-15
    
    The `acceptance:behaviors` gate reads behavior tags out of test names, and
    B-15's assertions lived inside B-11's, B-12's and B-16's tests behind
    `// B-15:` comments — proved to a reader, invisible to the gate.
    
    Give it its own block: it reads a hand-written `events.jsonl` back through
    `readMutationStepOutcome` and asserts the plan body's list block equals
    `formatMutationReportLines`'s output character for character, at both
    `buildPrCreationPlan` sites (the ordinary one and the guardian cap exit's),
    with `open` true in all three outcome cases. A strict equality rather than a
    `toContain` sweep, so a second divergent rendering of what survived cannot
    pass.
    
    No production code changes.

 .../slices/01-mutation-report-step/handoff.md      |  18 ++-
 src/ship-gate.test.ts                              | 126 +++++++++++++++++++++
 2 files changed, 143 insertions(+), 1 deletion(-)

commit 86a4bd51dc9a23e6d39d91c94b5142d86e4af664
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:27:41 2026 -0300

    docs(#303): add the slice handoff for the report-only mutation step
    
    New migration files: 0

 .../slices/01-mutation-report-step/handoff.md      | 77 ++++++++++++++++++++++
 1 file changed, 77 insertions(+)

commit f8632cb4c25708aef3008e3e47c26dd509650b10
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:25:15 2026 -0300

    feat(#303): run the report-only mutation step at the ship gate
    
    Behaviors B-11/B-12/B-15/B-16 and P-01/P-03: the step starts on the review
    worktree before the first guardian review resolves, the gate holds until it
    has been awaited within the bound, and the outcome reaches the draft PR body
    without moving the verdict, the PR decision or the exit code. A guardian
    rejection abandons the step, terminates it through quiesceWorktree, publishes
    nothing and rethrows the guardian's own reason in both lane modes.
    
    New migration files: 0

 src/ship-gate.test.ts | 496 ++++++++++++++++++++++++++++++++++++++++++++++++++
 src/ship-gate.ts      | 210 +++++++++++++++++++--
 2 files changed, 689 insertions(+), 17 deletions(-)

commit 98295fadc5b1a0b5f13847fb188e983a89148c6d
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:25:13 2026 -0300

    feat(#303): report the survivor list in run-summary.md
    
    Behavior B-14: one derivation over this run's events.jsonl renders the
    mutation section, so run-summary.md, the event stream and the draft PR body
    cannot disagree; an empty survivor list is stated as an answer and a step
    that never ran names its reason. A run without the declaration keeps the
    summary byte-for-byte as it was.
    
    New migration files: 0

 src/logger.test.ts | 117 +++++++++++++++++++++++++++++++++++++++++++++++++++++
 src/logger.ts      |  74 ++++++++++++++++++++++++++++++++-
 2 files changed, 190 insertions(+), 1 deletion(-)

commit 618ca71a5e2dee84847cbf7b6b41374e7631b3aa
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:25:00 2026 -0300

    feat(#303): persist the mutation step outcome at run state version 7
    
    Behaviors B-13/P-05: an additive mutation-step run event keeps the events
    schema at 1, while the state schema moves 6 -> 7 for the persisted record;
    a broken record degrades to undefined rather than failing a load, and states
    written at 3..6 still load with the step absent and their bytes untouched.
    
    New migration files: 0

 src/eval-boundary.test.ts |   6 +-
 src/run-events.ts         |  30 ++++++++++
 src/run-state.test.ts     | 138 ++++++++++++++++++++++++++++++++++++++++++++--
 src/run-state.ts          | 129 +++++++++++++++++++++++++++++++++++++++----
 4 files changed, 285 insertions(+), 18 deletions(-)

commit 21cf6f583e751e578f79b5e83d8a47224bf8baf2
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:24:58 2026 -0300

    feat(#303): parse, classify, scope and bound the mutation step
    
    Behaviors B-08..B-12: a mutation-testing-elements report parses into a
    survivor list or a named unreadable reason and never throws; the classifier
    answers MUTATION_REPORTED or MUTATION_NOT_RUN with a reason; the scope reuses
    the one change-summary builder and filters to eligible sources; the step runs
    the declared command once with no await between the abandonment check and the
    spawn; and a flat 30-minute MUTATION_STEP_BOUND_MS ends it through the one
    quiesceWorktree path.
    
    New migration files: 0

 ARCHITECTURE.md             |   2 +-
 src/mutation-report.test.ts | Bin 0 -> 28258 bytes
 src/mutation-report.ts      | 521 ++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 522 insertions(+), 1 deletion(-)

commit 57c628ece41f476de64ab391a3e4eebd382b3388
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:24:45 2026 -0300

    feat(#303): refuse an undeclared mutation report before the run starts
    
    Behaviors B-06/B-07: refuseUndeclaredMutationReport is a configuration
    refusal naming the flag, the manifest member and afk.json, raised after the
    scope assertion and before any run state is written or any wave runs, so a
    misconfigured launch costs nothing.
    
    New migration files: 0

 src/orchestrator.ts   | 23 +++++++++++++++
 src/preflight.test.ts | 81 +++++++++++++++++++++++++++++++++++++++++++++++++++
 src/preflight.ts      | 36 +++++++++++++++++++++++
 3 files changed, 140 insertions(+)

commit 7efee349a0561327c8397eaa9d08917bb27e5878
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:24:43 2026 -0300

    feat(#303): declare the mutation command and report path in afk.json
    
    Behaviors B-01..B-05: --mutation-report is an exact valueless token, the
    manifest member is normalized (trimmed command, repo-relative POSIX report
    path), rejected with a named reason when malformed, absent by default, and
    preserved across prefix trimming.
    
    New migration files: 0

 src/afk-manifest.test.ts | 181 +++++++++++++++++++++++++++++++++++++++++++++++
 src/afk-manifest.ts      |  98 +++++++++++++++++++++++++
 src/cli-options.test.ts  |  30 ++++++++
 src/cli-options.ts       |  12 ++++
 4 files changed, 321 insertions(+)

commit 8303aae999f662592d67d9a4a5bda9c8a10ddcd5
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Tue Sep 15 08:24:17 2026 -0300

    docs(#303): record ADR 0071 for the report-only mutation survivor step
    
    Behavior B-17: the ADR states the decision, the decisions-file schema, the
    trust ladder and the five refusals verbatim, so nothing downstream has to
    infer that the step reports and never gates (ADR 0063).
    
    Also commits the slice negotiation record (contract, acceptance manifest,
    response and review) that this candidate implements.
    
    New migration files: 0

 .../acceptance-manifest.json                       | 320 +++++++++++
 .../slices/01-mutation-report-step/context.md      |  56 ++
 .../01-mutation-report-step/contract-response.json |  16 +
 .../01-mutation-report-step/contract-review.json   |  43 ++
 .../slices/01-mutation-report-step/contract.md     | 630 +++++++++++++++++++++
 .../slices/01-mutation-report-step/feedback-r1.md  |  99 ++++
 .../slices/01-mutation-report-step/feedback-r2.md  |  81 +++
 .../adr/0071-report-only-mutation-survivor-step.md | 111 ++++
 8 files changed, 1356 insertions(+)
```
