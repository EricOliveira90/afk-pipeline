# Contract review — round 2

## The one prior finding

**F-07 — resolved.** The over-broad global zero-count for
`treeId: checkpoint.treeId,` is gone, and what replaced it is satisfiable.

I checked the arithmetic in this worktree rather than taking the planner's
count on trust. `treeId: checkpoint.treeId,` occurs exactly twice in
`src/orchestrator.ts` today:

- `:6264`, inside `runCandidateGatePhase({ ... treeId: checkpoint.treeId, cwd:
  gateCwd, evidenceDir, declarations: preQaDeclarations, ... })` — the identity
  of the pre-audit gate run itself, and the only `runCandidateGatePhase(` call
  in the file, so the `declarations: preQaDeclarations` disambiguator the
  contract leans on holds today and will still hold if the hub's `runGates`
  binding adds a second call with the selected declarations.
- `:6509`, inside `writeApprovedBaseline(ctx, round, {` (`:6508`) through its
  closing `});` (`:6512`) — the one consumer B-09 rebinds. The slice delimiters
  the contract now names are unambiguous: nothing between those two lines closes
  with `});`.

So rebinding only the consumer leaves exactly one residual occurrence, at
`:6264`, whose index precedes the single `runSelfAuditStage(` at `:6419`. B-09's
revised assertion — absent from the `writeApprovedBaseline` slice, exactly once
in the file, before the audit index, inside the `preQaDeclarations` gate-phase
call — passes in the implementation the rest of the contract describes. The
three fragments still held to zero are each single-occurrence pass-path
consumers today (`candidateCommitSha: checkpoint.commitSha,` `:6484`,
`commit: checkpoint.commitSha,` `:6510`, `qaApprovedTreeId: checkpoint.treeId,`
`:6713`), so nothing else in the file has to move to satisfy them, and
`candidateTreeId: checkpoint.treeId,`'s "exactly twice, both before the audit
index" still lands on `:6384` and `:6409` after the `:6483` and `:6569`
consumers are rebound.

What makes this a real fix rather than a loosened count is the P-06 half. The
residual occurrence is now asserted *positively*: P-06's `then`, its
`observableResult` and its test-plan bullet all name the `:6264` argument as the
first element of the ordered pre-audit release sequence, ahead of
`assertGateEvidenceReleasesEvaluation(`, the `verifyGateEvidence` loop and the
`qaBaseGate` literal, with all four indices before `runSelfAuditStage(`. A
future change that quietly rebound `:6264` to the audited tree would now fail
P-06's test, not merely drift past a tolerance. The Definition of done bullet is
narrowed to *pass-path consumer* arguments and names the three preserved
`checkpoint` reads explicitly, which keeps the checklist honest about what "no
consumer still reads `checkpoint`" means.

## Nothing fresh in the revision

The revision touched six regions of `contract.md` and three of
`acceptance-manifest.json`, all of them either the B-09 expectation itself or
the P-06 statement that justifies its residual. No behavior was added or
dropped, no `fileScope` path changed, migration count is still 0, and the gate
bindings on the two touched behaviors are unchanged and apt — B-09 keeps
`typecheck` (it asserts an assignability claim about the audited base-gate
object) alongside `tests` and `acceptance:behaviors`, and P-06 remains a
source-order text scan on `tests` plus `acceptance:behaviors`. Every new
assertion still lands on a unit or source-order seam, so the slice adds no
spawned pipeline scenario.

One neutral observation, not a request: P-06's `source` field swapped its GH
#300 settled-decision citation for the four production line ranges it now
asserts over. The settled-decision content ("keeps its present text and order",
"additive, not a relocation") moved into the `then`, so nothing is lost in
substance, and pointing a preservation behavior at the source it preserves is
the more useful citation.

## Carried unknowns

The explorer's open unknowns about `resolvePreQAGateDeclarations`'s exact
definition and the mechanics of materializing a fresh checkpoint against the
audited worktree remain unknowns, but they are implementation questions inside
B-02 and B-03 rather than contract gaps: B-03 pins the selection rule by its
observable output (catalog-named required ids, the same declaration objects, in
declaration order) and B-02 pins the checkpoint through an injected
`createCheckpoint` callback with a distinct path, so neither obligation depends
on resolving them in advance. The final-scope `runPostQAGates` call is recorded
as an explicit non-goal with its reasoning, which is the right disposition for a
boundary that is reversible before merge.
