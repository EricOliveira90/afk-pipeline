# Contract feedback — round 1

## What this round settled

The three findings carried in from the previous attempt are all met.

The graded-candidate identity is no longer four independent expressions hoping to
agree: `[behavior:B-08]` makes it one pure `resolveGradedCandidate` value and
`[behavior:B-09]` binds all four pass-path consumers to it — the deterministic QA
dispatch (`src/orchestrator.ts:6475-6492`), the approved baseline (`:6508-6512`),
the shared-preview `candidateTreeId` (`:6569`) and `runPostQAGates`'s
`qaApprovedTreeId` (`:6713`). That last one was the previous attempt's sharpest
gap, and the contract now states the consequence in the terms the guard itself
uses: `src/post-qa-gates.ts:202-223` compares the argument against a fresh
checkpoint of `ctx.worktreeDir` and returns `action: "ERROR"` — "The QA verdict
does not authorize this tree (ADR 0012)" — before running the suite, so a
pre-audit id there would fail the slice immediately after the verdict it just
earned. Crucially the fix is a hub rewiring only: `src/post-qa-gates.ts`,
`src/qa-gate-authorization.ts` and `src/gate-runner.ts` stay out of the file
scope, and P-04 makes their absence the observable.

Registration is covered too. `[behavior:B-10]` pushes the audited tree id
through `verifyAuditedTree`'s `onCandidateTree` callback *before* the gate
re-run, so it lands on the pass branch and the failure branch alike, which is
what `src/post-qa-gates.ts:272`'s `.slice(0, -1)` on `priorAttemptTreeIds`
(`src/orchestrator.ts:6706`) and B-06's terminal `attemptTreeIds` both need. And
every anchor the contract declares now has a manifest entry with its own
scenario, observable and gate ids drawn from the executable catalog — the
non-executable `lint` is cited nowhere.

Three other things are worth naming as good, because they are the parts most
often waved at: the acceptance gate's exclusion from the re-run set is a *named*
non-goal with the reason (`resolveCheapGateCatalog` does not name it, and a gate
with no declared `expectedCostMs` cannot be asserted cheap) rather than a silent
omission; the audited base-gate object is required to be built fresh, with the
spread-override and pass-through variants both explicitly forbidden and the ADR
0012 reason for each; and the explorer's unknown about the final-scope
`runPostQAGates` call at `src/orchestrator.ts:7393+` is disposed of as an
explicit, reversible non-goal instead of left hanging.

I also checked the fragment arithmetic B-09 and P-06 lean on, since text-scan
observables are only as honest as their counts. `candidateCommitSha:
checkpoint.commitSha,` occurs once (`:6484`), `commit: checkpoint.commitSha,`
once (`:6510`), `qaApprovedTreeId: checkpoint.treeId,` once (`:6713`), and
`candidateTreeId: checkpoint.treeId,` four times (`:6384`, `:6409`, `:6483`,
`:6569`) — so the contract's "exactly twice, both before the
`runSelfAuditStage(` index" claim for that last fragment is exactly right, and
correctly identifies the two survivors as P-02's pre-audit exhaust argument and
P-06's `qaBaseGate` literal.

## What still needs a change

One fragment in that same set is over-broad, and it is the kind that turns an
honest implementation into a failing test.

B-09 asserts that `treeId: checkpoint.treeId,` occurs **zero** times after the
rebinding. It occurs twice today. One is the `writeApprovedBaseline` argument at
`src/orchestrator.ts:6509` — the consumer B-09 legitimately rebinds. The other
is at `src/orchestrator.ts:6264`, inside the pre-audit gate run itself:

```
const preQaGateRun = await runCandidateGatePhase({
  ...
  treeId: checkpoint.treeId,
  cwd: gateCwd,
  declarations: preQaDeclarations,
```

That occurrence has to survive. The whole slice rests on the pre-audit gates
having released `checkpoint.treeId` — `assertGateEvidenceReleasesEvaluation(
gateEvidence, preQaDeclarations, checkpoint.treeId)` at `:6392-6396` asserts
precisely that, P-06 preserves it verbatim, and B-04 describes the audited
verification as an additional pass rather than a relocation. So as written the
obligation can only be satisfied by handing the pre-audit gate phase the audited
tree id, which contradicts two of the contract's own terms.

Scope the assertion the way the contract already scopes its sibling. Either bound
it to the `writeApprovedBaseline(ctx, round, {` … `});` slice — which the B-09
observable already knows how to do for the positive fragments — and assert
`treeId: checkpoint.treeId,` is absent *from that slice*; or state an exact
residual count of one and pin its position before the `runSelfAuditStage(` index,
mirroring the treatment `candidateTreeId: checkpoint.treeId,` gets. Both
`contract.md`'s B-09 bullet and the manifest's B-09 `then` and `observableResult`
carry the claim, so both need the same correction.

Nothing else in the pair needs to move for this. The behavior set, the file
scope, the non-goals and the other sixteen observables read as implementable in
one session: the new production code is one exported function group in
`src/self-audit.ts` behind injected `createCheckpoint` / `onCandidateTree` /
`runGates` callbacks — `runCandidateGatePhase` does exist at
`src/candidate-gate-phase.ts:47` to bind the third one to — plus one call site
and the consumer rebinding in the hub, and the tests are unit and source-order
seams with no new spawned scenario.
