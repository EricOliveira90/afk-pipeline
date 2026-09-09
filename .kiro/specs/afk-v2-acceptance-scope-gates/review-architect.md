# Architecture review — PRD 4 (acceptance and scope gates), round 3 (verification)

**Scope read:** `git diff 54712fab..HEAD` — 4 files, +70/-9:
`src/artifacts.ts` (`parseGuardianReview`), `src/artifacts.test.ts`,
`prompts/architect-review.md`, `prompts/pm-review.md`. Plus a re-check of the
six open findings against the current tree. I did not resample the rest of the
branch.

**Verdict:** ACCEPT-WITH-NOTES

## The fix under review

The fix is the guardian-artifact parser tolerating a blank line between the
`## Structured findings` heading and the JSON body, with both prompts reworded
to match. Structurally this is the right shape and the right place:

- The widening is a whitespace skip and nothing else
  (`src/artifacts.ts:352-366`): the loop advances only over lines whose `trim()`
  is empty, then the single existing `jsonLine` path takes over unchanged. The
  fail-closed exits below it (absent body, blank-only body, prose body,
  non-object JSON, extra keys, verdict/findings inconsistency) are untouched, so
  the accepted language grows by exactly the ignorable characters. The comment
  at the site states the reason (an `UNPARSEABLE` guardian verdict is terminal
  per ADR 0015, so whitespace was blocking ships) rather than leaving a future
  reader to guess why adjacency was dropped.
- The test edit is a net tightening, not a relaxation. The old
  "heading followed by a blank line" case was removed from the invalid list —
  correct, it is now valid — and three new invalid cases replace it: heading
  with the body deleted, heading followed by blank lines only, and prose where
  the JSON belongs (`src/artifacts.test.ts:1180-1190`). The positive case
  covers `\n\n`, `\n\n\n` and `\n   \n` for both guardian dialects and asserts
  findings survive the gap. Fresh evidence: `pnpm vitest run
  src/artifacts.test.ts -t "findings"` passes (2 tests, 58 skipped).
- Cost discipline held: two unit `it`s on an existing `describe`, no new
  spawned scenario (AGENTS.md / CLAUDE.md "where a new assertion goes").
- Prompt and parser moved together, so the contract text and the reader still
  agree — the failure mode that produced this bug was exactly the two drifting.

No new finding. The one behavior worth naming and dismissing: skipping blanks
could in principle swallow a *missing* findings block by reading a later line
as the body, but only the first non-blank line is examined, and a section
heading or prose there still returns `UNPARSEABLE` — the two new invalid cases
pin that.

## Disposition of the open findings

The fix diff touches `src/artifacts.ts`, `src/artifacts.test.ts` and the two
prompt files only (`git diff --stat`), and the only commits in range are
`e5ede23` plus its merge. None of the six findings' subjects
(`src/gate-runner.ts`, `src/scope-gate.ts`, `afk.config.json`,
`src/context-envelope.ts`, `src/contract-revision-evidence.ts`, CONTEXT.md /
ARCHITECTURE.md) changed. I re-verified each clear condition against the
current tree rather than inferring it from the diff:

- **A-01 — REPEATED.** `src/gate-runner.ts:976-999` (`isGateFindingsField`)
  still checks `typeof entry.riskClass === "string"`; `GATE_RISK_CLASSES`
  appears in `src/gate-policy.ts:52,268,310` and in tests only, never in the
  evidence reader. The clear condition's alternative branch (documented as
  unvalidated at the boundary *and* the consumer re-validates) is half met —
  the comment at `:971-975` says the policy reader owns the vocabulary — but
  there is still no consumer, so no re-validation exists to point at. Note:
  nothing populates `appliedWaivers` until #193, so no normal-operation
  trigger reaches the unvalidated value.
- **A-02 — REPEATED.** `scopeGateDeclaration` still has exactly one production
  call site (`src/orchestrator.ts:5831`) and it passes `{ kind: "candidate" }`;
  `kind: "role"` appears at `src/scope-gate.ts:57` and in
  `src/scope-gate.test.ts:333` only. Unconsumed union arm, unchanged.
- **A-03 — REPEATED.** `SCOPE_GATE_STAGE = "deterministic"`
  (`src/scope-gate.ts:29`) is unchanged and no gate-stage vocabulary entry was
  added to CONTEXT.md or ARCHITECTURE.md (grep for "gate stage"/"stage
  vocabulary" finds none). Naming drift only — nothing switches on gate stage.
- **A-04 — REPEATED.** `src/scope-gate.ts:171` is still
  `run: () => runScopeGate(input)`, and the `run` doc comment
  (`src/gate-runner.ts:78-87`) still advertises `signal` without saying who
  owns cooperative cancellation.
- **A-05 — REPEATED.** `loadGatePolicy` (`src/gate-policy.ts:325`) still has no
  non-test caller, so the shipped `gatePolicy` block in `afk.config.json` is
  still inert at launch. As slice 01's contract says it is; the first consumer
  owns proving launch-time refusal.
- **A-06 — REPEATED.** `CONTRACT_PAIR_BY_REFERENCE` is still applied at
  `src/context-envelope.ts:1385,1390,1512,1517`, and the omission count
  computed at `src/contract-revision-evidence.ts:307` is still not surfaced in
  the `prompt-assembly` evidence. Observability gap, unchanged.

All six carry `reachableTrigger: null` from round 1 and I found no
normal-operation trigger for any of them this round: A-01 and A-05 are
unreachable until their first consumer lands, A-02 is test-only, A-03 is
vocabulary, A-04 is a doc-vs-seam gap on a gate that finishes in
milliseconds, and A-06 is a missing record rather than an incorrect one. Under
the prior-lineage branch of the rubric a continuing block requires a non-blank
reachable trigger, so none of them blocks. They stay notes, addressed by the
slices that first consume the seams (#85, #86, #193).

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"gatePolicy is shipped in afk.config.json with no launch-time reader, so its malformed-refuses-launch rule is not yet true","class":"INCOMPLETE_WIRING","clearCondition":"The first gatePolicy consumer loads and validates the policy at launch, so a malformed member refuses the run rather than being inert.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
