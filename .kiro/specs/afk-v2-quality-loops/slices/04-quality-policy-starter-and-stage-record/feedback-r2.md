# Contract review — round 2

The revision is lockable. All four findings from round 1 are resolved, and the
revision introduced no new gap that would block a generator.

## The blocking one (F-01) is genuinely closed

Round 1's problem was an orphan spawned bullet: the only way `enabled: true`
could ever be produced was a fixture repo `afk.config.json` that no `fileScope`
path authorized. The revision solves it by moving the derivation, not the
fixture. `buildQualityStagePolicyEvent(policy: GatePolicy | null)` becomes a
pure exported helper in `src/run-events.ts`, B-06's single emission site is
bound to it as its only payload source, and the enabled branch is proved at
unit level against the policy `parseGatePolicy` returns for the template this
same slice ships. Every path involved — `src/run-events.ts`,
`src/logger.test.ts`, `templates/quality-policy/afk.config.json` — was already
in `fileScope`, which stays at the same ten paths. No fixture repo is edited,
no new spawn is added, and P-01's root config stays untouched.

That is not one of the two options the finding listed, and it is the better
one. Turning the cleaner on inside a spawned scenario that exists to assert
something else would have bought a real-stream `enabled: true` at the cost of
perturbing an unrelated fixture; the helper gets both branches proved cheaply
and leaves the real-stream job to what a spawned run can honestly show. The
wiring is still covered: the unchanged `src/orchestrator-runs.test.ts` bullet
reads the emitted event's `stage`, `enabled`, `gateIds` and `source` out of a
real `events.jsonl`, so the helper cannot pass its unit tests while the
emission site emits something else. The new definition-of-done line pins the
export, the single-payload-source rule and both branch tests.

One note, not a finding: the B-07 unit tests live in `src/logger.test.ts`
although the helper lives in `src/run-events.ts`. The contract explains this
(the slice's other `src/run-events.ts` pin — the `EVENTS_SCHEMA_VERSION`
assertion — is already there), both files are in `fileScope`, and the behavior
anchor makes the test selectable either way.

## The three advisories

**F-02.** `gatePolicyPaths` and `testGlobs` are now literal in the contract,
the manifest and the definition of done, asserted element-for-element rather
than "the member parses". The citations were checked against the working tree
and all hold: `DEFAULT_GATE_POLICY_PATHS` is exactly
`["afk.config.json", "suite-budgets.json"]` at `src/gate-policy.ts:162-165`,
`DEFAULT_TEST_GLOBS` is `["**/*.test.ts"]` at `:168`, and
`src/feedback-integrity-gate.ts:255`/`:265` are the exact-path classification
the contract says they are. The explorer's UNKNOWN is retired by evidence, not
by prose.

**F-03.** The pass/fail clause moved to the non-goals, which is the honest
place for it: the guarantee is the absence of any new reader, and the non-goal
says so in those words. B-02's `then` no longer carries a clause no assertion
observes.

**F-04.** The README placement is demoted to a recorded decision explicitly
marked editorial and not gated, and the manifest states that ordering relative
to `## Setting up guardian reviews` is deliberately unasserted. A later editor
can move the section without breaking a test, which is the right outcome for a
doc-placement choice.

## One new advisory (F-05)

B-02's `then` claims each of the seven gates carries `command`, `args`, an
explicit `required` setting and `expectedCostMs`, but the `observableResult`
observes only the count, the ids, `required` and the `{changedFiles}` token.
`required` is safe to leave to the parser — `parseCleanGate` throws on a
non-boolean (`src/gate-policy.ts:893`). `expectedCostMs` is not:
`src/gate-policy.ts:904-911` defaults a missing value to
`DEFAULT_CHEAP_THRESHOLD_MS`. So a template whose gates omit the field parses
cleanly under B-01 and satisfies every assertion B-02 states, while the `then`
says otherwise.

This is a different clause from F-03 — that one was about what `expectedCostMs`
may decide, this one about whether the template declares it at all. It costs a
single assertion in the B-02 unit test that already reads the gate list, so it
does not stand in the way of a lock; fold it in when the generator writes that
test.
