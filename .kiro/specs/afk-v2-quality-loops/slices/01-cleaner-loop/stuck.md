# Stuck diagnosis

## Reason

AFK exhausted the bounded deterministic-qa repair capacity with unresolved blocker(s) QA-01. Structured intervention: .kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/intervention.json. Inspect QA-01 on preserved candidate tree 82359f25087f8976fdb9b0577fdca1d8ad31b373, make one targeted implementation repair that keeps resolved behavior intact, then resume the slice.

## Finding lifecycle

### RESOLVED

(none)

### OPEN

- [QA-01] BLOCKING OPEN
  - Stage: deterministic
  - Summary: The cleaner dispatch journals phase-started but never phase-ended, so no stage-duration sample is ever derived for agent "cleaner" and every round leaves a permanently open stage.
  - Clear condition: After a run in which the cleaner stage executes N rounds, the run journal contains, for agent "cleaner", N phase-started events and N matching phase-ended events that pair under distinct stageInvocationKeys (one per cleaner round, not per generator round), yielding N stage-duration events; RunJournal leaves no cleaner stage open at the end of the stage; and a test observing the journal of a spawned or dispatch-level cleaner run asserts those events and would fail if either the start, the end, or the per-round key distinction were removed.
  - Artifact references:
    - `.afk/artifacts/afk-v2-quality-loops-claude-code/slice-01/reviews/qa-review-r1-a1.json`
    - `.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/qa-report-r1-a1.md`

## Scope escalations

- Round 1 attempt 1
  - Finding IDs: `PRE-BUILD-SCOPE`
  - Paths: `src/acceptance-gate.test.ts`
  - Reason: Contract B-10 mandates `GATE_EVIDENCE_VERSION` 3 -> 4 in `src/gate-runner.ts` (contract.md:147-149, acceptance-manifest B-10 `then`), and `src/gate-runner.ts` is in the declared file scope. But `src/acceptance-gate.test.ts:329` asserts `expect(GATE_EVIDENCE_VERSION).toBe(3);` — an out-of-scope pin of exactly the constant the contract bumps, so the mandated bump cannot be made green inside the declared boundary. The needed edit is one line plus its explanatory comment: the `3` becomes `4` and the comment gains the #87 paragraph, in the same shape the file already carries for the #86 2 -> 3 bump. Nothing else in that suite changes: its other `version: 3` fixtures are acceptance *manifest* documents with their own version line, and every evidence document it builds stays readable because `SUPPORTED_GATE_EVIDENCE_VERSIONS` becomes [1,2,3,4]. This is a boundary drawn too narrow, not a decision the contract left open — the contract already reasoned about which sibling test files the bump touches (it explicitly cleared `src/qa-review.test.ts` for B-09 at contract.md:137-141) and missed this one. A repo-wide grep for `GATE_EVIDENCE_VERSION` finds no other out-of-scope pin, and greps for the remaining behaviors' surfaces (`RUN_STATE_VERSION` for B-14, the context-envelope role unions and prompt-directory enumerations for B-12, `package.json`'s `files` for B-15) find no further out-of-scope assertion, so this escalation names every path the slice needs. Requested revision: add `src/acceptance-gate.test.ts` to the file scope. Work already committed inside the boundary: 5b77dd1 (B-01, B-02, B-05) and 526260c (B-10, including `src/suppression-gate.ts` and its unit suite), both pushed.

## Round evidence

- Round 1 attempt 1 (deterministic): FAIL / IMPLEMENTATION
  - Lifecycle record: `qa-review-r1-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/afk-v2-quality-loops-claude-code/slice-01/reviews/qa-review-r1-a1.json`
    - `.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/qa-report-r1-a1.md`
- Additional artifact: `.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/intervention.json`

## Commit evidence

