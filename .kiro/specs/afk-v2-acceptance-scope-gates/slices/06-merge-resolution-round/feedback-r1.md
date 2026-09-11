# Contract review — round 1

## What this contract already gets right

Most of the hard work is done, and done against real evidence:

- **The call-site correction is the right call, and it is declared.** The issue
  says "one call site on the merge path in `src/orchestrator.ts`", but the only
  first-attempt merge that can produce a textual conflict for a dispatched slice
  is in `src/wave.ts:576-598`. B-01 records the discrepancy, keeps `src/wave.ts`
  to one call and no logic, and leaves the resolver body in the new module. That
  matches the explorer's finding exactly and closes its call-site unknown.
- **The hunk-acquisition gap is confronted rather than assumed away.** B-10's
  recorded decision cites `mergeSliceBranch`'s unconditional
  `git merge --abort` (`src/git.ts:1032-1036`) and `MergeResult`'s
  `details: string`-only conflict variant, and answers the question the explorer
  left open: the module gets its own hunks via plumbing in a disposable
  worktree, following `src/change-summary.ts`'s precedent.
- **Gate re-entry is re-entry.** B-03 calls the exported
  `runCandidateGatePhase` with declarations built by `src/orchestrator.ts`, and
  its observable pins the `treeId` to the resolved tree — which is precisely the
  stale-`PASS` risk the tree-identity gate cache creates. `src/candidate-gate-phase.ts`
  stays unmodified (P-06).
- **The scope gate reuses D3's existing mechanism.** B-07 passes the existing
  `{ kind: "candidate", worktreeDir, featureRef }` source with `featureRef` at
  the merged tip and a caller-proven `acceptedPairIntact` — no second exemption,
  no hard-coded `true`, no new comparison logic. `src/scope-gate.ts` and
  `src/escalation.ts` stay read-only.
- **Non-goals are named where the explorer had questions.** The pre-wave
  `MERGE-PENDING` recovery site is explicitly out of scope with a reason (no
  live worktree or generator to dispatch to), `src/run-state.ts` is untouched
  with the schema-version risk consciously not taken, and the `MERGE-PENDING`
  collision path is fenced off by B-09 plus P-01.
- **The prompt work is additive and pinned.** P-03 protects the
  `# Scope escalation` literal and the `{{REPAIR_SITUATION}}` slot, and the
  block registers its heading in `REPAIR_SITUATION_SECTION_TITLES` so section
  extents keep working. Notably this survives the explorer's `GATE-SCOPE`
  uncertainty: P-03 pins what is in the file today via
  `src/prompt-template.test.ts`, not a described future version.
- **The test plan reuses the existing two-lane conflict fixture** rather than
  spawning a new wave scenario, which is what this repo's test-cost discipline
  asks for.

## What has to change before this locks

**One blocking issue: the resolution round has no single tree/branch model.**

Three behaviors describe what look like three different trees, and the failure
case contradicts the success case:

- B-03 hands the gates "a generator that resolved the conflict in its worktree
  on the feature-branch tip", and B-07 needs that same tree to contain an
  already-merged sibling's files. Both require a tree the generator wrote to
  with the feature tip merged in — which means the slice branch moved.
- B-04 then asserts that on gate failure "both the slice branch and the feature
  branch still exist at their pre-resolution tips". A test cannot make that true
  and B-03/B-07 true at the same time.
- B-10 adds a disposable worktree the module creates and removes, without
  saying whether the generator resolves there or somewhere else.

The prose does not settle it either: B-04 says branches are "left exactly as
they were", while P-02 uses the weaker and clearly-correct "both branches
survive". Please state, in one place: which worktree the generator resolves in,
whether resolving means merging the feature tip into the slice branch, whether
the generator commits, and what happens to that commit when the gates go red or
the retry conflicts. Then restate B-04's observable in terms the chosen model
can satisfy.

## Smaller things worth fixing in the same pass

- **B-06's scenario has no named cause.** Because B-05 holds the merge mutex
  across the whole round, nothing can move the feature tip between the proved
  tree and the retry, so "passes the gates but the retry conflicts again" needs
  a stated fixture lever (stubbed gate results over an unresolved tree is the
  obvious one). The test plan's "stub generator that resolves nothing" bullet
  lands on B-04's gate-failure path, not this one.
- **B-08 names the field two ways.** Its `then` says the payload records "its
  cost"; its observable and the contract body both say duration. Pick one.
- **B-05 should assert non-reentrancy.** Widening the critical section across a
  generator invocation is a defensible trade and it is recorded as such — but
  `mergeMutex` is one shared instance and is not documented as reentrant, so a
  path reached from inside the widened section that re-acquires it would hang
  the run instead of failing a gate. One sentence covers it.
- **No declared drop order.** Ten behaviors across eleven files is deliverable
  in one session, but B-08 (run-events variant plus a `run-summary.md` section)
  is the only part with no dependency on the merge path. Either name it as the
  deferrable tail or say the set is indivisible.
