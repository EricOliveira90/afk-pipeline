# Architecture review — round 4 (verification)

Scope: `git diff d45e31c..HEAD`, dispositioning the six open findings from
round 3. No resampling of the rest of the branch.

**Verdict:** ACCEPT-WITH-NOTES

One finding is resolved by the fix diff (A-05). Five are unchanged and stay
notes: none of them names a normal-operation reachable trigger, so under the
round-2+ prior-lineage branch none carries blocking authority.

## A-05 INCOMPLETE_WIRING — RESOLVED

`gatePolicy` now has a launch-time production reader. `src/orchestrator.ts:6401`
calls `resolveGeneratorTestCommand(repoRoot, resolveCheapGateCatalog(repoRoot),
config.testCommand)` in the run setup, before any wave; `resolveCheapGateCatalog`
(`src/base-gates.ts:154-155`) goes through `resolveTestCostPlan`, which calls
`loadGatePolicy(cwd)` (`:135`). `loadGatePolicy`
(`src/gate-policy.ts:748-758`) returns `null` only for "absent file / no
`gatePolicy` key" and otherwise propagates `parseGatePolicy`'s `Error`
(documented `:742`, exercised by `src/gate-policy.test.ts:548` and `:215`). A
second production reader consumes the `acceptance` member
(`src/base-gates.ts:290`), which is the member this branch added to
`afk.config.json`. So a malformed member now aborts the run at launch instead of
sitting inert. Clear condition met.

## A-01 TYPE_SAFETY — REPEATED (note)

`readGateEvidence`'s validator still checks `appliedWaivers[].riskClass` with
`typeof entry.riskClass === "string"` (`src/gate-runner.ts:1190`), while the
declared type is `GateRiskClass` (`:102`). `git show d45e31c:src/gate-runner.ts`
grepped for `riskClass` produces the same four lines as HEAD, so neither the
check nor its comment (`:1168-1172`) changed in the fix diff. The clear
condition's alternate branch ("documented as unvalidated at the boundary **and**
its consumer re-validates") is still half-met: the documentation exists, the
consumer does not — no writer populates `appliedWaivers` yet (#193). Note, not
a blocker: nothing reads the field, so there is no normal-operation trigger.

## A-02 DEAD_SEAM — REPEATED (note)

`ScopeComparisonSource`'s `{ kind: "role" }` arm (`src/scope-gate.ts:56-61`) is
still constructed only from `src/scope-gate.test.ts:333`. The single production
call site (`src/orchestrator.ts:5922-5936`) passes `kind: "candidate"`; a
repo-wide grep for `kind: "role"` returns those two hits only. Unchanged by the
fix diff.

## A-03 NAMING — REPEATED (note)

`SCOPE_GATE_STAGE = "deterministic"` (`src/scope-gate.ts:29`) still shares its
token with the QA review stage vocabulary, and the fix diff's `ARCHITECTURE.md`
change (gates row + the new gate-cost bullet) documents cost, not the stage
vocabulary; `CONTEXT.md` is untouched in the range. The new
`ACCEPTANCE_GATE_STAGE` comment (`src/gate-runner.ts:44-49`, "Its own stage, not
`deterministic`") is the closest thing to a distinction and lives in a module
doc comment, not in the documents the clear condition names.

## A-04 ABSTRACTION — REPEATED (note)

`GateDeclaration.run` still advertises `signal?: AbortSignal`
(`src/gate-runner.ts:120-124`) with no statement of who honours it, and
`runGates` still only checks `options.signal?.aborted` *before* the call
(`:667`) and passes the signal through (`:672-676`) — it does not enforce
cancellation around an in-process callee that ignores it. Neither the field's
doc comment nor the in-process branch gained the ownership sentence in this
diff.

## A-06 OBSERVABILITY — REPEATED (note)

`src/context-envelope.ts` and `src/contract-revision-evidence.ts` are absent
from `git diff --stat d45e31c..HEAD`, so the round-3 state stands: the
by-reference artifact classes are composed only into the overflow error string
(`src/context-envelope.ts:1032-1066`) and the omitted-region count only into the
evidence artifact's own heading (`src/contract-revision-evidence.ts:307-337`);
neither reaches the `prompt-assembly` run event. The fix diff's only run-event
change is additive and unrelated (`src/run-events.ts`: gate-cost markers and
`behavior-coverage`).

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"gatePolicy is shipped in afk.config.json with no launch-time reader, so its malformed-refuses-launch rule is not yet true","class":"INCOMPLETE_WIRING","clearCondition":"The first gatePolicy consumer loads and validates the policy at launch, so a malformed member refuses the run rather than being inert.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
