# Architecture review — round 7 (verification)

Scope: `git diff d0ab4fc..HEAD` (slice 04 "Final evaluation and reuse":
`src/final-evaluation.ts`, `prompts/evaluator-final.md`, orchestrator wiring,
run-state v5, change-summary baseline→final variant, ARCHITECTURE.md, ADR 0065).
Round 1 read the branch; this round only dispositions the five open findings.

## Disposition of open findings

**[A-01] TYPE_SAFETY — REPEATED.** `src/gate-runner.ts` is not in the fix diff
(`git diff --stat d0ab4fc..HEAD` lists no `gate-runner.ts`). The evidence reader
still admits `appliedWaivers[].riskClass` on `typeof entry.riskClass === "string"`
alone (`src/gate-runner.ts:1170-1190`, comment "checked as a string only"), while
the in-memory type is `GateRiskClass` (line 102). No consumer re-validation was
added. Note only: reading back an unvalidated risk-class token cannot be reached
by a normal-operation path that the reviewed diff introduced, and evidence is
advisory rather than authorizing.

**[A-02] DEAD_SEAM — REPEATED.** `ScopeComparisonSource`'s `{ kind: "role" }`
member (`src/scope-gate.ts:56-61`) still has no production caller. `grep -n
'kind: "role"' src/*.ts` matches only `src/scope-gate.test.ts:333`. Notably the
fix diff *adds* a new scope-gate call site — the final-candidate re-run at
`src/orchestrator.ts:~6920` — and it uses `kind: "candidate"`, which is correct
for that question but confirms the role branch remains test-only. Note.

**[A-03] NAMING — REPEATED.** `SCOPE_GATE_STAGE = "deterministic"`
(`src/scope-gate.ts:29`) still collides with the QA-side stage vocabulary
(`src/artifacts.ts:678` maps `stage === "deterministic"` into the review-stage
space; `src/accepted-candidate.ts:62-77` uses `deterministic-qa` /
`post-qa-deterministic`). The ARCHITECTURE.md hunk in this diff documents only
the final-evaluation module and the baseline→final change-summary variant; it adds
no gate-stage-vocabulary section, and nothing was renamed. Note.

**[A-04] ABSTRACTION — REPEATED.** `GateDeclaration.run` and `runGates` are
unchanged (`gate-runner.ts` absent from the fix diff), so the advertised
cancellation signal is still neither documented as callee-owned nor enforced
around the call. The new final-evaluation gate run threads `signal` into
`runPostQAGates` in the usual way, which does not change the seam's contract.
Note; a declaration that overruns cancellation is bounded by the surrounding
wall-clock timeout rather than corrupting durable state.

**[A-06] OBSERVABILITY — REPEATED.** `RoleEnvelopeEvidence`
(`src/context-envelope.ts:764-771`) still carries only
`role/assembledByteSize/includedArtifactClasses/includedArtifactIds/omittedArtifactClasses/contextManifestVersion`
— no by-reference pair record and no count of omitted revision regions. The
context-envelope change in this diff is additive and manifest-only: it declares
`FINAL_EVALUATOR_CONTEXT_MANIFEST` and widens `ContextEnvelopeRole` with
`"evaluator-final"`, explicitly "manifest-only … no assembly path consumes it
yet". Note.

## Notes on the fix diff itself (no new blocking findings)

The new slice keeps to the branch's established seams rather than opening new
ones, and the structural decisions I would have flagged are the ones it already
took: reuse is exact tree equality with no cosmetic exception; the final scope
gate re-runs on the post-approval tree instead of inheriting the accepted
candidate's evidence (ADR 0010-style tree-keyed evidence, ARCHITECTURE.md "a new
check is a declared gate with evidence"); the final evaluator's copy-back is
admitted through the single existing `QA_WINDOW_ARTIFACT_NAME` allowlist
(`src/post-qa-gates.ts`) rather than a second dialect of the same list; and
`buildFinalChangeSummary` is a variant of the one `(cwd, fromRef, toRef)` builder
rather than a second producer, as ARCHITECTURE.md's "Single-owner seams" requires.
`src/final-evaluation.ts` is a new module in its own ARCHITECTURE.md row instead of
growing the orchestrator hub, though the orchestrator hunk (+769) is the largest
single addition on the branch and is the place a future extraction should start.

## Verdict rationale

All five open findings are REPEATED and all five carry `reachableTrigger: null`
from prior rounds; re-reading the current tree gave me no concrete
normal-operation trigger for any of them. Under the round-2-or-later prior-lineage
branch, continuing authority requires a non-blank reachable trigger, so each is a
note. No later-new INTEGRITY or DATA_LOSS finding arose from the fix diff.

**Verdict:** ACCEPT-WITH-NOTES

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
