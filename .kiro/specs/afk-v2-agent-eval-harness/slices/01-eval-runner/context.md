# Context: #262 — Eval runner (S1)

## Files and current behavior

- FACT: None of the five new modules the slice must create exist yet:
  `src/eval-pack.ts`, `src/eval-compare.ts`, `src/eval-report.ts`,
  `src/eval-command.ts`, `src/eval.fixtures.ts` (glob for `src/eval-*.ts`
  returns no files).
- FACT: `src/prompt-recorder.ts` already exists and is fully wired
  (`--record-prompts` parsed in `src/cli-options.ts:255`; wrapper used in
  `src/afk.ts`/`src/afk-claude.ts`/`src/afk-codex.ts`; `run-started` event
  carries `recordPrompts` in `src/run-events.ts:41`; tests in
  `src/prompt-recorder.test.ts` and `src/cli-options.test.ts:139-155`). This
  is issue #264 (S3, prompt recorder) — `prd.md`'s "Verified facts" section
  says `rg -- '--record' src` is empty and treats S3 as not-yet-built; that
  premise is stale on this checkout. INFERENCE (from the fact above): #264 has
  already merged onto this branch ahead of #262, so S1's own work does not
  need to build the recorder, but any prompt/context passed to the planner
  should not claim `--record-prompts` is absent.
- FACT: `eval-packs/` does not exist anywhere in the repo (glob returns no
  matches) — S1 only needs to add `eval-packs/fixtures/refused/*.json`.
- FACT: `AgentProvider.invoke(options: InvokeOptions): Promise<InvokeResult>`
  is declared at `src/agent-provider.ts:184-187`. `InvokeOptions` interface
  starts at `src/agent-provider.ts:14`, with `role` at :20, `agent?` at :26,
  `prompt` at :27 (other fields `cwd`, `bare?`, `logStream?`, `maxToolCalls?`
  are on the same interface, not individually re-verified by line). `InvokeResult`
  is at :171-174 (`exitCode`, `stdout`, `stats`). `InvocationStats` is at :118,
  with `costUsd?` at :119, `toolCallCount?` at :120, `tokenCounts?` at :122.
- FACT: each provider returns `stdin: prompt` — `src/claude.ts:183`,
  `src/codex.ts:278`, `src/kiro.ts:184`. `src/invocation-runtime.ts:200-202`
  writes and ends that stdin; `tool_call` stream events are counted into
  `toolCallCount` at `src/invocation-runtime.ts:351-353`.
- FACT: production invoke call sites, current line numbers (differ from
  `prd.md`'s single-line-per-role citations because `src/orchestrator.ts` has
  multiple call sites per role across rounds/retries): planner invokes at
  `src/orchestrator.ts:1531, 1990, 3058, 3098, 3606`; evaluator-contract at
  `:1641, 1654, 1670, 1692, 3891, 3953, 3962, 4074, 4154, 4170`; evaluator-qa
  at `:5161-5177, 6402, 6431`; evaluator-final at `:7171-7197`. INFERENCE: the
  runner should reproduce the `InvokeOptions` *shape* documented in `prd.md`
  D9's table (role/prompt/cwd/logStream, no agent/bare for these five roles),
  not any single call site verbatim, since the shape recurs across all sites.
- FACT: guardian invokes in `src/ship-gate.ts` set `bare: true` at line 754
  and set role to `architect-review`/`pm-review` at line 707; the filenames
  `review-architect.md`/`review-pm.md` appear at lines 209-210, 366, 405, 710.
- FACT: `parseContractReview` is at `src/contract-review.ts:369`; the verdict
  enum `"ACCEPT" | "REVISE"` is declared at line 21; the `ContractReview`
  interface's `verdict` field is at line 88.
- FACT: `parseQAReview` is at `src/qa-review.ts:346`; `QAReview.failureClass`
  is at line 61; `QAReviewFailureClass` type is at line 17.
