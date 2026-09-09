# Architecture review — PRD 4 (acceptance and scope gates), round 1

**Scope read:** `git diff main...HEAD` (80 files, +10,440/-460), the two slice
contracts and manifests under
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/` (01 gate policy reader
#84, 08 file-scope gate #195), plus `prd.md` D1–D22 and
`anchors/08-file-scope-gate.md`. The branch also carries three merged
integration changes that are part of this diff and were reviewed as such:
#178/ADR 0061 (durable lineage + the one negotiation artifact repair pass),
#188 defect 4 (resume attempt charged at generator dispatch), #196
(revision-round delta evidence, contract pair by reference), and ADR 0063
(the wall-clock ratchet moved out of `pnpm test`).

**Verdict:** ACCEPT-WITH-NOTES

## What ships, structurally

The two slices land on the seam `ARCHITECTURE.md` already names — "a new
check is a declared gate with evidence, not an inline check in the
orchestrator" — and they widen it in the narrowest way that carries a
content-derived verdict:

- `GateDeclaration` gains `run`, resolved through one `classifyDeclaration`
  helper (`src/gate-runner.ts:335-372`) so the loop cannot read `command` and
  `run` as independent options. The four shapes (invalid / undeclared /
  in-process / command) reproduce today's split exactly, including the
  load-bearing `{ id: "lint", required: false }` → `SKIPPED` case that
  `src/adopt-command.ts:647-649` counts as passing (D22's 2026-09-08
  correction). I read the old and new branch side by side: an optional
  declaration with no command still records `SKIPPED` with the same detail
  string, and a blank `command` still records `FAIL`/`CONFIGURATION`.
- The in-process branch is placed ahead of the `existsSync(cwd)`,
  `prepareFailure` and `restoreCheckpoint` preconditions
  (`src/gate-runner.ts:537-596`), which is the only placement that works for a
  post-QA checkpoint captured with `materialize: false`
  (`src/post-qa-gates.ts:173-178`). A throw becomes `INFRASTRUCTURE`, not
  `FAIL`, so it reaches `candidate-gate-phase`'s bounded retry and then the
  operator instead of looping a generator on a fault no edit can fix
  (ADR 0041).
- `src/scope-gate.ts` composes rather than reimplements:
  `outOfScopeChangedPaths` (`src/escalation.ts`) keeps sole ownership of
  classification and its exemptions, `listChangedFiles` / `diffTreePaths`
  (`src/git.ts`) keep sole ownership of the changed set, and an unproven
  probe becomes `INFRASTRUCTURE` rather than an empty violation list
  (`src/scope-gate.ts:94-127`). That is D2 honoured literally: no second path
  normalizer, no second changed-set probe.
- The `acceptedPairIntact` attestation is *earned*, not asserted. It is
  declared inside the implementation-attempt iteration
  (`src/orchestrator.ts:5185`), reset at the top of every generator attempt
  (`:5188`) and set only after `mutatedAcceptedContractFiles` /
  `restoreAcceptedContractPair` found no mutation (`:5389-5392`). I traced
  every exit from that `while (true)`: the sole `break` is at `:5394`, after
  the latch, so a reordering that skipped the check would gate with `false`
  and name both pair files rather than exempting a lock the generator may have
  widened. This is the right direction of failure and the right place for the
  proof.
- The call site is one prepend (`src/orchestrator.ts:5830-5846`) and
  `src/post-qa-gates.ts`, `src/base-gates.ts`, `src/candidate-gate-phase.ts`
  and `src/acceptance-manifest.ts` are untouched, as the contract's definition
  of done requires. `decideCandidateGatePhase` classifies on `required`, not
  on stage (`src/candidate-gate-policy.ts:51-78`), so a red `scope` does
  become `REPAIR` and not a merge — the spawned assertion in
  `src/qa-orchestration.test.ts` proves it end to end (evidence order
  `["scope","tests"]`, `findings.outOfScopePaths`, zero accepted commits at
  the round-2 dispatch, one accepted commit at the end).
- Test-cost discipline held. The one new spawned scenario carries three `it`s
  off one `beforeAll` and says why no fixture reached the state; the rest are
  units in `src/scope-gate.test.ts` / `src/gate-runner.test.ts` or `it`s on
  existing fixtures. Where the gate made an old scenario impossible
  (`wave-migrations.test.ts`'s two-slices-one-undeclared-path add/add
  conflict), the fixture was reshaped to produce a *legitimate* conflict
  instead of the gate being weakened — the right response.

Nothing in the diff shows the shapes that would block: no duplicated
abstraction, no gate that can be skipped, no assertion deleted to reach
green, no schema bumped without a reader that accepts the old version
(`readGateEvidence` accepts 1 and 2 and refuses a version-1 document that
carries `findings`).

## Notes

### A-01 — the evidence reader validates `riskClass` as a bare string, defeating the reason the field is typed

`src/gate-runner.ts:963-999` (`isGateResult` → `isGateFindingsField`). The
type says `riskClass: GateRiskClass` and the contract's B-03 gives the reason:
"a bare `string` would let a persisted waiver name a class the policy reader
refuses". The parse boundary then checks `typeof entry.riskClass === "string"`,
so `readGateEvidence` can hand a caller a value typed `GateRiskClass` that is
not one. Evidence: I read both functions and confirmed no membership check
against `GATE_RISK_CLASSES`, which the sibling parser does perform
(`src/gate-policy.ts:265-277` throws on an unrecognised class). Unreachable
today — nothing populates `appliedWaivers` until #193 — so this is a note, not
a blocker. Recording it because #193 is the round that will read these records
back and is the round most likely to trust the type.

### A-02 — the `role` comparison source ships with no production caller

`src/scope-gate.ts:56-61`, `:100-110` (`{ kind: "role" }` / `diffTreePaths`).
Evidence: `Select-String` for `runScopeGate|scopeGateDeclaration` across
`src/` returns one production call site (`src/orchestrator.ts:5831`), and it
passes `{ kind: "candidate" }`. D4's tree-to-tree write-scope comparison is
therefore a seam exercised only by `src/scope-gate.test.ts`. Defensible — the
contract declares it (B-11) and a later slice consumes it — but a union arm
whose only consumer is a test tends to drift from what the eventual caller
needs. Worth a deliberate check when the first role write-scope call site
lands rather than assuming it fits.

### A-03 — gate stage `deterministic` overloads a token the QA lifecycle already owns

`src/scope-gate.ts:29` (`SCOPE_GATE_STAGE = "deterministic"`). Every existing
declaration uses stage `"base"` (`src/base-gates.ts:20` is the only `stage:`
literal in that module), while `deterministic` is already one of the two
values of the QA review stage union (`src/qa-review.ts:527`,
`src/qa-convergence.ts:493-494`), where it means "the deterministic QA
evaluator", not "a gate stage". The post-QA evidence document will now hold
results at stages `deterministic` and `base` in the same file. Nothing
switches on gate stage today — I checked every `.stage` reference outside
tests; the only consumers are the declaration↔result binding checks
(`src/gate-runner.ts:859`, `src/candidate-gate-phase.ts:167`) and reporting —
so this is naming drift rather than a defect. It is also `prd.md` D22's
instruction, so the fix is documentation: give the gate-stage vocabulary an
entry (CONTEXT.md already carries this repo's "same word, two meanings"
discipline) before #85, #86 and #193 add three more gates at the same stage.

### A-04 — an in-process gate receives `signal` and this one ignores it

`src/gate-runner.ts:551-556` passes `signal` into the closure;
`src/scope-gate.ts:171` is `run: () => runScopeGate(input)`, which drops the
whole context. Correct for this gate — the comparison is milliseconds and
`runGates` already checks `options.signal?.aborted` before entering it — but
the seam now advertises cancellation it does not enforce, and #85's
behavior-coverage gate and #86's cache are both expected to arrive through it.
A gate that spawns work inside `run` and ignores the signal would make
`CANCELLED` mean "after this gate finishes". Cheap to settle now with a
sentence in the `run` doc comment saying the callee owns cooperative
cancellation.

### A-05 — the repo now ships a `gatePolicy` block that nothing reads at launch

`afk.config.json:6-13` gains the policy; `loadGatePolicy`
(`src/gate-policy.ts:325`) has no non-test caller (verified by grep). So
`prd.md` D1's "an unknown member of `gatePolicy` is malformed and refuses the
launch" is not yet a property of the system: a typo in that block today is
inert. This is exactly what slice 01's contract says it is ("No consumer is
wired up"), so it is a note, not a scope violation — but the launch-refusal
claim in D1 is load-bearing for D5's security posture ("the actor being
constrained cannot author its own exemption"), and the first slice to read the
policy owns proving the refusal happens at launch rather than at first use.

### A-06 — the contract pair now travels by reference, and the envelope can no longer prove it was read

`src/context-envelope.ts:1382-1400`, `:1500-1520` replace the inlined pair
with `locatorExemption: CONTRACT_PAIR_BY_REFERENCE`, and
`src/contract-revision-evidence.ts:290-349` sizes the delta block to the room
the rest of the prompt leaves, dropping whole regions with a named omission
note when it must. The reasoning is recorded and the measurements are real
(70,899 bytes of one revision block against a 65,536-byte budget), and keeping
regions whole rather than truncating one is the right call — half a region
would put uncitable text in the prompt. The residual is a genuine change of
posture: the evaluator's judgment now depends on an agent opening two files,
which no assertion in the envelope can check, and on a revision round whose
evidence block may legitimately be incomplete. `validateRound2ContractReview`
still anchors a fresh finding's citation in the real artifacts
(`src/contract-review.ts:865-905`), which is the strongest guard available
here, so this is "I would have wanted an explicit dropped-region count in the
`prompt-assembly` event" rather than a defect. Worth watching for reviews that
cite only what the delta block happened to include.

## Checked and sound (no finding)

- Base attribution across siblings: `featureRef` is used verbatim and git's
  `<base>...HEAD` is `merge-base(base, HEAD)..HEAD`, so a sibling merged into
  the feature branch after this worktree was cut is not in the changed set and
  a merge-resolution round's base re-resolves for free (D3/B-14).
- `.afk/` is gitignored and `listChangedFiles` uses `--exclude-standard`, so
  orchestrator artifacts under the worktree cannot appear as violations.
- Fixture corrections declare the stub's own output path only, keep
  `undeclaredEdits` undeclared (`src/orchestrator.fixtures.ts:579`), and skip
  migration outputs (exempt by pattern), so the negative cases the gate exists
  for are still reachable in spawned scenarios.
- #188 defect 4: the charge is a single latch armed in `prepareSliceWorktree`
  and called once immediately before the generator `invoke`
  (`src/orchestrator.ts:5304`), the state write is read-modify-write inside the
  lock (`src/run-state.ts:1132-1145`), and a fresh worktree resets the count.
  The one-off over-report in `reportSliceBounds` is documented at the line.
- ADR 0063: `test:budgets` left `pnpm test` and became `test:ratchet`, with
  `AGENTS.md`, `CLAUDE.md`, `suite-budgets.json` and the script header all
  updated to say so. The rationale (a host measurement must not be able to
  turn a deterministic gate red) is consistent with how the gates are used.

## Structured findings (v2)
{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-05","title":"gatePolicy is shipped in afk.config.json with no launch-time reader, so its malformed-refuses-launch rule is not yet true","class":"INCOMPLETE_WIRING","clearCondition":"The first gatePolicy consumer loads and validates the policy at launch, so a malformed member refuses the run rather than being inert.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true}]}
