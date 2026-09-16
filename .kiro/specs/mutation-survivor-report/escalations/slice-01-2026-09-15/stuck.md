# Contract negotiation stuck

- Slice: #303 Mutation report step
- Outcome: ESCALATE
- Exhaustion classification: NON_CONVERGENCE
- Round: 3
- Final verdict: VERDICT: REVISE
- Round-cap decision: Granted one final contract response for fresh blocking finding(s) F-07. No final contract response granted: AFK exhausted the bounded contract repair capacity with unresolved blocker(s) F-08.. AFK exhausted the bounded contract repair capacity with unresolved blocker(s) F-08. Operator action: Clarify or decide the contract requirement behind F-08 and record that decision in the source issue or an ADR, then rerun the slice: negotiation restarts at round 1 and carries F-08 into it as durable lineage. Preserved candidate tree 46e2b9ec8c67a1d13c289983a817338ca5daccaa holds the artifacts the exhausted negotiation produced. Negotiation stopped because the negotiation reached its hard cap of 3 planner round(s).

## Exhaustion record

- [F-08] BLOCKING OPEN
  - Planner position: (none)
  - Planner evidence: (none)
  - Evaluator evidence: "the same `terminate` binding B-12 declares is invoked and the step promise is awaited to settlement **before** the guardian rejection is rethrown unchanged" together with "`terminate` on a `reviewDir` with no mutation process registered yet is a no-op, so the wrap is safe whether or not the command has spawned", and B-12's "the bound covers the rejoin exit and the wrap covers the throw exits".

## Unresolved gaps

- [F-08] BLOCKING OPEN — behaviors: B-11, B-12, P-03
  - Evidence: "the same `terminate` binding B-12 declares is invoked and the step promise is awaited to settlement **before** the guardian rejection is rethrown unchanged" together with "`terminate` on a `reviewDir` with no mutation process registered yet is a no-op, so the wrap is safe whether or not the command has spawned", and B-12's "the bound covers the rejoin exit and the wrap covers the throw exits".
  - Expected: The new guardian-rejection exit is bounded and its termination actually covers the pre-spawn window, so a rejecting guardian still leaves the gate promptly and no mutation process runs on in `reviewDir` after the wrap's `terminate` ran.
  - Observed: The wrap awaits the step promise "to settlement" with no deadline of any kind: B-12 places the flat 30-minute bound on the rejoin exit only and says explicitly that "the wrap covers the throw exits", so the throw exits inherit no bound. Combined with the declared no-op, the pre-spawn window is unlocked. B-11 starts the step before the fork, and B-10 has the step first derive its file scope from `buildChangeSummary` over the run's base and merged tip — real git work on the merged review worktree — before the declared command is spawned through the `mutationRun` seam. A guardian that rejects inside that window (an infrastructure rejection out of `runGuardianReview` at `src/ship-gate.ts:931-933`, or a rejected element at `:941-944`, can settle in seconds) hits a `terminate` that is a declared no-op because nothing is registered on `reviewDir` yet, and the wrap then awaits a step promise that goes on to spawn the mutation command *after* `terminate` ran. The gate therefore blocks the guardian's rejection for the whole mutation run — unbounded, since neither `MUTATION_STEP_BOUND_MS` nor any other deadline is declared on this path — and the process it spawns is registered after the only quiesce this path performs, which is the state ADR 0020/ADR 0035 exist to prevent. A swallowed `terminate` failure has the same shape: B-11 declares the failure "is swallowed", after which the await-to-settlement is the only remaining mechanism and it has no bound. This path did not exist before the revision — round 2 had no wrap, and the rethrow propagated immediately — so the delay-and-late-spawn hole is created by the wrap, not inherited.
  - Clear when: B-11/B-12 bound the wrap's await the way the rejoin exit is bounded — e.g. the throw path awaits the same bounded helper with `MUTATION_STEP_BOUND_MS` rather than an open-ended settlement await — and close the pre-spawn window by declaring what stops a not-yet-spawned command from spawning after the wrap's `terminate` (e.g. the step checks an abandonment flag the wrap sets before it spawns, or the seam invocation is skipped once the wrap has run), and P-03's rejecting-guardian scenario gains an observable for that window: `src/ship-gate.test.ts` asserting that when the guardian rejects before the `mutationRun` seam is invoked, the rejection leaves the gate without waiting on a subsequent mutation run and the seam is never invoked afterwards (or any process it registered is quiesced), alongside the already-declared pending-promise case.
