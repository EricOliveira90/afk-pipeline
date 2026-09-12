# Slice Contract — Final evaluation and exact-tree reuse

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #96
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

After a candidate PASS, the orchestrator compares the final checkpoint's tree ID
against the `approved-baseline.json` record #91 already writes. Equal means
reuse: no final evaluator is dispatched, and the reuse is recorded in the
slice's own persisted final-evaluation record in `src/run-state.ts`, as a run
event in `src/run-events.ts`, and in the slice's `run-summary.md` section.
Different means one fresh
final-evaluation attempt: a new `final` review stage dispatches a new
`evaluator-final` role in a disposable worktree with a code-generated
baseline→final change summary partitioned per post-approval writing stage, and
that evaluator may return only `final-review.json` and `final-report.md`. A
preservation finding routes to the single post-approval writing stage with
restore as its only legal repair; a baseline-is-wrong finding invalidates this
slice's own persisted final-evaluation attempt records keyed to the rejected
candidate tree and returns to the generator loop. Final evaluation is
bounded to three attempts. The existing scope gate and merge mutex are used
as-is — this slice declares no new gate and adds no second mutex.

### In scope

- [behavior:B-01] A pure reuse decision (`decideFinalReuse`) compares the final
  checkpoint tree ID against the `treeId` on the slice's persisted
  `approved-baseline.json` record and returns `reuse` on exact string equality,
  `evaluate` otherwise, with no cosmetic-change exception (GH #96 AC1; prd.md
  D20 line 390). It lives in a new module `src/final-evaluation.ts` with one
  call site in `src/orchestrator.ts`, because `ARCHITECTURE.md`'s "Hubs — do not
  grow these" rule sends new orchestrator behavior into a new module.
- [behavior:B-02] A `reuse` decision dispatches zero final-evaluator
  invocations and records the reuse in three named stores, all inside this
  slice's declared file scope (GH #96 AC1; prd.md file-scope map lines 503-533
  assigns `src/run-events.ts` "reuse event", `src/run-state.ts` "reuse record",
  `src/logger.ts` "own `run-summary.md` section" to this slice). Decision
  recorded here, because `src/gate-runner.ts` owns `GateEvidence`
  (`src/gate-runner.ts:171-176`) and this contract declares that file
  unmodifiable and out of scope — the reuse fact is therefore *not* written into
  gate evidence:
  1. `src/run-state.ts` gains `finalEvaluations`, a `Record<string,
     PersistedFinalEvaluation>` keyed by GH issue beside the existing
     `approvedBaselines` (`src/run-state.ts:149`), whose record carries
     `decision: "reuse" | "evaluate"`, `finalTreeId`, `baselineTreeId`, the
     `baselineArtifactPath` it read, and per-attempt entries; the reuse fact is
     the field `decision: "reuse"`, read back through a new
     `finalEvaluationFor(state, ghIssue)` reader in the style of
     `approvedBaselineFor` (`src/run-state.ts:813`).
  2. `src/run-events.ts` gains an additive `type: "final-evaluation-reuse"`
     event carrying `ghIssue`, `sliceNumber`, `round`, `finalTreeId`, and
     `baselineTreeId`, admitted the same additive way `approved-baseline`
     was (`src/run-events.ts:223-239`), so `EVENTS_SCHEMA_VERSION` stays 1.
  3. `src/logger.ts` renders the slice's `run-summary.md` section from that
     record.
  This reuse marker is distinct from the D17 gate-cache `reused` flag on
  `GateResult` (`src/gate-runner.ts:161-162`), which means "a `PASS` replayed
  from the gate cache" — a different fact from "no final evaluator was
  dispatched". Neither marker is read as the other, and this slice adds no
  field to `GateEvidence`.