- FACT: `parseFinalReview` is at `src/final-evaluation.ts:305`; `FinalReview`
  fields `baselineTreeId`/`finalTreeId` are at lines 177/179; the return
  literal `{ version: 1, verdict, baselineTreeId, finalTreeId, findings }` is
  at line 354.
- FACT: `parseGuardianReview(content, kind)` is at `src/artifacts.ts:308` and
  never throws — an unparseable review returns `outcome: "UNPARSEABLE"` (e.g.
  line 312). `GuardianFindingDisposition` type is at line 62. `parseContractFiles`
  is at line 449.
- FACT: `readPlannerEscalation(sliceDir)` is at `src/planner-escalation.ts:125`;
  its return union (`null` / `{kind:"escalation"}` / `{kind:"malformed"}`) is
  declared at lines 64-65.
- FACT: `normalizePath` in `src/acceptance-manifest.ts` lowercases at line 71
  (function spans roughly lines 64-79); `parseAcceptanceManifest` is at
  line 201.
- FACT: `buildStubProvider` is at `src/orchestrator.fixtures.ts:407`, matching
  `prd.md`'s citation exactly — an `AgentProvider` whose `invoke` reads
  `options.role`/`options.cwd`, writes a fixture artifact, and records the
  call.
- FACT: `src/afk.ts` dispatches, in order, before
  `parsePipelineRuntimeOptions(args)` (line 90): `usage()` at line 36,
  `args[0] === "status"` at line 50, `"stop"` at line 73, `"clean-failed"` at
  line 80, `"adopt"` at line 83. This is the pattern the new
  `args[0] === "eval"` branch must join.
- FACT: `src/afk-claude.ts` and `src/afk-codex.ts` both have `usage()` at
  line 33, `"stop"` dispatch at line 47, `"clean-failed"` at line 54, and
  call `runPipeline({...})` at line 248 with their own provider bound. Neither
  file currently has an `"adopt"` branch (only `afk.ts` does).
- FACT: `runStopCli(args, repoRoot, deps: StopCliDeps = {})` is at
  `src/stop-command.ts:200`; `runAdoptCli(args, repoRoot, dependencies =
  DEFAULT_DEPS)` is at `src/adopt-command.ts:655`; `runCleanFailedCli(args,
  provider?: AgentProvider)` is at `src/clean-failed.ts:399`. These are the
  three signature precedents `prd.md` cites for `runEvalCli`'s
  `(args, repoRoot, provider, deps = DEFAULT_EVAL_DEPS)` shape.
- FACT: `agentLog(sliceId, agent, round?)` is at `src/logger.ts:243-247`,
  producing `slice-<sliceId>-<agent>[-r<round>].log` in append mode. The
  eval runner's own per-case `<case-id>.log` naming is not required to reuse
  this helper — `prd.md` only cites it as the existing per-invocation log
  convention.
