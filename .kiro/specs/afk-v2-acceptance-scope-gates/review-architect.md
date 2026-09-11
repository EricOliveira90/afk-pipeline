# Architecture review — round 6 (verification)

Scope: `git diff e84068df..HEAD` (the fix diff for slice 07, "Feedback
integrity and gate-scope revisions") dispositioned against the five open
findings. No resampling of the rest of the branch.

**Verdict:** ACCEPT-WITH-NOTES

The fix diff is a substantial, coherent slice: `src/afk-manifest.ts` (waiver
reader), `src/feedback-integrity-gate.ts` (new deterministic gate),
`src/skip-gate.ts` (launch waivers honored on both trees), `src/run-state.ts`
(v4 `appliedWaivers`), `src/escalation.ts` (schema 2 with gate evidence),
`src/artifacts.ts` (STUCK diagnosis reads both schema versions), plus the
orchestrator wiring at `src/orchestrator.ts:6363-6480`. Nothing in it addresses
the five open findings, and every one of them remains a note under the round-6
rubric: none names a normal-operation reachable trigger and none was introduced
by the reviewed diff. So: ACCEPT-WITH-NOTES, no blockers.

## Dispositions

### A-01 TYPE_SAFETY — REPEATED
`src/gate-runner.ts` is untouched by the fix diff (`git diff --stat` lists no
`gate-runner.ts`). Its evidence validator still reads
`typeof entry.riskClass === "string"` (`gate-runner.ts:1190`), and the TSDoc
above it (`:1170-1171`) still justifies that with "this slice populates no
waivers" — which the fix diff has now falsified: both `runSkipGate`
(`skip-gate.ts`, `appliedWaivers` in `findings`) and
`runFeedbackIntegrityGate` (`feedback-integrity-gate.ts:241`) populate it.

The clear condition's alternative branch — consumer re-validates — is not met
either. `appliedWaiversFrom` (`feedback-integrity-gate.ts:126-146`) copies
`waiver.riskClass` straight into a `ProtectedChangeWaiver`, whose `riskClass`
is `GateRiskClass`, with no membership check; and the new persistence
(`run-state.ts`, `PersistedAppliedWaiver.riskClass: string`) widens it back to
a bare string. So a hand-edited or future-written evidence file can put an
unknown class into `run-state.json` and the summary's Applied Waivers rows.
Note, not blocker: the reader that decides *authorization* is
`parseAfkManifest`, which does validate against `GATE_RISK_CLASSES`
(`afk-manifest.ts:120`), so no normal-operation path grants a waiver from an
unvalidated class — the leak is confined to reporting.

### A-02 DEAD_SEAM — REPEATED
`scope-gate.ts:56-60` still declares the `kind: "role"` comparison source, and
`Select-String 'kind: "role"' src\*.ts` finds exactly two hits: the
declaration and `scope-gate.test.ts:333`. Still no production caller; the fix
diff added none.

### A-03 NAMING — REPEATED
The fix diff touches no documentation that could distinguish the vocabularies
(`--stat` shows only `agents/generator.md` and four `prompts/*.md`, none of
which is CONTEXT.md or ARCHITECTURE.md). The `deterministic` gate stage token
and the QA review stage union remain undocumented against each other; the only
doc mention found is `docs/adr/0037` line 37, which uses the phrase for the
review stage.

### A-04 ABSTRACTION — REPEATED
`GateDeclaration.run` still advertises `signal?: AbortSignal`
(`gate-runner.ts:123`), and `runGates` still only checks
`options.signal?.aborted` *before* dispatch (`:667`) and forwards the signal
(`:675`) without enforcing anything around the awaited call. Unchanged by the
fix diff; the new `feedbackIntegrityGateDeclaration` is one more synchronous
`run` implementation that ignores the signal, which is consistent with the
existing gates but confirms the seam's promise is still callee-owned and
undocumented.

### A-06 OBSERVABILITY — REPEATED
`run-events.ts`'s `prompt-assembly` payload still carries only
`includedArtifactClasses` / `includedArtifactIds` / `omittedArtifactClasses`
(`:97-107`); the fix diff's only `run-events.ts` change is the new
`waiver-applied` payload. There is still no field recording the by-reference
contract pair (`context-envelope.ts:1048-1076` computes `byReference` for the
human-readable line only) nor a count of omitted revision regions.

## Notes on the fix diff itself (not findings)

- The waiver-journalling loop (`orchestrator.ts:6439-6480`) re-reads the
  written evidence rather than trusting the in-memory outcome, and swallows an
  unreadable artifact with `continue` while `verifyGateEvidence` owns the
  refusal. That is the right layering.
- `skip-gate.ts` applies waivers to the base scan as well as the candidate,
  with the reason recorded inline. Applying them to only one side would have
  been the classic asymmetry bug; good that the comment says so.
- `run-state.ts` keeps `appliedWaivers` beside `slices` with the ADR 0018
  reason spelled out, and `sanitizeAppliedWaivers` degrades to absent rather
  than throwing. Consistent with `sanitizeMigrationClaims`.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Gate evidence reader validates appliedWaivers.riskClass as a bare string, not against GATE_RISK_CLASSES","class":"TYPE_SAFETY","clearCondition":"readGateEvidence validates each appliedWaivers[].riskClass against GATE_RISK_CLASSES (or the field is documented as unvalidated at the boundary and its consumer re-validates).","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"scope-gate's role comparison source has no production call site","class":"DEAD_SEAM","clearCondition":"The role write-scope source has a production caller, or is removed until one exists.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Gate stage token 'deterministic' collides with the QA review stage vocabulary","class":"NAMING","clearCondition":"The gate-stage vocabulary is documented distinctly from the QA review stage union (CONTEXT.md or ARCHITECTURE.md), or the gate stage is renamed.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"GateDeclaration.run advertises a cancellation signal the seam does not enforce","class":"ABSTRACTION","clearCondition":"The run seam documents that the callee owns cooperative cancellation, or runGates enforces it around the call.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"Contract pair travels by reference and revision evidence may drop regions, with no run-event record of what was dropped","class":"OBSERVABILITY","clearCondition":"The prompt-assembly evidence records the by-reference pair and the count of omitted revision regions for the round.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false}]}