- [behavior:B-03] A post-approval writing stage runs between the candidate
  checkpoint and the merge. In production it writes nothing; it is a stub until
  PRD 5's cleaner/hardener roles exist. Decision recorded here: the stub is an
  internal, injectable no-op stage in `src/orchestrator.ts` named by a single
  stage id, not a new exported cross-module interface, because PRD 5 replaces it
  and prd.md's "Out of scope" (line 656) keeps post-approval writers off. A stub
  write that changes the tree makes B-01 return `evaluate` and forces a fresh
  final review (GH #96 AC2).
- [behavior:B-04] `src/change-summary.ts` gains a baseline→final variant binding
  `fromRef` to the approved baseline tree/commit and `toRef` to the final
  checkpoint, returning commits, files, and diff stats partitioned per
  post-approval writing stage. It reuses the existing two-ref builder and adds no
  second producer (GH #96 AC3; prd.md D11 line 272; `ARCHITECTURE.md` "Change
  summary" seam). The existing bare-tree guard keeps `commits` empty when either
  ref is a tree object. The partition is observable, not implied: the variant's
  own result type carries `byStage`, a stage-id-keyed record whose keys are
  exactly the post-approval writing stage ids that ran — with only B-03's stub
  stage present, exactly one key, equal to that stub's stage id constant — and
  whose per-stage `files` and diff stats sum to the summary totals. An
  unpartitioned flat summary therefore fails the assertion on a missing
  `byStage` key rather than passing vacuously. `ChangeSummary`'s `version: 1`
  shape is untouched (P-04); `byStage` lives on the baseline→final variant's
  result only.
- [behavior:B-05] A third `QAReviewStage` member for final evaluation is added in
  `src/qa-review.ts`, and `qaArchivePrefix` in `src/artifacts.ts` becomes a
  three-way map returning `final` for it, in the same change (GH #96 "Code
  anchors" recorded decision: extend both; a two-way map would silently archive
  final artifacts as `uat-review-*`).
- [behavior:B-06] A new `evaluator-final` context manifest entry on the existing
  `src/context-envelope.ts` schema declares `allowedWriteScope`
  `["slice/final-review.json", "slice/final-report.md"]` and an `inputOrder`
  leading with the change summary, and a new `prompts/evaluator-final.md`
  asks exactly the two questions preservation and gate-invisible drift (GH #96
  AC4; prd.md D9 line 244 — the final evaluator is a new role, new prompt, two
  own artifacts).
- [behavior:B-07] `QA_WINDOW_ARTIFACT_NAME` in `src/post-qa-gates.ts` is
  extended to admit `final-review.json` and `final-report.md` (with the
  attempt-stamped report form), so those two files are the only paths that copy
  back out of the final evaluator's disposable worktree and any other write is
  discarded and journaled as a reviewer-write violation (GH #96 AC4;
  `ARCHITECTURE.md` "Candidate review isolation" seam: "A new reviewer output
  extends that constant").
- [behavior:B-08] `final-review.json` is validated against explicit literal key
  arrays in the style of `QAReview`/`QAReviewAttemptRecord`, and carries a typed
  repair vocabulary. A preservation finding routes to the single post-approval
  writing stage and admits only the restore repair; no other repair is accepted
  for it (GH #96 AC5; ADR 0048 — findings name their remedy rather than being
  regexed out of prose).
- [behavior:B-09] A baseline-is-wrong finding invalidates the downstream evidence
  keyed to the rejected candidate tree and returns control to the generator loop,
  consuming a generator round and no final-evaluation attempt (GH #96 AC6; prd.md
  D19 line 383 — a return to the generator "never consumes an evaluator round and
  never dispatches an evaluator"). Decision recorded here, so the invalidation
  has one named store and one observable form: the store is B-02's
  `finalEvaluations[ghIssue]` record in `src/run-state.ts` — the only evidence
  store in this slice's file scope. Invalidation appends the rejected candidate
  tree ID to that record's `invalidatedCandidateTreeIds` and drops the record's
  `baselineTreeId`/`baselineArtifactPath` citation of it. A reader afterwards
  sees: every persisted final-evaluation attempt entry keyed to that tree ID
  reported as invalidated by `finalEvaluationFor`, and `decideFinalReuse`
  refusing to return `reuse` against an invalidated tree ID even on exact
  equality. Nothing in `src/gate-runner.ts` is edited and no `approved-baseline`
  artifact or `gateEvidenceArtifactIds` value is rewritten or deleted — the
  invalidation is an additive record beside them (P-03), and #91's writer stays
  the only party that mints a baseline.
- [behavior:B-10] Final evaluation is bounded to three attempts through a named
  export in `src/bounds.ts` (no such constant exists there today; D19 states the
  bound is tracked there, so this slice adds it), resumes through the existing
  per-stage `QAReviewStageResumeState` / `retryStage` machinery, and archives
  every attempt under `.afk/artifacts/<run-slug>/slice-<n>/` stamped with its
  attempt number (GH #96 AC7 and its recorded decision; prd.md D19; prd.md D10
  line 263 for the directory).
- [behavior:B-11] The final verdict is `PASS` only when every required gate is
  green, the candidate and final artifacts are keyed to their exact checkpoint
  tree IDs, canonical validation of `final-review.json` succeeds, and the scope
  gate is green on the final candidate; any one of those missing fails closed
  (GH #96 AC8).
- [behavior:B-12] `ARCHITECTURE.md` gains rows for the new final-evaluation
  module and the `evaluator-final` prompt, since every path in that file must
  exist (prd.md file-scope map lines 503-533 assigns `ARCHITECTURE.md` "own
  rows" to this slice).

### Non-goals (explicit out-of-scope)

- Attribution of a finding across two or more post-approval roles — #72 story 15,
  deferred while the cleaner and hardener stay off (prd.md "Out of scope" line
  656).
- Implementing PRD 5's cleaner or hardener writing roles; only the stub stage.
- Declaring any new `GateDeclaration` or editing `src/gate-runner.ts` (prd.md
  line 722: "#91 and #96 ship no gate").
- Building or moving the `scope` gate's call site, owned by #195/#132 (prd.md
  "Where the `scope` gate's call site goes", line 685).
- Role write-scope enforcement, owned by #226 and explicitly "not #96's"
  (prd.md line 764).
- Writing `approved-baseline.json`; #91 owns the writer.
- Entering or changing merge-resolution behavior (prd.md D15).

### Existing behavior to preserve

- [behavior:P-01] `src/wave.ts` merge mutex — the merge stays serialized through
  the existing mutex critical section; no second lock and no change to its
  scope (GH #96 AC9; `src/wave.ts:373`, `:526`, `:600`).
- [behavior:P-02] `src/artifacts.ts:qaArchivePrefix` keeps returning `qa` for
  `deterministic` and `uat` for `shared-preview`, and `src/qa-review.ts`'s two
  existing `QAReviewStage` members keep their current dispatch and archive
  behavior.
- [behavior:P-03] `src/orchestrator.ts:writeApprovedBaseline` and
  `src/run-state.ts:recordApprovedBaseline` remain the only writers of the
  baseline record; this slice only reads it, and cites the
  `gateEvidenceArtifactIds` values #91 already wrote rather than minting a
  second identity for gate evidence (GH #96 "Code anchors"; prd.md D10). B-09's
  invalidation does not violate this: it records the rejected tree ID in this
  slice's own `finalEvaluations` record and never writes, rewrites, or deletes
  the baseline record, its artifact, or a gate-evidence artifact.
- [behavior:P-04] `src/change-summary.ts`'s existing candidate variant, its
  `ChangeSummary` `version: 1` shape, and its direct `execFileSync` two-ref
  reader stay unchanged; the new variant binds refs on the same builder.
- [behavior:P-05] `src/post-qa-gates.ts:reviewArtifactViolations` keeps failing
  closed on any path outside the allowlist, including edits to the locked
  contract, acceptance manifest, explorer context, handoff, or any source path.
- [behavior:P-06] `src/run-state.ts` stays backward-readable: `finalEvaluations`
  is an additive field with a version bump and a reader, and existing v4 fields
  (the #91 approved-baseline locator and #193 waivers) still load
  (`ARCHITECTURE.md` placement rules; `src/run-state.ts:840-849`).

  The bump is `RUN_STATE_VERSION` 4 → 5, so `src/run-state.test.ts` is declared
  in scope to carry the assertions that stamp the *current* version as the
  literal `4` over to `5`. Operator-declared out of band on 2026-09-11 with the
  line list read off the file rather than inferred, because the generator's
  focused scope revision mis-enumerated it and a rejected revision carries no
  feedback into its retry (`assembleFocusedScopePlannerPrompt` passes
  `findings: []`). The enumeration, and only it, is authorized:

  - **Assertions that move from `4` to `5`** — `src/run-state.test.ts:151` (v0
    load), `:168` (v1 upgrade), `:359` (`loadRunState`), `:371` (on-disk after
    `saveSliceState`), `:1492` (`expect(RUN_STATE_VERSION).toBe(4)`), `:1506`
    (inside the B-13 upgrade loop), `:1528` and `:1531` (the v3 re-stamp path
    through `saveRunState` / `loadRunState`). The test title at `:1491`
    ("upgrades every earlier version to 4") is retitled to match.
  - **Input fixtures that stay `4`** — `:250` and `:275` (the `version: 4`
    objects handed to `adaptLoadedState` in the B-06 baseline-locator
    round-trip and malformed-locator tests) and `:1564` and `:1575` (the same
    for the B-13 malformed-waiver tests). These are the backward-read evidence
    P-06 exists to protect: rewriting them to `5` would delete the "a v4 file
    still loads" coverage rather than preserve it.

  Nothing else in `src/run-state.test.ts` changes — no behavior, no data
  format, and no assertion outside the enumerated lines. `src/run-state.ts`'s
  `adaptLoadedState` continues to accept `3 | 4 | 5` so a v3 and a v4 file both
  still adapt in memory with no write.

### Changes to existing behavior (only if the issue asks for it)

- `QAReviewStage` gains a third member and `qaArchivePrefix` becomes a three-way
  map — authorized verbatim by GH #96's "Code anchors" recorded decision.
- `QA_WINDOW_ARTIFACT_NAME` admits two additional artifact names — authorized by
  GH #96 AC4 and the `ARCHITECTURE.md` seam that says a new reviewer output
  extends that constant.
- `src/run-state.ts` gains the additive `finalEvaluations` record (reuse
  decision, attempt entries, `invalidatedCandidateTreeIds`) with a
  `RUN_STATE_VERSION` bump and a `finalEvaluationFor` reader — authorized by
  prd.md's file-scope map row for this slice, and the 4 → 5 bump itself
  authorized by the operator on 2026-09-11.
- `src/run-state.test.ts` moves the eight current-version assertions P-06
  enumerates from `4` to `5` and retitles `:1491`, leaving the four `version: 4`
  input fixtures at `4`. Declared by the operator on 2026-09-11 so the bump
  above lands a green suite without exceeding scope; no other line in the file
  changes.
- `src/run-events.ts` gains one additive event member,
  `final-evaluation-reuse`, leaving `EVENTS_SCHEMA_VERSION` at 1 — authorized by
  the same file-scope map row ("reuse event").
- `src/gate-runner.ts` is *not* changed: no `GateEvidence` field carries the
  reuse or invalidation fact.

## Files expected to change

- src/final-evaluation.ts
- src/final-evaluation.test.ts
- src/orchestrator.ts
- src/change-summary.ts
- src/change-summary.test.ts
- src/qa-review.ts
- src/qa-review.test.ts
- src/artifacts.ts
- src/post-qa-gates.ts
- src/post-qa-gates.test.ts
- src/context-envelope.ts
- src/context-envelope.test.ts
- src/bounds.ts
- src/bounds.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/run-events.ts
- src/logger.ts
- src/qa-orchestration.test.ts
- prompts/evaluator-final.md
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/final-evaluation.ts` (pure reuse decision, repair routing,
  attempt accounting) with one call site in `src/orchestrator.ts`.
- New artifact schema `final-review.json` (`version: 1`) with a typed repair
  vocabulary distinguishing a preservation finding (restore only) from a
  baseline-is-wrong finding, validated by explicit literal key arrays.
- New prompt `prompts/evaluator-final.md` and a new `evaluator-final` context
  manifest entry on the existing envelope schema.
- New persisted `PersistedFinalEvaluation` record on `RunState.finalEvaluations`
  (keyed by GH issue; `decision`, `finalTreeId`, `baselineTreeId`,
  `baselineArtifactPath`, attempt entries, `invalidatedCandidateTreeIds`) with a
  `RUN_STATE_VERSION` bump and a `finalEvaluationFor` reader, and one additive
  `final-evaluation-reuse` run event.
- No new runtime dependencies — AFK has none, and this slice adds none.

## Test plan

Delivery order: land the pure module and its schema first — B-01, B-04, B-08,
B-09, B-10, B-11 with their unit suites (`src/final-evaluation.test.ts`,
`src/change-summary.test.ts`, `src/bounds.test.ts`) — then the cross-cutting
constants (B-05 `qaArchivePrefix`, B-07 `QA_WINDOW_ARTIFACT_NAME`, B-06
manifest/prompt), then the orchestration wiring and records (B-02, B-03, B-12).
A session that stops after the first group leaves a coherent, green half rather
than a half-wired dispatch path.

- Given a final checkpoint tree ID equal to the baseline record's `treeId`, when
  the reuse decision runs, then it returns reuse with no git and no agent
  invocation (unit, `src/final-evaluation.test.ts`).
- Given a one-character difference in the tree ID, when the reuse decision runs,
  then it returns evaluate.
- Given a baseline commit and a final checkpoint, when the baseline→final
  summary is built, then commits, files, and totals are exact and `byStage` holds
  exactly one key equal to the stub post-approval stage id whose per-stage files
  and stats sum to the totals, with `commits` empty when a ref is a bare tree
  (unit, `src/change-summary.test.ts`).
- Given a reuse decision, when the slice records it, then
  `finalEvaluations[ghIssue].decision` reads `reuse` through
  `finalEvaluationFor`, one `final-evaluation-reuse` event is journaled, the
  `run-summary.md` section names it, and no `GateEvidence` field and no
  gate-cache `reused` flag was written (unit, `src/final-evaluation.test.ts` plus
  the run-state and logger assertions).
- Given the final review stage, when `qaArchivePrefix` is asked for it, then it
  returns `final` and the two existing members are unchanged (unit).
- Given a tree containing a source-file write from the final evaluator's
  worktree, when the artifact-window check runs, then that path is a violation
  and only `final-review.json` / `final-report.md` pass (unit,
  `src/post-qa-gates.test.ts`).
- Given a preservation finding with a non-restore repair, when the review is
  validated, then it is refused; given restore, then it routes to the single
  post-approval stage (unit).
- Given a baseline-is-wrong finding, when routing runs, then the rejected
  candidate tree ID appears in `finalEvaluations[ghIssue]
  .invalidatedCandidateTreeIds`, every attempt entry keyed to it reads as
  invalidated, `decideFinalReuse` refuses `reuse` on that tree ID even on exact
  equality, control returns to the generator with its round counter incremented
  by exactly one, and the final-evaluation attempt count is unchanged (unit).
- Given three consumed final-evaluation attempts, when a fourth is requested,
  then the bound refuses it and each of the three archives exists stamped with
  its attempt number (unit plus an `it` on an existing spawned scenario in
  `src/qa-orchestration.test.ts`).
- Given a stub post-approval write on an otherwise-approved candidate, when the
  slice reaches the merge, then a fresh final review is dispatched and the merge
  happens inside the existing mutex (`it` on an existing spawned scenario —
  per `CLAUDE.md`'s assertion ladder and prd.md's testing decisions, no new
  spawn).

## Definition of done

- [ ] Every behavior anchor B-01…B-12 and P-01…P-06 has an executing assertion
      bound to the gate ids in `acceptance-manifest.json`.
- [ ] The reuse decision is a pure function asserted without git or agents.
- [ ] `src/change-summary.ts` has exactly one two-ref builder; no second
      producer of a change summary exists in the tree.
- [ ] `qaArchivePrefix` is a three-way map and no call path can archive a final
      artifact under the `uat` prefix.
- [ ] The final evaluator's copy-back allowlist admits exactly its two
      artifacts, and the check fails closed on anything else.
- [ ] No new `GateDeclaration` is added and `src/gate-runner.ts` is unmodified;
      the reuse fact and the baseline-is-wrong invalidation are both read back
      from `finalEvaluations` in `src/run-state.ts`, never from `GateEvidence`
      and never from the D17 gate-cache `reused` flag.
- [ ] The baseline→final summary's `byStage` key set is asserted, not just its
      totals.
- [ ] `prompts/evaluator-final.md` exists and the `evaluator-final` manifest
      entry names both its artifacts in `allowedWriteScope`.
- [ ] `ARCHITECTURE.md` rows added for the new module and prompt, and every path
      it names exists.
- [ ] Only the paths in `## Files expected to change` are touched.
- [ ] `src/run-state.test.ts` changes exactly the eight assertions and the one
      title P-06 enumerates, and the four `version: 4` input fixtures it names
      still read `4` — so the "a v4 file still loads" coverage survives the bump
      rather than being rewritten away.
- [ ] `pnpm run typecheck` is green and the touched suites pass
      (`src/final-evaluation.test.ts`, `src/change-summary.test.ts`,
      `src/qa-review.test.ts`, `src/post-qa-gates.test.ts`,
      `src/bounds.test.ts`, `src/context-envelope.test.ts`,
      `src/run-state.test.ts`, `src/qa-orchestration.test.ts`).