- FACT: `EVENTS_SCHEMA_VERSION = 1` is at `src/run-events.ts:26`; the
  `run-started` event type starts at line 34, with `runSlug` at :36,
  `contractRoundLimit?` at :38, `implementationRoundLimit?` at :39, and (per
  the prompt-recorder work already merged) `recordPrompts?` at :41. S1 does
  not touch this file (`prd.md`'s file-scope map assigns it to S3 only).
- FACT: `GATE_EVIDENCE_VERSION = 3` is at `src/gate-runner.ts:43`;
  `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2, 3] as const` is at line 46 — the
  precedent `prd.md` D13 cites for `EVAL_PACK_VERSION`/
  `SUPPORTED_EVAL_PACK_VERSIONS`.
- FACT: `RUN_STATE_VERSION = 5` is at `src/run-state.ts:61`.
- FACT: `package.json` has no `dependencies` key (only `devDependencies`);
  `bin` entries (`afk`, `afk-claude`, `afk-codex`) are at lines 6-10; `exports`
  (only `./afk-manifest`) is at lines 11-16. `.gitignore` line 3 is `.afk/`.
- FACT: `vitest.config.ts` line 5 includes only `["src/**/*.test.ts"]`.
- FACT: `ContextEnvelopeRole` is declared at `src/context-envelope.ts:759-762`
  (not 746-762 as `prd.md` states — lines 746-750 hold a preceding
  `PromptAssemblyRole` type).
- FACT: `laneResourceGroups` is at `src/lanes.ts:123`; `partitionLanes` is at
  line 165. S1 does not touch this file.

## Patterns and test harness

- FACT: the boolean-CLI-flag precedent this slice would follow for its own
  flags (`--dry-run`) is `--record-prompts` itself, parsed at
  `src/cli-options.ts:255` as `args.includes("--record-prompts") ? true :
  undefined`. `prd.md`'s citation of `src/cli-options.ts:239-241` as the
  boolean-flag precedent actually lands on integer-flag parsing
  (`--guardian-round-cap`) at that line range, not a boolean example — the
  real boolean example is the recorder flag a few lines later.
- FACT: no existing source-level "no module imports X" test convention was
  found. Grepping `src/*.test.ts` for "does not import" / "boundary" /
  "isolation" only matched unrelated generic import statements or wording in
  `qa-orchestration.test.ts`, `orchestrator.test.ts`, `logger.test.ts`,
  `codex.test.ts`, `adopt-command.test.ts`. INFERENCE: the acceptance
  criterion "a source-level test asserts none imports `./eval-pack.js` etc."
  will be a new test pattern in this codebase, not a reuse of an existing
  helper.
- FACT: `CONTEXT.md` entries use the format `**Term**:` followed by wrapped
  prose and an `_Avoid_:` line (e.g. `**AFK Pipeline**:` at line 9,
  `**Agent invocation**:` at line 45); the `### Pipeline concepts` section
  header is at line 217. The word "disposition" does not appear as an
  existing glossary entry.
- FACT: `docs/adr/` index (pushed to this task) lists 0002 (provider-agnostic
  `AgentProvider`), 0036 (tool-call cap is per-invocation, opt-in), 0038
  (generator verification command), 0041 (uncertain classification), 0049
  (ticket lint vocabulary), 0063 (spawned scenarios are last-resort tests) as
  the ADRs `prd.md` binds this PRD to. These titles plausibly govern S1's
  design (provider interface reuse, no new pipeline machinery, last-resort
  spawned-test discipline) but their bodies were not re-opened for this
  evidence map — `prd.md`'s own citations of them are the operative text.
- FACT: per `CLAUDE.md` / `AGENTS.md` (repo root), the required verification
  command for a slice agent is `pnpm run typecheck && pnpm test:fast` plus
  any touched heavy suites — never the full `pnpm test` — matching `prd.md`'s
  own "Testing decisions" section (typecheck + test:fast; no heavy suite is
  named for S1 since it adds no spawned scenario).
- FACT: `ARCHITECTURE.md` (repo root, read this session) already lists a
  "Prompts" module row and separate rows per module family (CLI entries,
  Orchestrator core, Gates, etc.) in a fixed table format with a 150-line cap
  on the file; the slice's "Agent eval" row must fit that same table shape
  (Module | Purpose | Public seam | Internals).

## Unknowns

- UNKNOWN: whether the planner/generator for #262 should be told explicitly
  that #264 (prompt recorder) is already merged on this branch, since
  `prd.md`'s own "Verified facts" section (written against a different
  commit, `0faf207`) asserts the opposite and could otherwise mislead a
  generator into re-implementing or conflicting with `src/prompt-recorder.ts`.
- UNKNOWN: exact current byte offsets/line numbers inside
  `src/orchestrator.ts` for each of the many planner/evaluator invoke call
  sites beyond what was spot-checked above; the file is 7000+ lines and only
  representative line numbers were gathered, not an exhaustive list.
- UNKNOWN: whether any other slice or concurrent branch work (PRD 5, per
  `prd.md`'s "Concurrency with PRD 5" section) has touched
  `src/run-events.ts` or `src/orchestrator.ts` on this specific checkout in a
  way that shifts the line numbers cited above by the time #262 is
  implemented.
