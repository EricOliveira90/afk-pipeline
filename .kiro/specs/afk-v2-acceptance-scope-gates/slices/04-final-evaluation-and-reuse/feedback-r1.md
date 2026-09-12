# Contract review feedback — round 1

## What this contract already does well

Most of the slice is lockable as written, and several of the explorer's open
unknowns are closed by explicit recorded decisions rather than left to the
generator:

- The D20 reuse comparison gets a home (`src/final-evaluation.ts`, one
  orchestrator call site) with a justification from `ARCHITECTURE.md`'s
  hub rule, which answers the unknown about where the comparison is called
  from.
- The stub post-approval stage is pinned as an internal injectable no-op
  rather than a new exported interface — the right call while PRD 5's writers
  stay off, and it makes B-03's "a stub write forces a fresh review" testable.
- `src/bounds.ts` gaining a named final-evaluation attempt export is stated as
  new work, matching the direct read that no such constant exists there today.
- The archive-prefix and copy-back questions are settled as extend-in-place on
  `qaArchivePrefix` and `QA_WINDOW_ARTIFACT_NAME`, with P-02 and P-05 holding
  the existing behavior of both. Extending the allowlist regex is a change to
  an accepted-input language, and B-07 binds both halves of the regression
  surface: the two newly admitted names *and* a rejected source path, in the
  established inline `src/post-qa-gates.test.ts` harness that is declared in
  file scope.
- The non-goals are precise and cite their owners: no new `GateDeclaration`,
  no `scope`-gate call site (#195/#132), no write-scope grader (#226), no
  baseline writer (#91 owns it), no multi-role attribution (#72 story 15).
- Every gate id used is executable from the catalog, and the pure-function
  behaviors correctly claim `typecheck` alongside `tests`.

## What needs to change before this can lock

Two behaviors assert facts about stores the contract simultaneously puts out
of reach, and that is what blocks the lock.

**B-02 records the reuse in gate evidence, but gate evidence is declared
unmodifiable.** The scope lock and B-02 both say the reuse is recorded in the
slice's gate evidence, while the non-goals and the definition of done say
`src/gate-runner.ts` is unmodified and out of file scope. `GateEvidence` there
is `{ version, attemptId, treeId, results }` and carries no field for "no
final evaluator was dispatched". The one reuse marker it does have is the D17
per-result gate-cache flag, which means something else entirely — a gate
answer replayed from cache, not a skipped evaluation. Overloading that flag
would make an operator reading evidence unable to tell the two apart. Name the
actual field and the module that owns it; if it genuinely has to be an
additive `src/gate-runner.ts` field, add that file to scope and to the
authorized-changes list and say so.

**B-09's "downstream evidence" has no named store.** The behavior says
evidence keyed to the rejected candidate tree is invalidated, and the
observable says a test shows "the invalidated evidence" — but nothing in the
contract says which record or field that is. The evidence identities the slice
does cite are the `gateEvidenceArtifactIds` values on `approved-baseline.json`,
whose identity is a gate-evidence artifact path in the same out-of-scope
module. Bind the invalidation to a concrete in-scope record and say what a
reader observes afterwards.

## Smaller points worth folding in

- B-09's `then` claims the return consumes a generator round, which is the
  load-bearing half of D19, but its observable only checks the generator return
  and the unchanged final-evaluation count. Assert the generator round
  advanced by one.
- B-04's "partitioned per post-approval writing stage" is a one-element
  partition while the only stage is the no-op stub, so the test as described
  cannot tell a partitioned summary from a flat one. Say what the partition key
  looks like on the returned object.
- The declared surface is at the upper end of one generator session: a new
  dispatch path plus five cross-cutting single-line-ish edits that each drag in
  their own suite. That matches the PRD's file-scope map for #96, so it is not
  a re-scoping request — just a note to build the pure module and its unit
  assertions before the orchestration wiring, so a session that runs long still
  leaves a coherent half.
