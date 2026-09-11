# Stuck diagnosis

## Reason

AFK exhausted deterministic base-gate repair capacity with failed gate(s) tests. Structured intervention: .kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/intervention.json. Inspect tests on preserved candidate tree f0f1b223397f6af2c8d33355da5055d7bd58a033, make one targeted implementation repair that keeps resolved behavior intact, then resume the slice.

## Finding lifecycle

### RESOLVED

- [QA-01] ADVISORY RESOLVED
  - Stage: deterministic
  - Summary: `## Applied Waivers` repeated one authorization once per implementation round with no column to tell the rows apart.
  - Clear condition: The summary either de-duplicates on slice + risk class + path or carries the round the event already holds, with a logger test covering two `waiver-applied` events for one waiver in different rounds.
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r4-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r4-a1.md`
- [QA-02] ADVISORY RESOLVED
  - Stage: deterministic
  - Summary: The handoff attributed two shipped behaviors to functions and files that did not hold them.
  - Clear condition: `handoff.md` names `trimUnclaimedMigrationPrefixes` for B-02 and `src/logger.ts` for B-14.
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r2-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r2-a1.md`

### OPEN

(none)

## Scope escalations

- Round 2 attempt 1
  - Finding IDs: `PRE-BUILD-SCOPE`
  - Paths: `src/qa-orchestration.test.ts`
  - Reason: The five failures in the tests gate are all stale exact-list assertions in src/qa-orchestration.test.ts, which pins the post-QA phase's gate ids to exactly ["scope","tests:skipped","tests"] at lines 1075, 2287 and 2436. B-03 requires a new required in-process gate id feedback-integrity declared through GateDeclaration.run beside the scope and tests:skipped gates, and B-12 anchors the evidence read immediately after gateArtifacts.push(...postQaGates.artifacts), so the declared list must grow by one entry and every exact-equality assertion over it must be updated in lockstep. No in-scope fix exists: the contract mandates a new module and gate id and forbids folding the checks into src/scope-gate.ts or src/post-qa-gates.ts, and the assertions compare full arrays including length, so any correct implementation of B-03 fails them.

## Round evidence

- Round 1 attempt 1 (deterministic): PASS / NONE
  - Lifecycle record: `qa-review-r1-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r1-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r1-a1.md`
- Round 2 attempt 1 (deterministic): PASS / NONE
  - Lifecycle record: `qa-review-r2-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r2-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r2-a1.md`
- Round 3 attempt 1 (deterministic): PASS / NONE
  - Lifecycle record: `qa-review-r3-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r3-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r3-a1.md`
- Round 4 attempt 1 (deterministic): PASS / NONE
  - Lifecycle record: `qa-review-r4-a1-record.json`
  - Artifact references:
    - `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-07/reviews/qa-review-r4-a1.json`
    - `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/qa-report-r4-a1.md`