- [F-07] BLOCKING RESOLVED — behaviors: B-11, B-12, P-03
  - Evidence: "the step is kicked off as an unawaited promise, so neither branch of `src/ship-gate.ts:930-947` is restructured" with "Its result is awaited after the fork rejoins, at the point where `architectResult` and `pmResult` are both assigned (`src/ship-gate.ts:948`)", against P-03's declared scenario "including a guardian invocation that rejects" and B-12's "no second kill path and no tolerated detached post-exit process".
  - Expected: Every path that leaves the ship gate while the step is in flight is declared, so the step's process cannot outlive the review worktree — including the guardian-rejection path the same round asserts.
  - Observed: Resolved by this revision. B-11 now declares the whole fork region wrapped so no exit leaves the step unawaited, and names both rejection exits explicitly — the `throw architectSettled.reason` / `throw pmSettled.reason` rethrows at `:941-944` and the rejecting `await runGuardianReview(...)` at `:931-933` — as invoking the same `terminate` binding before the guardian's reason is rethrown unchanged. B-12 confirms it is the same single binding rather than a second kill path and ties it to ADR 0035's live-`cwd` rule. P-03 gains the observable the clear condition asked for: `src/ship-gate.test.ts` asserting, in both guardian modes, that `terminate`/`quiesceWorktree` was called on `reviewDir` before the throw propagated, that no mutation process remains registered for `reviewDir`, and that the caught reason equals the flag-absent reason; a matching Test plan bullet and Definition of done item accompany it. The citation note is also fixed: `:947-948` with the assignments at `:931-933` and `:945-946` matches `src/ship-gate.ts:928-948` as read. What survives is not this gap but a property of the mechanism chosen to close it, tracked as F-08.
  - Clear when: B-11/B-12 state what happens to the in-flight step when a guardian rejects in either branch of `src/ship-gate.ts:930-947` — e.g. the fork is wrapped so the rethrow path invokes the same `terminate` binding (or awaits the bounded helper) before the rejection propagates — and P-03's rejecting-guardian scenario gains an observable result that sees it, such as `src/ship-gate.test.ts` asserting that `terminate`/`quiesceWorktree` on `reviewDir` was called and no mutation process remains registered when the guardian rejection leaves the gate.

## Next action

Update the source issue body (the local issue manifest when present, otherwise the GitHub issue) to close the unresolved acceptance and test-plan gaps above, then rerun the slice.

## Artifact locations

- Working contract: .afk/worktrees/afk-claude-code-mutation-survivor-report-s01/.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/contract.md
- Working context: .afk/worktrees/afk-claude-code-mutation-survivor-report-s01/.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/context.md
- Working feedback: .afk/worktrees/afk-claude-code-mutation-survivor-report-s01/.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/feedback-r3.md
- Archive directory: .afk/artifacts/mutation-survivor-report-claude-code/slice-01
- Archived contract: .afk/artifacts/mutation-survivor-report-claude-code/slice-01/contract.md
- Archived context: .afk/artifacts/mutation-survivor-report-claude-code/slice-01/context.md
- Archived feedback: .afk/artifacts/mutation-survivor-report-claude-code/slice-01/feedback-r3.md
- Working exhaustion outcome: .afk/worktrees/afk-claude-code-mutation-survivor-report-s01/.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/contract-negotiation-outcome.json
- Archived exhaustion outcome: .afk/artifacts/mutation-survivor-report-claude-code/slice-01/contract-negotiation-outcome.json
