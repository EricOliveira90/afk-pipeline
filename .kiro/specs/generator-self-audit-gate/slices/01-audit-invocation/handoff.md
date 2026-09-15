# Slice 01 — audit invocation (#299)

## What shipped

- B-01: `src/cli-options.ts:parsePipelineRuntimeOptions` (`selfAudit`, exact `--self-audit` token) and `src/orchestrator.ts:PipelineConfig.selfAudit`
- B-02: `src/self-audit.ts:runSelfAuditStage` (the two decline paths)
- B-03: `src/orchestrator.ts:runSliceExecute` (the single `runSelfAuditStage` call site, between the gate-release assertion and the deterministic QA dispatch)
- B-04: `src/context-envelope.ts:SELF_AUDIT_CONTEXT_MANIFEST` and `src/context-envelope.ts:PromptAssemblyRole` (`"generator-audit"`)
- B-05: `src/context-envelope.ts:assembleSelfAuditEnvelope`
- B-06: `src/context-envelope.ts:assembleContextEnvelope` (the existing stricter-only clamp, exercised through the audit envelope)
- B-07: `prompts/generator-audit.md`
- B-08: `src/self-audit.ts:classifySelfAuditVerdict`
- B-09: `src/self-audit.ts:runSelfAuditStage` (the `AUDIT_UNCHANGED` path end to end, including the `recordSelfAuditOutcome` write)
- B-10: `src/run-state.ts:RUN_STATE_VERSION` (7), `src/run-state.ts:PersistedSelfAuditOutcome`, `src/run-state.ts:selfAuditsFor`, `src/run-state.ts:recordSelfAuditOutcome`, `src/run-state.ts:sanitizeSelfAudits`, `src/run-state.ts:adaptLoadedState`
- B-11: `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
- P-02: `src/orchestrator.ts:runSliceExecute` (the `requiredFailures.length > 0` branch, unchanged), observed by `src/orchestrator.test.ts`'s `[behavior:#299:P-02]` source-order scan of that branch
- P-03: `src/run-state.ts:adaptLoadedState` (the v6 → v7 additive path) plus the four moved version pins in `src/run-state.test.ts`, `src/eval-boundary.test.ts`, `src/qa-orchestration.test.ts` and `src/qa-orchestration-gates.test.ts`
- New migration files: 0

## Decisions made during implementation

- **The change summary travels as a thunk.** `SelfAuditStageInput.changeSummary` is `() => string`, supplied by the hub as `git.logCommitsWithStat(ctx.worktreeDir, featBranch)`. `writeCandidateChangeSummary` runs inside `runQAStage` — *after* the audit call site — so no change-summary artifact exists at the point the audit is dispatched, and the hub has to derive it. A supplier rather than a string keeps the flag-absent gates-passed branch behaving exactly as it did before this stage existed: a declined audit spends no `git log`.
- **The locked pair and the handoff travel by path; only the change summary is inlined.** All three files sit in the audit's own worktree, and ADR 0068's rule is that an envelope must not inline a file the role can open itself. They are wired as backticked-path locators, which also means the change summary is the only block the byte budget can bite on — which is what makes B-06's two budget cases reachable from real inputs rather than from a synthetic prompt.
- **`JournaledAssemblyRole` kept two out-of-scope files out of the diff.** Widening `PromptAssemblyRole` with `"generator-audit"` broke assignment of `RoleEnvelopeEvidence` into `ContextEnvelopeInvocationEvidence`, whose `role` union is duplicated literally in `src/agent-provider.ts` — and both that file and `src/contract-prompt-orchestration.ts` are outside this slice's file scope. `RoleEnvelopeEvidence` and `RoleEnvelopeResult` are now generic in the role with `JournaledAssemblyRole = Exclude<PromptAssemblyRole, "generator-audit">` as the default, so every bare reference still means exactly what it meant before the union grew, and `assembleContextEnvelope` is generic in `R`. No scope escalation was needed.
- **The audit re-dispatches as `role: "generator"`.** ADR 0002 and ADR 0007 keep one `AgentProvider` interface; this is one more generator invocation with a different prompt, not a new agent role. Its log stream is opened lazily inside the injected `dispatch`, so a declined audit leaves no empty log file.
- **No `contextEnvelope` is passed to the audit `invoke(...)`.** A new `prompt-assembly` event for the audit is an explicit non-goal of this slice, so the envelope is assembled and dispatched but not journaled.
- **An envelope configuration fault degrades to `AUDIT_NOT_RUN`.** `dispatchAudit` catches assembly and dispatch failures and reports `{ completed: false, detail }` rather than throwing. The gate may add scrutiny and may never block a run by its own failure, so a manifest bug costs the run its audit and nothing more.
- **Absent base-gate `candidateTreeId` counts as disagreement.** `QABaseGateEvidence.candidateTreeId` is `string | undefined`; the stage's input type is `{ readonly candidateTreeId?: string | undefined }` and an absent id declines, because an audit of a tree no released evidence names is an audit of the wrong thing.
- **Only `AUDIT_UNCHANGED` is persisted here.** The persisted shape admits all three verdicts so neither sibling slice needs a second version bump, but the changed-tree path is #300's and the dead-invocation taxonomy is #301's.
- **B-05's out-of-order case is observed through `assembleContextEnvelope`.** The acceptance manifest's "when" says the envelope is assembled "through `assembleContextEnvelope`", so the reordered-render case feeds the same four locators and a deliberately reversed prompt into the generic assembler; the genuine template's own ordering is asserted separately on the assembled prompt.

## Gotchas / learnings

- **Every bound behavior needs its own issue-qualified test name, including a preservation behavior whose assertion already lives inside another behavior's test.** P-02's `observableResult` describes an assertion the `[behavior:#299:B-03]` scan already made — the audit call site being absent from the required-failure branch — and the first candidate therefore wrote no P-02-named test. `acceptance:behaviors` counts names, not assertions, so it failed with "No test names P-02 (matched 0, passed 0, failed 0)". P-02 now has its own `it` in the same `describe`, scanning the branch for what it still *does* (repair references, retry note, `finishIntervention(candidateLifecycle.exhaustDeterministicGates({ candidateTreeId: checkpoint.treeId, ... }))`) rather than only for what it must not gain.
- `RUN_STATE_VERSION` had **four** literal pins, not the three the contract names: `src/run-state.test.ts`'s `[behavior:#87:B-14]` "pins the written schema at 6" assertion is in this slice's file scope and also had to move. Its title said "at 6"; it now names the current version instead of a literal so the next additive bump does not have to rename it again.
- `resolveCandidateTreeId` hashes tracked **plus untracked** content. Writing run state under the worktree being hashed would change the tree; the stage's own tests keep the run-state root in a separate temporary directory, and the production call site's run state lives in the repo root rather than the slice worktree.
- The audit's post-audit re-hash sits in its own `try`/`catch` after the dispatch. A completed invocation whose tree cannot be resolved reports no `postAuditTreeId` rather than reporting the pre-audit id, because guessing "unchanged" would release an audited tree nothing hashed.
- `renderPrompt` enforces placeholders symmetrically: a value the template does not reference throws just as an unsupplied `{{TOKEN}}` does. `prompts/generator-audit.md` therefore declares exactly the four placeholders `assembleSelfAuditEnvelope` supplies, and carries no `TEST_COMMAND`.
- `pnpm test:fast` on this host emits one unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` reporter error under load, reproducibly and independent of these changes; the run still reports 103 files / 2343 tests passed and exits 0.
- A fresh worktree has no `node_modules`, so `pnpm run typecheck` fails with "tsc not found" until `pnpm install --prefer-offline` has run in it.
