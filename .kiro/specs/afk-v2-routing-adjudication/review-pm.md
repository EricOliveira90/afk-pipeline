# Product Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope

This review judges only slices 01 (#80), 02 (#81), 03 (#89), 04 (#82),
and 06 (#129). Slice 05 (#94) is out of scope.

## Fix Before Ship

### 1. A retained malformed escalation can prevent the required stuck diagnosis

The PRD requires malformed escalations to fail closed with their raw evidence
retained (story 13), and requires later STUCK outcomes to receive a
code-assembled diagnosis from archived evidence (story 11). Those outcomes
do not compose safely.

- **File/location:** `src/artifacts.ts`,
  `archiveScopeEscalationAttempt` (lines 331-347),
  `archivedScopeEscalations` (lines 528-556), and
  `renderStuckDiagnosis` (lines 621-624); `src/orchestrator.ts`,
  `finishStuck` (lines 3732-3742).
- **Evidence gathered:** I read that escalation bytes are archived before
  validation, while diagnosis assembly later calls `JSON.parse` directly on
  every matching archive with no malformed-evidence fallback. `finishStuck`
  does not catch that failure before writing `stuck.md`. I then ran a
  focused probe containing an OPEN QA finding and malformed
  `escalation-r1-a1.md`; `renderStuckDiagnosis` threw instead of producing
  the operator diagnosis.
- **Missing user outcome:** after an earlier malformed escalation and a
  later retry that exhausts QA, the slice can end without the deterministic
  `stuck.md` promised by slice 04.

Required fix: render malformed retained escalation evidence as a deterministic
invalid-artifact entry, or otherwise isolate it without aborting diagnosis
assembly.

### 2. Focused scope revision bypasses the pipeline's lock-time safety gate

Slice 01 promises that a valid escalation routes through contract revision
and resumes generation under a legally re-locked contract, while preserving
the existing orchestrator-owned lock transition.

- **File/location:** `src/orchestrator.ts`,
  `reviseAcceptedContract` (lines 1147-1381), especially the direct
  `artifacts.lockContract` and `LOCKED` return near lines 1376-1380;
  `src/wave.ts` (lines 224-231), where the production lock callback composes
  migration-prefix and run-specific checks.
- **Evidence gathered:** I read every `onContractLocked` call site using
  `rg -n "onContractLocked" src/orchestrator.ts src/wave.ts`. Ordinary
  negotiation and adjudication consult the callback; focused scope revision
  does not. It locks and resumes generation immediately after evaluator
  acceptance.
- **Wrong user outcome:** a focused revision can resume the generator with a
  contract that the same pipeline would refuse to lock through ordinary
  negotiation against the current feature tip.

Required fix: route focused-revision acceptance through the same lock-time
gate and roll back the revision transaction when that gate refuses it.

### 3. Lane refresh can erase an accepted human decision before generation

The PRD requires a valid human decision to resume the parked slice after one
mechanical apply-and-lock step, with lane semantics preserved (stories 7, 9,
and 15).

- **File/location:** `src/adjudication.ts`,
  `appendAdjudicationDecision` (lines 305-330);
  `src/orchestrator.ts`, `runImpasseAdjudication` (lines 2110-2405);
  `src/wave.ts`, lane-successor refresh (lines 396-420);
  `src/git.ts`, `recreateWorktreeFromBase` (lines 1036-1054).
- **Evidence gathered:** I followed the production sequence. Phase A records
  `adjudication-decisions.json` and the accepted lock inside the slice
  worktree. If that slice is later than another member of its file-overlap
  lane, the wave unconditionally removes its worktree, deletes its branch,
  recreates both from the feature branch, and renegotiates. That path does
  not archive or restore the decision record or accepted lock.
- **Wrong user outcome:** a human can provide a valid decision, see it
  accepted, and still have it discarded before the generator starts solely
  because the slice is a lane successor.

Required fix: preserve and restore adjudication state across lane refresh, or
exclude an adjudicated slice from the destructive successor-refresh path.

## Delivered outcomes

- Slice 01 delivers strict escalation validation, raw attempt archives,
  pre-build discovery, focused revision, rollback on revision failure, and
  same-implementation-round resumption. Finding 2 leaves the revised lock
  unsafe.
- Slice 02 delivers impasse evidence, `AWAITING-ADJUDICATION`, independent
  sibling continuation, visible dependent holds, and cancellation
  preservation.
- Slice 03 delivers one decision per finding, fail-closed adjudication,
  transactional apply-and-lock, bounded waiting, in-run redispatch, and
  next-run pickup. Finding 3 breaks the lane-successor case.
- Slice 04 delivers deterministic finding/round/commit rendering and retires
  the stuck-specific agent prompts. Finding 1 prevents diagnosis creation
  for retained malformed escalation evidence.
- Slice 06 delivers verified candidate-merge gates, refusal without normal
  branch/state mutation, provider-qualified run selection, adoption
  provenance, and summary/draft-PR reporting.

## Product note

Scope escalation allows two focused revisions per implementation round, then
refuses a third otherwise-valid escalation. The PRD does not specify this
limit. The anti-loop bound is reasonable, but it should be documented for
operators.

## Verification

- Read the PRD, every available slice contract/acceptance manifest and
  implementation handoff, plus the relevant production and test paths.
- Ran 146 focused unit tests across escalation, adjudication, adoption,
  artifacts, and prompt retirement.
- Ran focused integration checks for multi-finding adjudication, pre-build
  and same-round scope revision, and bounded next-run adjudication pickup.
- Ran the one-test malformed-escalation diagnosis probe described in finding
  1.
- Did not re-run the already-passed full suite.

## Out-of-scope PRD gaps

- Slice 05 (#94), the babysit courier that presents both positions and writes
  the adjudication artifact, was not executed by this run.
- Story 14, repository-versioned/global babysit skill packaging, remains
  explicitly deferred.

These gaps do not drive the verdict.
