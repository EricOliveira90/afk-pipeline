# Product Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope

This review judges only slices 01 (#80), 02 (#81), 03 (#89), 04 (#82), and 06 (#129). Slice 05 (#94) is out of scope.

## Fix Before Ship

### One adjudication can silently settle a multi-finding impasse

The PRD says the adjudication artifact identifies one finding and that “the human decision resolves a finding, not the contract” (`prd.md`, Solution). A human decision for one contested finding must not silently settle other contested findings.

Evidence gathered:

- `src/orchestrator.test.ts`, test `parks a contested round-two exhaustion for adjudication` (lines 2788-2939), creates one impasse containing two contested findings, `F-01` and `F-02`.
- `src/adjudication.ts`, `parseAdjudication` (lines 81-93), validates only that the chosen `findingId` exists and is contested. It does not account for other contested findings.
- `src/orchestrator.ts`, `runSliceNegotiate` / `lockAdjudicatedContract` (lines 2123-2184), locks and returns `LOCKED` immediately after applying a valid decision. It does not check whether the impasse still contains another undecided contested finding.
- `src/orchestrator.test.ts` (lines 2962-2990) writes a decision only for `F-01` and explicitly expects `LOCKED`, although the same impasse still contains contested `F-02`.
- I ran the focused `src/orchestrator.test.ts` selection. The scenario passed, confirming this is the implemented and asserted behavior rather than a dead branch.

Observed user outcome: deciding `F-01` can start generation while `F-02` has never been decided by the human.

Required outcome: a decision must resolve only its named finding. The slice must not become generator-dispatchable until every remaining contested finding has an explicit human decision and the mechanical lock checks pass.

## Delivered outcomes

- Slice 01: pre-build and finding-backed escalations have a strict schema, immutable attempt archives, focused planner/evaluator revision, rollback on failed revision, and same-implementation-round resumption.
- Slice 02: impasse evidence preserves both positions, the slice parks as `AWAITING-ADJUDICATION`, independent work continues, dependents remain visibly blocked, and cancellation preserves parked state and evidence.
- Slice 03: adjudications are schema-validated and fail closed; waits are bounded; valid decisions can resume in-run or on a later run; evaluator and third-instruction decisions pass through one apply-and-lock step; cancellation preserves evidence. The multi-finding defect above prevents this slice from fully delivering its promised outcome.
- Slice 04: `stuck.md` is assembled deterministically from archived finding, escalation, round, artifact, and commit evidence; resolved and open findings are separated; failed resumes refresh the diagnosis; the retired stuck-specific prompts are no longer active.
- Slice 06: `afk adopt` verifies the detached candidate merge with all base gates before moving the feature ref, records adopter/reason/branch/commit provenance, refuses conflicts and failed gates without mutation, supports provider-qualified run state, and surfaces adoption in summaries and draft PR bodies.

## Product notes

- Slice 01 caps focused scope revisions at two per implementation round (`src/orchestrator.ts`, `MAX_SCOPE_REVISIONS_PER_ROUND` and `runSliceExecute`). The PRD does not name this cap, so a third otherwise valid escalation requires manual intervention. I treat this as a reasonable anti-loop bound rather than a separate ship blocker, but the operator-facing limit should be documented.

## Verification

- Read the PRD, every available slice contract/acceptance manifest/context/handoff, and the relevant production and test paths.
- Ran focused unit and integration verification only; the already-passed full suite was not rerun.
- Focused results: 7 files / 167 tests passed, then 4 files / 34 selected tests passed.

## Out-of-scope PRD gaps

- Slice 05 (#94), the babysit courier that presents both positions and writes the adjudication artifact, was not executed by this run.
- Story 14, repository-versioned/global babysit skill packaging, remains explicitly deferred.

These gaps do not drive the verdict.
