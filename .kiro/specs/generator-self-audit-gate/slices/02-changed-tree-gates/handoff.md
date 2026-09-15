# Handoff — 02-changed-tree-gates (#300)

## What shipped

- `B-01`: `src/self-audit.ts:runSelfAuditStage` — the record condition widened to
  both graded verdicts, so `AUDIT_CHANGED` writes one entry whose
  `candidateTreeId` (released) and `auditedTreeId` (post-audit) differ.
- `B-02`: `src/self-audit.ts:verifyAuditedTree` — mints the audited checkpoint
  through `createCheckpoint`, reports it through `onCandidateTree`, re-runs the
  selected declarations through `runGates`, returns `PASS` or `REPAIR`. The
  distinct-path half of the behavior lives at the hub's call site
  (`checkpointDir: \`${checkpointDir}-audited\``) and is asserted there, by
  `src/orchestrator.test.ts` `[behavior:#300:B-02]`.
- `B-03`: `src/self-audit.ts:selectAuditedGateDeclarations` — pure filter of the
  round's `preQaDeclarations` by the catalog's required ids, same objects.
- `B-04`: `src/self-audit.ts:verifyAuditedTree` (pass path) +
  `src/self-audit.ts:AuditedBaseGateEvidence` — a freshly built base-gate object
  naming the audited tree, behind
  `assertGateEvidenceReleasesEvaluation` / `verifyGateEvidence` on that tree.
- `B-05`: `src/orchestrator.ts:runSliceExecute` — the single `verifyAuditedTree(`
  call site, guarded on `selfAuditOutcome.verdict === "AUDIT_CHANGED"`.
- `B-06`: `src/orchestrator.ts:runSliceExecute` — the `audited.outcome ===
  "REPAIR"` sub-branch, into `stuckReferences` / `generatorFailureSet` /
  `retryNote` / `continue` / `candidateLifecycle.exhaustDeterministicGates`.
- `B-07`: `src/self-audit.ts:AuditedTreeVerificationInput` (no dispatch member)
  and the audit-to-QA region of `src/orchestrator.ts:runSliceExecute` (no
  `logger.bumpEvalRound`).
- `B-08`: `src/self-audit.ts:resolveGradedCandidate`.
- `B-09`: `src/orchestrator.ts:runSliceExecute` — `const gradedCandidate`, read by
  the deterministic dispatch, `writeApprovedBaseline`, the shared-preview stage
  and `runPostQAGates`'s `qaApprovedTreeId`.
- `B-10`: `src/orchestrator.ts:runSliceExecute` — the `onCandidateTree` callback
  bound to `implementationCandidateTreeIds.push`, called before the gate re-run.
- `B-11`: `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  Consequences — the changed-tree mechanism replaces the
  "changes nothing downstream" paragraph.
- `P-01`: `src/self-audit.ts:runSelfAuditStage` (declined and unchanged paths
  untouched); `src/self-audit.test.ts` `[behavior:#300:P-01]`.
- `P-02`: `src/orchestrator.ts:runSliceExecute` pre-audit `requiredFailures`
  branch, unedited; `src/orchestrator.test.ts` `[behavior:#300:P-02]`.
- `P-03`: `src/run-state.ts` untouched; `src/self-audit.test.ts`
  `[behavior:#300:P-03]`.
- `P-04`: `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts`,
  `src/gate-runner.ts` unedited; `src/orchestrator.test.ts`
  `[behavior:#300:P-04]`.
- `P-05`: the `runSelfAuditStage(` call site keeps its position;
  `src/orchestrator.test.ts` `[behavior:#300:P-05]` beside the existing
  `[behavior:#299:B-03]` scan.
- `P-06`: the pre-audit release sequence unedited;
  `src/orchestrator.test.ts` `[behavior:#300:P-06]`.
- New migration files: 0

## Decisions made during implementation

- `selectAuditedGateDeclarations` takes the catalog as a parameter rather than a
  `cwd`, so it is pure and testable from literals; the hub passes
  `resolveCheapGateCatalog(ctx.worktreeDir)`. The contract described the catalog
  read, not who performs it.
- The audited-`REPAIR` terminal exit deliberately does **not** call
  `logger.bumpEvalRound`, unlike the pre-audit failure exit at the same shape:
  B-07 forbids a round bump anywhere between the audit call site and the QA
  dispatch, and the audit spends no round of its own.
- `generatorFailureSet.gates` entries on the audited failure each carry the whole
  `evidenceReferences` list rather than a per-gate pair. `verifyAuditedTree`
  returns `failedGateIds` and a flat reference list, which is what the contract's
  B-06 wording ("from `failedGateIds` and those references") allows; pairing them
  per gate would have meant a richer return type the contract did not declare.
- `resolveGradedCandidate` is generic over the base-gate type so the same
  function serves the hub's `QABaseGateEvidence` and the module's structurally
  declared `AuditedBaseGateEvidence` without an import cycle. The hub pins the
  parameter explicitly (`resolveGradedCandidate<QABaseGateEvidence>`) because
  inference from `audited` alone would pick the narrower shape.
- The audited checkpoint's worktree is removed in the attempt's existing
  `finally` alongside the round's own checkpoint (the loop over a two-entry
  literal). Not named in the contract, but leaving a registered `git worktree`
  behind on every changed-tree round is not a behavior anyone chose.
- The audited checkpoint materializes only when a selected declaration carries a
  `command`, mirroring the pre-audit checkpoint's own predicate.
- Round 2 (QA-01, QA-02, QA-03): each of the three flagged assertions was moved
  to the seam where its claim can fail rather than restated. Distinctness of the
  audited checkpoint path is a call-site fact, so it is asserted as a call-site
  text scan; the P-01 non-minting claim is a type-and-call-site fact, so its
  unreachable spy was dropped and the observable consequence
  (`resolveGradedCandidate` yielding the pre-audit pair by reference) kept; the
  B-08 four-case loop became straight-line assertions plus the
  omitted-vs-explicit-`undefined` pair the hub actually passes.

## Gotchas / learnings

- `verifyAuditedTree`'s pass path calls the real `verifyGateEvidence`, which
  re-hashes the evidence and log files on disk. A unit harness therefore cannot
  hand it a hand-built `GateEvidenceArtifact`: bind `runGates` to a real
  `runCandidateGatePhase` over in-process (`run:`) declarations instead, which
  needs no toolchain, no git and no spawn.
- An in-process gate returning `{ status: "FAIL" }` with no `failureKind` writes
  evidence that `readGateEvidence` refuses ("Invalid gate evidence"): a `FAIL`
  must carry `failureKind: "COMMAND"` or `"CONFIGURATION"`.
- Source-order scans in this repo must normalize `\r\n` before slicing on
  `"\n}\n"` — the checked-out files are CRLF on Windows.
- `resolveCheapGateCatalog` was already imported in `src/orchestrator.ts` (the
  `--test-command` validation path), so the changed-tree path added no new
  module dependency to the hub.
- The pre-audit `treeId: checkpoint.treeId,` at the `runCandidateGatePhase(` call
  is now the file's **only** occurrence of that fragment, and
  `candidateTreeId: checkpoint.treeId,` its only two. A later slice that adds a
  consumer reading `checkpoint` directly will break the `[behavior:#300:B-09]`
  residual counts — which is the point.
- `implementationCandidateTreeIds.push(` now occurs exactly twice. The array's
  last entry is the tree under grading, which `src/post-qa-gates.ts`'s
  `.slice(0, -1)` on `priorAttemptTreeIds` depends on.