- Additional artifact: `.kiro/specs/afk-v2-acceptance-scope-gates/slices/07-feedback-integrity-and-gate-scope-revisions/intervention.json`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-000620/gates/s07/attempt-d8eaa36d9652.json`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-000620/gates/s07/attempt-ddd30f856962.json`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-000620/gates/s07/gate-logs/d8eaa36d9652-01-tests.log`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-000620/gates/s07/gate-logs/ddd30f856962-01-tests.log`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260911-134538/gates/s07/attempt-399094e44381.json`
- Additional artifact: `C:/Code/afk/.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260911-134538/gates/s07/gate-logs/399094e44381-03-tests.log`

## Commit evidence

```text
commit 5c99caf6c7d9ef3602eb3b9696c54d49d43d3b29
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Fri Sep 11 13:57:34 2026 -0300

    docs(#193): slice 07 handoff — QA-01 repair and the two stale-base failures

 .../acceptance-manifest.json                       | 264 +++++++++++++
 .../context.md                                     | 431 +++++++++++++++++++++
 .../contract-review.json                           |  61 +++
 .../contract.md                                    | 356 +++++++++++++++++
 .../feedback-r1.md                                 |  83 ++++
 .../feedback-r2.md                                 |  96 +++++
 .../handoff.md                                     | 143 +++++++
 .../intervention.json                              |  81 ++++
 .../qa-report-r1-a1.md                             | 193 +++++++++
 .../qa-report-r2-a1.md                             |  63 +++
 .../qa-report-r3-a1.md                             | 156 ++++++++
 .../qa-report.md                                   | 156 ++++++++
 .../qa-review.json                                 |  21 +
 .../stuck.md                                       | 289 ++++++++++++++
 14 files changed, 2393 insertions(+)

commit 82700654b4d441aaca8bce62941081e12436ec37
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Fri Sep 11 13:55:11 2026 -0300

    fix(#193): QA-01 one Applied Waivers row per authorization, carrying its round
    
    The post-QA gate phase re-runs on every implementation round, so the same
    launch authorization was journalled — and rendered — once per round, and the
    table had no column to tell the repeats apart. `## Applied Waivers` now keys on
    slice + risk class + path and keeps the first application, whose row carries the
    `round` the event already held. The event stream is untouched: `events.jsonl` is
    a journal of what each round did, the summary is the audit of what was
    authorized.

 src/logger.test.ts | 52 +++++++++++++++++++++++++++++++++++++++++++++++++++-
 src/logger.ts      | 24 +++++++++++++++++++-----
 2 files changed, 70 insertions(+), 6 deletions(-)

commit 882f7756fff35fd91bfd976cca14339a8715f65e
Merge: cbe9b1f fb4c4ac
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Thu Sep 10 13:12:54 2026 -0300

    Merge branch 'feat-claude-code/afk-v2-acceptance-scope-gates' into afk-claude-code/afk-v2-acceptance-scope-gates-slice-07-feedback-integrity-and-gate-scope-revisions

commit cbe9b1f09aa00a5469c9093b04e3399c2ccd1f4c
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Thu Sep 10 00:20:11 2026 -0300

    fix(#193): B-17/P-04 separate the parser-regression rubric from the next heading
    
    Both contract-evaluator prompts abutted `# Canonical review artifacts` against
    the last paragraph of `# Parser regression surface`, the only section boundary
    in either file without a blank line. It parses either way — the point of these
    files is that a human reads them.

 prompts/evaluator-contract-revision.md | 1 +
 prompts/evaluator-contract.md          | 1 +
 2 files changed, 2 insertions(+)

commit 17d22803b7b2ac4afe0f5909175a506e3ee14b75
Merge: c0cfa58 c76391c
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Thu Sep 10 00:06:23 2026 -0300

    Merge branch 'feat-claude-code/afk-v2-acceptance-scope-gates' into afk-claude-code/afk-v2-acceptance-scope-gates-slice-07-feedback-integrity-and-gate-scope-revisions

commit c0cfa586cb756f3d7fe8e5fa362f2978b397ae4b
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 23:22:21 2026 -0300

    feat(#193): B-10/B-12/P-02/P-03 — gate-evidenced revisions and waiver journalling end to end
    
    - B-10: a version 2 GATE-SCOPE escalation revises the locked file scope
      through the same focused-revision door as a cited-finding escalation.
    - P-02/P-03: a gate-evidenced escalation raised after an undeclared edit is
      refused like any other laundered scope, and a third escalation in one
      round still ends the round instead of looping.
    - B-12: the applied waiver is journalled once and persisted under the
      provider-suffixed run slug (saveAppliedWaivers was keyed by the bare PRD
      slug, so the record landed in a state file no reader opens).

 src/orchestrator.test.ts | 777 ++++++++++++++++++++++++++++++++---------------
 src/orchestrator.ts      |   5 +-
 src/run-state.ts         |   4 +-
 3 files changed, 537 insertions(+), 249 deletions(-)

commit 2653365ba4cfa185ac77bfb9fbade7f7a4592f3f
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:36:49 2026 -0300

    feat(#193): teach the gate-scope escalation identity and ADR 0060's parser rubric
    
    B-16: all three generator surfaces (prompts/generator.md,
    prompts/generator-repair.md, agents/generator.md) carry a byte-identical
    escalation block covering the cited-finding, PRE-BUILD-SCOPE and GATE-SCOPE
    identities, the never-mix rule across all three, and the human-decision rule.
    
    B-17/P-04: both contract-evaluation prompts gain an additive
    "# Parser regression surface" section binding positive and
    rejected-or-boundary regression evidence plus the fixture-backed harness
    surface, with inline tests still valid where they are the harness.

 agents/generator.md                    |  49 +++++---
 prompts/evaluator-contract-revision.md |  19 +++
 prompts/evaluator-contract.md          |  19 +++
 prompts/generator-repair.md            |  35 +++++-
 prompts/generator.md                   |  35 +++++-
 src/prompt-template.test.ts            | 216 ++++++++++++++++++++++++++++++++-
 6 files changed, 347 insertions(+), 26 deletions(-)

commit f264fd13e503699f13664abf9a75ed2bac2049f8
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:29:44 2026 -0300

    feat(#193): B-15/B-14/B-12 launch waivers reach the skip gate, run state and summary
    
    The tests:skipped gate now takes the launch manifest's protectedChangeWaivers
    through SkipGateInput and honors `skipped-test` entries by exact path, excluding
    them from the candidate scan, the base scan and the fail-closed uncovered-file
    check. The base side matters: excluding only the candidate would leave a base
    count the candidate can never match and fail the very file it was told to
    ignore. A waiver whose path exists on neither tree exempted nothing and is not
    recorded as applied.
    
    Authorization stays a launch input. The orchestrator reads it from
    config.manifest and never from the worktree, declares the feedback-integrity
    gate beside the skip gate with the acceptedPairIntact value its own pre-dispatch
    check produced, and immediately after gateArtifacts.push reads each written
    evidence artifact back through appliedWaiversFrom, emits one waiver-applied
    event per waiver, and persists them with saveAppliedWaivers — before the
    CANCELLED/ERROR/REPAIR branches, because an applied waiver is a fact about what
    ran whatever the phase decides.
    
    run-summary.md renders `## Applied Waivers` from those events alone, with all
    four fields and the exact path, and omits the section entirely when nothing was
    waived so an unwaived run stays byte-for-byte today's.

 src/logger.test.ts    |  59 ++++++++++++++++++++++
 src/logger.ts         |  32 +++++++++++-
 src/orchestrator.ts   |  70 ++++++++++++++++++++++++++
 src/run-events.ts     |  21 ++++++++
 src/skip-gate.test.ts | 137 +++++++++++++++++++++++++++++++++++++++++++++++++-
 src/skip-gate.ts      |  73 ++++++++++++++++++++++++---
 6 files changed, 383 insertions(+), 9 deletions(-)

commit b0815afbf54a090b301ad1ade3f5b428c2671e52
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:22:39 2026 -0300

    feat(#193): B-13 run state records applied protected-change waivers
    
    Run state goes version 3 -> 4 with an optional `appliedWaivers` record keyed
    by GH issue, holding D5's four fields, plus a `saveAppliedWaivers` writer
    modelled on `saveFiledFindings`: it re-reads state inside the lock and ignores
    an already-recorded riskClass + path pair, because two gates can each honor the
    same launch authorization and that is one human decision, not two.
    
    `adaptLoadedState` accepts versions 1-4 and always returns 4, leaving the new
    field absent for every earlier file — "nobody waived anything" and "this file
    predates waivers" are the same fact to a reader. A malformed record degrades to
    absent for the same reason `prefixesOf` does: an audit note must not wedge a
    re-run.
    
    `RunState.version` is a `3 | 4` union rather than the bare literal so raising
    the version stays additive for in-memory objects built against 3, and
    `writeRunState` now stamps CURRENT_RUN_STATE_VERSION on every write so a stale
    caller literal can never reach disk describing a file its bytes contradict.

 src/run-state.test.ts | 125 +++++++++++++++++++++++++++++++++++++++---
 src/run-state.ts      | 146 +++++++++++++++++++++++++++++++++++++++++++++++---
 2 files changed, 256 insertions(+), 15 deletions(-)

commit bee44c617e52213c42876a5c9a88d39761c5769e
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:16:19 2026 -0300

    feat(#193): keep a version 2 escalation readable in the STUCK diagnosis
    
    B-11: `archivedScopeEscalations` accepts both live schema versions instead of
    marking a version-2 record invalid, and `renderStuckDiagnosis` renders the
    cited `gateId` and `evidenceArtifactId` when the record carries them — a
    GATE-SCOPE revision justified by a gate a reader cannot see would be a
    widening with no evidence. A malformed version-2 record is still retained as
    invalid, so the diagnosis isolates it instead of losing the rest.
    
    The invalid-record line drops its "version 1" wording, which now names a
    schema this parser is no longer alone in accepting.

 src/artifacts.test.ts | 65 ++++++++++++++++++++++++++++++++++++++++++++++++++-
 src/artifacts.ts      | 17 ++++++++++++--
 2 files changed, 79 insertions(+), 3 deletions(-)

commit 5dc068cde411d81b369af5b043441c5f12eadd91
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:15:18 2026 -0300

    feat(#193): escalation schema 2 with a gate-evidenced revision identity
    
    B-09: `ScopeEscalation` accepts schema version 2, which admits an optional
    `gateEvidence: {gateId, evidenceArtifactId}`, and exports
    `GATE_SCOPE_FINDING_ID = "GATE-SCOPE"` beside `PRE_BUILD_SCOPE_FINDING_ID`.
    The version is read before the key check so `gateEvidence` is admitted at
    version 2 only and a version-1 document carrying it is refused as an unknown
    key. `gateEvidence` requires findingIds to be exactly ["GATE-SCOPE"],
    GATE-SCOPE requires gateEvidence, and neither reserved identity may mix with
    a cited finding ID or with the other. A version-2 document without
    gateEvidence is an ordinary cited-finding or PRE-BUILD-SCOPE escalation:
    version is a schema version, not a document kind.
    
    P-01: every version-1 refusal and normalization is unchanged. The one edited
    row in the refusal table is the wrong-version case, which moved from 2 to 3
    because 2 is now legal.

 src/escalation.test.ts | 155 ++++++++++++++++++++++++++++++++++++++++++++++++-
 src/escalation.ts      | 132 ++++++++++++++++++++++++++++++++++++-----
 2 files changed, 269 insertions(+), 18 deletions(-)

commit 958f260e0581c8e1460f9381e4a655046055860e
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:12:28 2026 -0300

    feat(#193): add the feedback-integrity deterministic gate
    
    B-03..B-08: a new required in-process gate (`feedback-integrity`, stage
    `deterministic`), modelled on the `scope` and `tests:skipped` gates, fails
    closed on three detections over the same candidate-against-featureRef
    comparison: a changed `gatePolicy.protectedPaths.gatePolicyPaths` entry, a
    deleted file matching `protectedPaths.testGlobs`, and an accepted contract
    pair the orchestrator already found mutated. A changed-set probe that cannot
    answer reports INFRASTRUCTURE rather than an empty violation list.
    
    Only a launch waiver exempts a detection, and the gate records the ones it
    applied in `findings.appliedWaivers`; a waiver the candidate worktree
    authored for itself exempts nothing, and a declared `fileScope` is never
    authorization. `gatePolicy.riskClasses` decides which rules are enforced and
    the omissions are stated in `detail`. The accepted-pair failure is
    deliberately unconditional: risk classes are a project declaration about its
    own files, while the accepted pair is the orchestrator lock.
    
    Also exports the pure `appliedWaiversFrom(evidence)` the orchestrator
    producing seam will read written evidence through (B-12).

 src/feedback-integrity-gate.test.ts | 363 ++++++++++++++++++++++++++++++++++++
 src/feedback-integrity-gate.ts      | 314 +++++++++++++++++++++++++++++++
 2 files changed, 677 insertions(+)

commit a989fab02eab6a4aa4ad7aaea2ae5abceab0874f
Author: Eric Oliveira <ericfaria@gmail.com>
Date:   Wed Sep 9 22:08:08 2026 -0300

    feat(#193): read protected-change waivers from the launch manifest
    
    B-01: `afk.json` gains `protectedChangeWaivers`, one record per human
    authorization (riskClass, path, author, reason). The launch manifest is the
    only place a waiver can live, because it is the one file a slice agent
    cannot write. Validation refuses an unknown risk class, a glob instead of an
    exact path, a blank field and a repeated riskClass+path pair; the path is
    normalized to forward slashes with no `./` prefix so the manifest and the
    gates compare the same bytes.
    
    B-02: the ship gate's `trimUnclaimedMigrationPrefixes` rewrite preserves
    every waiver, pinned on the bytes it writes to disk and not only on the
    object it returns.
    
    The member is optional on the type and always present on a parsed manifest:
    absence reads as "no waiver", which is also what a hand-built manifest
    predating this member means.

 src/afk-manifest.test.ts | 172 +++++++++++++++++++++++++++++++++++++++++++++++
 src/afk-manifest.ts      | 115 +++++++++++++++++++++++++++++++
 2 files changed, 287 insertions(+)
```
