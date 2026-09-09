# Contract review — round 3 (05-test-cost-split-and-caching)

Both prior findings are resolved. The contract pair is accepted.

## F-14 — evidence-version bump vs. declared file scope

Resolved. The unconditional bump of `GATE_EVIDENCE_VERSION` to `3` is now
survivable inside the declared scope:

- `src/acceptance-gate.test.ts` is declared in `## Files expected to change`
  (contract.md:236) and in the manifest's `fileScope.paths`
  (acceptance-manifest.json:14).
- The version-3 result is named observably twice — the Test plan scenario at
  contract.md:312-319 and the DoD item at :349-355 both assert that
  `src/gate-runner.test.ts:629`, `:978-979` and `src/acceptance-gate.test.ts:326`
  read `3` and are green.
- The `## Changes to existing behavior` bullet at :218-224 bounds the authorized
  edit to that one assertion, recording that `:134`'s `version: 2` is an
  acceptance-manifest document, not gate evidence, and stays `2`.

I checked the enumeration against the tree rather than taking it on faith. The
gate-evidence version is asserted in exactly three places —
`src/gate-runner.test.ts:629` and `:979` (`expect(result.evidence.version)` and
`expect(GATE_EVIDENCE_VERSION)`) and `src/acceptance-gate.test.ts:326` — and all
three files are now in scope. Nothing else in `src/` asserts it; the other
`version: 2` literals (for example `src/orchestrator.fixtures.ts:342`) are
acceptance-manifest documents, unaffected by the bump. So the slice can be both
green and inside scope, which is what the finding asked for.

One correction to the planner's response, which does not change the verdict: the
claim that "B-03's observableResult carries the same three assertions" does not
hold — B-03's `observableResult` still reads only "src/gate-cache.test.ts and
src/gate-runner.test.ts assert no process spawned and the reuse marker;
src/logger.test.ts asserts the reuse line", with no mention of
`src/acceptance-gate.test.ts:326`. The condition is met by the Test plan scenario
and the DoD item instead, both of which name the assertion and its file
explicitly. Worth knowing so the next round's evidence points at the text that
actually carries the claim.

## F-15 — reader side of version 3

Resolved. The contract now decides the reader side rather than delegating it:
`SUPPORTED_GATE_EVIDENCE_VERSIONS` becomes `[1, 2, 3]`, the version-1 branch at
`src/gate-runner.ts:835` is unchanged, and the version-keyed rule at
`src/gate-runner.ts:22-27` is rewritten to "version 1 may not carry `findings`;
version 2 and version 3 may", with a version-3 document behaving exactly as a
version-2 one because this slice adds no findings semantics. The docstring is
told to record both bumps. The Test plan (:312-319) asserts the accepted set and
the two refusals that survive, and the DoD (:349-355) locks the list, the rule
and the three assertions together.

This is consistent with the code as it stands: the enforcing branch at
`src/gate-runner.ts:834-841` keys on `version === 1`, so accepting a version-3
document that carries `findings` needs no logic change — only the accepted-version
list and the prose. Note the contract attributes the version check to
`verifyGateEvidence` (`:804-807`); the check actually lives in
`readGateEvidence`, which `verifyGateEvidence` calls at `:860`. The behavior
described is right, so this is a labelling detail, not a defect.

## Non-blocking observation

The "only version 2 may carry `findings`" rule is spelled a second time in the
enforcing code comment at `src/gate-runner.ts:830-833` and in the thrown message
at `:839` ("findings require version 2"). The contract names only the docstring
at `:22-27`, so those two strings will read slightly stale once version 3 may
also carry `findings`. Behavior is unaffected — the branch keys on version 1 —
and both lines are inside a file already in scope, so this is a wording cleanup
the implementation can take in passing. It is not a finding.
