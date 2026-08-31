# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff 8f97ce6...HEAD`, all slice contracts and implementations
under `.kiro/specs/afk-v2-routing-adjudication/slices/`, the PRD, and ADRs
0050-0055. I traced the merged routing, adjudication, transaction, lifecycle,
cleanup, and adoption paths.

The pre-ship gate already passed this exact tree, so I did not rerun the full
suite.

## Blocking findings

### 1. Post-decision apply failures discard preserve-all ownership

- **File/location:** `src/orchestrator.ts`,
  `runImpasseAdjudication()` at lines 2423-2435 and 2548-2587;
  `src/wave.ts`, negotiation exception handling at lines 462-480;
  `src/slice-lifecycle.ts`, the `ERROR` trait at lines 325-332;
  `src/clean-failed.ts`, pass 1 at lines 163-205; and
  `src/artifacts.ts`, `sliceArtifactNames()` at lines 791-808.
- **Evidence gathered:** I read the complete-decision apply path. A feature
  refresh conflict returns ordinary `ERROR`; a planner failure returns
  ordinary `ERROR`; and a thrown apply/bookkeeping error is converted by the
  wave to ordinary `ERROR`. I then traced `ERROR` through lifecycle traits and
  cleanup: it declares `debris: "disposable"`, so `clean-failed` removes its
  worktree. The durable decision files live only in that worktree and are not
  in `sliceArtifactNames()`. A focused TypeScript probe confirmed
  `ERROR debris = disposable`,
  `ADJUDICATION-LOCK-REFUSED debris = preserve-all`, and that the archive list
  omits both `adjudication-decisions.json` and `adjudication.md`.
- **Defect:** Once all human decisions have been accepted, a planner/provider
  failure, refresh conflict, cancellation during apply, or post-lock
  bookkeeping throw can replace estate-preserving state with a disposable
  terminal phase. `afk clean-failed` may then erase the only decision log, so
  the promised retry from the same human decisions is impossible.
- **Convention violated:** ADR 0054, **The decision log is not part of the
  transaction**, requires human input to outlive a mechanical refusal and a
  rolled-back apply to retry from the same decisions. ADR 0055, **Seam 1
  section 5** and the **Seam 2 invariant/section 6**, requires completed
  adjudication estates to retain `preserve-all` ownership across cleanup and
  other lifecycle operations; presentation or a broad failure phase must not
  imply disposability.
- **Required fix:** Preserve adjudication-estate ownership on every
  post-decision apply exit, not only lock refusals. Model that ownership
  independently of the broad error presentation or route these exits through
  an estate-preserving persisted state. Add focused planner-failure and
  refresh-conflict cleanup tests proving the decision log, worktree, branch,
  and retry path survive.

### 2. Adoption misses a detached registered adjudication worktree

- **File/location:** `src/git.ts`, `listWorktrees()` at lines 903-919;
  `src/adopt-command.ts`, `worktreesHolding()` at lines 296-303,
  `parkedEstateRefusal()` at lines 330-347, and the pre-mutation refusal path
  at lines 496-518.
- **Evidence gathered:** I read the worktree representation and adoption
  guard. `listWorktrees()` represents a detached registered worktree with
  `branch: null`. `worktreesHolding()` matches only branch identity, and
  `parkedEstateRefusal()` permits adoption whenever that branch match is
  empty. The command can therefore proceed even when the parked slice's
  expected worktree remains registered but detached.
- **Defect:** Adoption can persist `PASS` while a detached worktree still owns
  the adjudication files. The next launch has no live slice record owning that
  registered worktree and can refuse it as leftover state, stranding the
  estate that adoption was required either to preserve or to reject by name.
- **Convention violated:** ADR 0055, **Seam 2 invariant** and **section 8**,
  says a parked estate survives every lifecycle operation except its own
  re-dispatch, adoption must refuse while a park owns a registered worktree,
  and absence must be proved rather than inferred.
- **Required fix:** Make the adoption guard identify the parked estate by its
  registered expected path as well as branch attachment, and fail closed when
  a preserve-all record has an associated detached or otherwise ambiguous
  worktree. Add a focused detached-worktree adoption test that proves no ref
  or run-state mutation occurs.

## Focused verification

- `git diff --check main...HEAD` passed.
- The lifecycle/archive TypeScript probe produced the values cited above.
- No full suite was rerun because the pre-ship gate already passed this tree.
