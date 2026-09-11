# Architecture review — round 5 (verification)

Scope: `git diff c77c54a..HEAD` (slice 03 candidate-evaluator isolation, slice
06 merge-resolution round, the #230/#232 fixes, ADR 0064), dispositioning the
five open findings from round 4. No resampling of the rest of the branch.

**Verdict:** ACCEPT-WITH-NOTES

None of the five open findings is cleared by the fix diff, and none names a
normal-operation reachable trigger, so under the round-2+ prior-lineage branch
none carries blocking authority. All five stay notes; no new findings.

## A-01 TYPE_SAFETY — REPEATED (note)

`src/gate-runner.ts` is absent from `git diff --stat c77c54a..HEAD`. Grepping
`riskClass` in the current tree gives the unchanged shape: the declared type is
`GateRiskClass` (`:102`) while `readGateEvidence`s validator still accepts any
string (`:1190`), with the boundary comment at `:1168-1172`. The alternate clear
branch stays half-met — documented, but no consumer re-validates, because no
writer populates `appliedWaivers` yet (#193). Nothing reads the field, so there
is no normal-operation trigger.

## A-02 DEAD_SEAM — REPEATED (note)

`src/scope-gate.ts` is not in the fix diff. A repo-wide grep for `kind: "role"`
still returns exactly two hits: the type arm (`src/scope-gate.ts:57`) and the
test that constructs it (`src/scope-gate.test.ts:333`). The single production
call site still passes `kind: "candidate"`.

## A-03 NAMING — REPEATED (note)

`SCOPE_GATE_STAGE = "deterministic"` (`src/scope-gate.ts:29`) is unchanged.
`CONTEXT.md` is untouched in the range. `ARCHITECTURE.md` did change, but the
added rows and bullets cover the merge-resolution module, candidate review
isolation, and the change-summary builder — not the gate-stage vocabulary
against the QA review stage union. Clear condition unmet.

## A-04 ABSTRACTION — REPEATED (note)

Unchanged file. `GateDeclaration.run` still advertises `signal?: AbortSignal`
(`src/gate-runner.ts:123`) with no ownership statement, and `runGates` still
only checks `options.signal?.aborted` before the call (`:667`) and forwards the
signal (`:675`); no enforcement wraps an in-process callee that ignores it.

## A-06 OBSERVABILITY — REPEATED (note)

The `prompt-assembly` payload (`src/run-events.ts:97-107`) is unchanged by the
fix diff: it carries `includedArtifactClasses`, `includedArtifactIds`,
`omittedArtifactClasses` and byte size, and neither the by-reference contract
pair nor a count of omitted revision regions. `src/contract-revision-evidence.ts`
is absent from the diff stat, so its omitted-region count still reaches only the
evidence artifacts own heading. The only run-event additions in this range are
`approved-baseline`, `reviewer-write-violation` and `merge-resolution-round`
(`src/run-events.ts:202-262`) — additive and unrelated.

Worth noting in the same lineage rather than as a new finding: the #230 repair
projection now drops content deliberately (fenced copies replaced by pointers,
older commits truncated by `boundRepairSituationCommitLog`,
`src/context-envelope.ts`). The drop count is named inline in the prompt prose
and the `locatorExemption` string, so the omission is visible to the reader but
still not to the `prompt-assembly` record — the same gap A-06 already describes,
now on a second path.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