```text
commit a2ff5dcfd2e36e8cea55e877c394a1cfa5e748b2
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 05:21:24 2026 -0300

    test(#87): pin the last two stale run-state version literals
    
    B-14: `RUN_STATE_VERSION` is 6 (`src/run-state.ts:67`), but two pins against
    it outside the schema's own files still read 5 —
    `expect(RUN_STATE_VERSION).toBe(5)` at `src/eval-boundary.test.ts:127`, which
    fails `pnpm test:fast`, and `expect(bumped.version).toBe(5)` at
    `src/qa-orchestration-gates.test.ts:1016`, which fails
    `pnpm run test:heavy:qa`. Each moves 5 -> 6 and nothing else in either file
    changes: no assertion, fixture or `describe` placement moves, so the split
    `qa-orchestration` suites stay balanced by measured block time. The bump is
    not reverted — B-14's persisted stage record is what it exists for and P-01
    records that it is unconditional.
    
    Also drops the superseded `escalation.md`: the focused scope revision it
    requested was accepted and re-locked, so both files are now in scope.

 .kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/escalation.md | 1 -
 src/eval-boundary.test.ts                                             | 2 +-
 src/qa-orchestration-gates.test.ts                                    | 2 +-
 3 files changed, 2 insertions(+), 3 deletions(-)

commit b817ef27a966d295d4cb22032da012c86d7e7669
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:58:14 2026 -0300

    test(#87): pin the sixth stale run-state version literal
    
    `qualityStages` bumped RUN_STATE_VERSION to 6; this assertion still
    expected 5 (#87 B-14).

 src/qa-orchestration.test.ts | 7 ++++---
 1 file changed, 4 insertions(+), 3 deletions(-)

commit e16d6de58e7eb7db894d1c10cd7bd708eaf9e112
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:46:24 2026 -0300

    test(#87): spawn the escalation-repair and exhaustion runs end to end
    
    Two orchestrator-level scenarios for the cleaner stage's position, its
    round-gate bundle, its archives, the generator return after an escalation
    and the stuck exit after exhaustion (#87 B-03, B-06, B-07, B-08, B-09,
    B-13, B-14).
    
    Both cut a real slice worktree outside the fixture repository: round 0
    gates the accepted tree in place, and a gate checkout restores with
    `git clean -ffdx`, which with `worktreeDir === repoRoot` deletes the
    run's own ignored `.afk/` mid-gate.

 src/qa-orchestration.test.ts | 622 ++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 621 insertions(+), 1 deletion(-)

commit 4174ae9afb1f26e9645c11d778840ade87dbc55e
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:19:28 2026 -0300

    test(#87): cover the retry bound, the next round tree and the escalation reference

 src/cleaner-stage.test.ts | 200 +++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 198 insertions(+), 2 deletions(-)

commit c012fa43af9d09e52e7b205c13f03a5ed35ce9b4
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:15:11 2026 -0300

    test(#87): cover the cleaner role contract and its rendered prompt

 src/context-envelope.test.ts | 139 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 139 insertions(+)

commit 4a64b905b18d7af34cab66e6a35fa317209b2925
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:10:03 2026 -0300

    test(#87): qualify B-10 and cover the evidence-version and cache preservations
    
    P-06: versions 1-3 still parse after the bump to 4, and a version-3
    document naming suppressions is refused - a reader handed one would report a
    clean findings set for a gate that named offenders.
    
    P-07: the in-process suppressions gate executes on both runs against an
    identical tree with the cache enabled and records no entry, so the
    command-derived cache key is unchanged.
    
    B-10: the suppressions gate's own tags are issue-qualified, and its
    independence from gatePolicy.riskClasses is asserted directly - the risk
    class is waiver vocabulary, not a switch that decides whether it runs.

 src/gate-runner.test.ts      | 105 ++++++++++++++++++++++++++++++++++++++++++-
 src/suppression-gate.test.ts |  59 +++++++++++++++++++-----
 2 files changed, 152 insertions(+), 12 deletions(-)

commit 12ac4b24356191518c1da576af1ae3146e840628
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:06:29 2026 -0300

    test(#87): cover artifactDirPolicy and what it left alone
    
    B-11: under "declared-only" a post-approval round's rewritten contract.md and
    feedback-r1.md are out-of-scope paths, while cleaner-escalation.json, the
    declared sources and an additionalWriteScope match stay in scope; the
    widening is the declared glob alone, with no heuristic deriving a path, and
    the migration exemption and unclassifiable-path rule are untouched.
    
    P-05/P-10: the absent argument still exempts the artifact directory by
    prefix, the unwaivable orchestrator-owned refusal keeps its exact condition
    under both policies, the candidate source classifies the same paths as
    before, and a source scan over the in-scope files finds no empty-string
    sliceArtifactDir assignment - a blank directory disables the carve-out.

 src/escalation.test.ts | 142 +++++++++++++++++++++++++++++++++++++++++++++++++
 src/scope-gate.test.ts | 136 ++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 278 insertions(+)

commit 26d96b1b8a4a9f3be7aa15f1fed89fddc326939a
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:03:47 2026 -0300

    test(#87): cover the cleaner archive naming and the QA-stage boundary
    
    B-09: the four-way prefix map and the filename map, with the three existing
    members answering as before; one stamped escalation and one stamped log per
    round for three rounds, each carrying its own bytes; nothing archived for a
    round that wrote neither; and a repeated stamp refusing (escalation) or
    spilling into the writing run subdirectory (log) rather than overwriting.
    
    P-09: QA_REVIEW_STAGES still holds exactly the three replayed stages and the
    cleaner prefix is outside the qa|uat|final set, so no resumed run looks for
    a cleaner attempt record that no cleaner round writes.

 src/artifacts.test.ts | 177 +++++++++++++++++++++++++++++++++++++++++++++++++-
 1 file changed, 176 insertions(+), 1 deletion(-)

commit dabc777a1b3bc4eef54c7d1c4dc1918338fed3bf
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 04:01:18 2026 -0300

    test(#87): cover the persisted quality stages and the seam preservations
    
    B-14: a version-5 file reads as "no stage ran" and is not rewritten, each
    round persists as it happens with its trees, gates and outcome, three
    recorded rounds leave a resume zero, and an escalation appends a fresh
    entry so a re-approved tree with an identical id starts at zero. Also
    repairs five assertions the 5 -> 6 bump in 1a9961a left pinned at 5; the
    literal now lives in one B-14 pin instead of five places.
    
    B-03/P-02/P-03: the cleaner stage id is named beside the writing stage id
    and not inside it, PostApprovalWritingStage stays synchronous with the noop
    as the shipped default, and reuse stays exact tree equality with no
    writing-stage predicate.

 src/final-evaluation.test.ts |  59 ++++++++++++
 src/run-state.test.ts        | 224 +++++++++++++++++++++++++++++++++++++++++--
 2 files changed, 274 insertions(+), 9 deletions(-)

commit 8d2c9665b45ed46a6856c926c1c73487318ef81c
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 03:56:44 2026 -0300

    test(#87): issue-qualify the B-01, B-02, B-05 and B-10 behavior tags
    
    The manifest requires each behavior to be named by an issue-qualified tag
    `[behavior:#87:<id>]`; a bare `[behavior:B-01]` does not count. Qualifies
    only this slice's blocks: `cleanerRoundsRemaining` in bounds, the clean
    member of `parseGatePolicy` and the changed-files token. The cost-block
    `[behavior:B-01]` above line 544 and bounds' `[behavior:B-10]` belong to
    other PRDs and keep their tags.
    
    Also extracts the gate-evidence version pin into its own B-10 test rather
    than leaving it inside an unrelated P-02 assertion.

 src/acceptance-gate.test.ts |  3 +++
 src/bounds.test.ts          | 12 ++++++------
 src/gate-policy.test.ts     | 34 +++++++++++++++++-----------------
 3 files changed, 26 insertions(+), 23 deletions(-)

commit 0386eef9d50c429e75f5219eed681ff8ee62740a
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 03:52:23 2026 -0300

    test(#87): unit-cover the cleaner stage; thread acceptedPairIntact
    
    The tier-1 harness the contract calls for: `runCleanerStage` against a real
    `makeRepo()` worktree, a stub cleaner, and `node -e` clean gates whose verdict
    is a file's presence. B-02, B-03, B-04, B-05, B-06, B-07, B-08, B-13, P-01,
    P-04 and P-08 all read off it, with no pipeline spawned.
    
    Writing it surfaced a defect: the round's `feedback-integrity` declaration
    passed a literal `acceptedPairIntact: false`, which that gate treats as "the
    accepted contract pair moved under the lock" — an unwaivable FAIL. Every
    cleaner round would have been reverted regardless of what the cleaner did, so
    no clean-up could ever be released. The orchestrator's proven verdict is
    threaded through `CleanerStageInput` instead, the way `src/merge-resolution.ts`
    threads it. The `scope` gate keeps its literal `false`: it answers whether the
    pair is exempt from the round's write scope, which it is not.
    
    The fixture layout is load-bearing and commented as such: `runGates` restores
    its checkpoint with `git clean -fdxx`, so gate evidence has to live outside the
    gated worktree and the slice artifact dir has to be tracked.

 src/cleaner-stage.test.ts | 828 ++++++++++++++++++++++++++++++++++++++++++++++
 src/cleaner-stage.ts      |  34 +-
 src/orchestrator.ts       |  10 +-
 3 files changed, 858 insertions(+), 14 deletions(-)

commit 1a9961a99bb361555978412dc49c035136b39a99
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 03:34:44 2026 -0300

    feat(#87): persist and archive cleaner rounds
    
    RUN_STATE_VERSION 5 -> 6 with `qualityStages` beside `finalEvaluations`: a list
    of entries per issue, written per round by recordQualityStageRound and stamped
    by recordQualityStageOutcome, with cleanerRoundsSpent as the reader that stops a
    resumed run from buying a fourth round (B-14). A list and not a record because
    an escalation sends the slice back through the generator and the next approval
    appends a fresh entry -- tree ids are content-addressed, so a single record
    keyed by tree would charge the escalating round to the re-approved candidate.
    
    The bump is unconditional: a run with no gatePolicy.clean persists version 6
    with no qualityStages member, which is what P-01 excludes from its
    byte-identical claim.
    
    QAReviewStage gains "cleaner" with its own qaArchivePrefix and qaReviewFilename
    branches, so a cleaner escalation is not filed under the final evaluator's
    prefix by the else -> "final" fallback, and archiveCleanerLog preserves the
    round log that carries the commit rationale (B-09). "cleaner" deliberately does
    not join QA_REVIEW_STAGES: the stage writes no QAReviewAttemptRecord and takes
    no part in resume precedence, and the docstring now says so.
    
    ARCHITECTURE.md records the module, the post-approval writing-stage seam and
    `suppressions` under GateDeclaration.

 ARCHITECTURE.md     |  23 +++-
 src/artifacts.ts    |  38 ++++++-
 src/orchestrator.ts | 111 ++++++++++++++++++++
 src/qa-review.ts    |  19 +++-
 src/run-state.ts    | 297 ++++++++++++++++++++++++++++++++++++++++++++++++++--
 5 files changed, 473 insertions(+), 15 deletions(-)

commit 07cb5e3b5a52edb1ea6329921a4c6a55c404b7bb
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 03:28:05 2026 -0300

    feat(#87): cleaner stage, its gates and the cleaner role
    
    The post-approval cleaner stage: round 0 gates the accepted tree with the
    project's declared clean gates, and up to MAX_CLEANER_ROUNDS bounded rounds of
    dispatch -> checkpoint -> gate follow when a required one is red (B-02, B-03,
    B-04, B-05's loop half, B-06, B-07, B-08, B-11, B-12).
    
    The loop continues on a comparison against cleanerRoundsRemaining rather than
    an incremented counter (ADR 0050), and each of its four exit paths has exactly
    one reset target and records exactly one outcome, so no discarded checkpoint is
    afterwards gated (ADR 0051). A valid BASELINE_IS_WRONG escalation resets to the
    accepted commit and returns the slice to the generator with the baseline
    citation invalidated; an exhausted stage finishes stuck naming every still-red
    gate and its log (ADR 0048).
    
    Persistence and archiving are optional context seams, left unset here: the
    stage runs and gates rounds, and simply persists nothing yet.

 prompts/cleaner.md          |  90 +++++
 src/acceptance-gate.test.ts |   9 +-
 src/cleaner-stage.ts        | 817 ++++++++++++++++++++++++++++++++++++++++++++
 src/context-envelope.ts     |  88 ++++-
 src/escalation.ts           |  47 +++
 src/final-evaluation.ts     |  28 ++
 src/orchestrator.ts         | 286 ++++++++++++++--
 src/run-events.ts           |   6 +-
 src/scope-gate.ts           |  32 +-
 9 files changed, 1376 insertions(+), 27 deletions(-)

commit 0db496613c1144c2a5c2fd157bee37c5f32a23ed
Merge: 5acf247 7950bcc
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sun Sep 13 02:44:08 2026 -0300

    Merge branch 'feat-claude-code/afk-v2-quality-loops' into afk-claude-code/afk-v2-quality-loops-slice-01-cleaner-loop

commit 5acf247cea9d4a6335923f1a2daa6c90824baab2
Merge: 48dec26 0b8250b
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sat Sep 12 18:53:29 2026 -0300

    Merge branch 'feat-claude-code/afk-v2-quality-loops' into afk-claude-code/afk-v2-quality-loops-slice-01-cleaner-loop

commit 48dec266d68d23ebb6a522a42e28bcad929fa7b1
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sat Sep 12 18:00:35 2026 -0300

    chore(#87): escalate the GATE_EVIDENCE_VERSION pin outside the file scope
    
    B-10's mandated 3 -> 4 bump falsifies
    `src/acceptance-gate.test.ts:329`, which is not in the declared file
    scope. PRE-BUILD-SCOPE: no finding was cited.

 .kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/escalation.md | 1 +
 1 file changed, 1 insertion(+)

commit 526260ca8f9632cebc3569eab8e0f0928e5b60ca
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sat Sep 12 17:59:23 2026 -0300

    feat(#87): the suppressions gate and gate evidence version 4
    
    B-10: a new in-process `suppressions` gate compares each detector's
    patterns over the round's input and output trees and fails only on an
    increase, reporting exact { path, line, detectorId } triples rather than a
    count (ADR 0048). A changed file no detector glob covers is not a failure:
    unlike `tests:skipped` it does not fail closed, because a file outside the
    detectors' globs cannot hold a pragma the toolchain honours.
    
    GATE_EVIDENCE_VERSION goes 3 -> 4 in the same commit as the
    GateFindings.suppressions field it exists for; readers still accept 1-3 and
    refuse a suppressions field below 4. GateRiskClass gains "suppression" as
    waiver vocabulary only — the gate runs whenever the cleaner stage runs and
    never consults gatePolicy.riskClasses to decide that.

 src/gate-policy.test.ts      |  13 ++-
 src/gate-policy.ts           |  15 ++-
 src/gate-runner.test.ts      | 101 ++++++++++++++++++--
 src/gate-runner.ts           |  52 +++++++++-
 src/suppression-gate.test.ts | 216 +++++++++++++++++++++++++++++++++++++++++
 src/suppression-gate.ts      | 222 +++++++++++++++++++++++++++++++++++++++++++
 6 files changed, 603 insertions(+), 16 deletions(-)

commit 5b77dd1a2aa96c3c2a1dba683a878a941f735a86
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Sat Sep 12 17:49:09 2026 -0300

    feat(#87): gatePolicy.clean parsing and the cleaner round bound
    
    B-01: `POLICY_KEYS` gains `clean`, parsed by `parseClean` on `parseCost`'s
    terms — every unknown sub-key fatal and named, every sub-member defaulted
    except `gates`, which has no default because a clean stage with no gate
    could never release a tree. A gate id that collides with the catalog is
    refused: evidence, caching and prerequisites are keyed by id.
    `expectedCostMs` defaults to `DEFAULT_CHEAP_THRESHOLD_MS` and is budgeting
    only (ADR 0063).
    
    B-02 (partial): `CHANGED_FILES_TOKEN` is exported so the expander in
    `src/cleaner-stage.ts` and the config reader share one spelling, as
    `{behaviorId}` already does.
    
    B-05: `MAX_CLEANER_ROUNDS` and `cleanerRoundsRemaining` copy
    `finalEvaluationAttemptsRemaining`, so continuation is a comparison against
    a clamped remainder rather than an incremented counter (ADR 0050/0041).

 src/bounds.test.ts      |  35 +++++
 src/bounds.ts           |  26 ++++
 src/gate-policy.test.ts | 227 ++++++++++++++++++++++++++++++
 src/gate-policy.ts      | 362 +++++++++++++++++++++++++++++++++++++++++++++++-
 4 files changed, 646 insertions(+), 4 deletions(-)
```
