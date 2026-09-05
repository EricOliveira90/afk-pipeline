# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `27a88a898877453371f06c762518193869998563`
against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD, every
available slice artifact, `ARCHITECTURE.md`, and the governing ADRs. I
accepted the recorded pre-ship result and did not rerun the full suite. I
attempted only
`pnpm vitest run src/post-qa-gates.test.ts src/context-envelope.test.ts`;
it could not start because this review worktree has no installed `vitest`
binary. I did not install dependencies because this review may write only
this file.

## FIX-BEFORE-SHIP

### A1 — An uncorrelatable Claude tool result is recorded as measured model time

- **Convention:** ADR 0046, “Amendment (2026-09-05): per-invocation
  non-command time,” requires an uncorrelatable command/tool record to omit
  `nonCommandTimeMs`, never synthesize a value. The same section identifies
  `events.jsonl` as the durable input to the context-envelope ROI analysis.
- **File and location:** `src/claude.ts`, `trackCommandIntervals`
  (lines 147–170), especially the `tool_result` branch at lines 165–170;
  `src/invocation-runtime.ts`, `createCommandTimeTracker` (lines 85–115);
  `src/claude.test.ts`, the `nonCommandTimeMs evidence` block
  (lines 193–289).
- **Evidence gathered:** I read the provider parser and shared tracker,
  searched every Claude attribution test, inspected `git blame`, and read
  the introducing hunk with `git show 0060ac6 -- src/claude.ts
  src/claude.test.ts`. The parser poisons attribution when a `tool_use`
  lacks a string `id`, and the tracker poisons an unknown string completion,
  but a `tool_result` whose `tool_use_id` is absent or non-string is silently
  ignored. The focused tests cover an id-less `tool_use` and an unfinished
  interval, but not an id-less `tool_result`.
- **Concrete failure path:** Claude emits or the stream exposes a
  `tool_result` block without a correlatable `tool_use_id`, with no open
  tracked interval. The parser ignores the uncorrelatable record;
  `commandTime.totalMs()` returns `0`; the runtime derives the whole
  invocation wall clock as `nonCommandTimeMs`; and the orchestrator appends
  that false measurement to durable run evidence. Nothing marks it
  unmeasured or repairs the historical event, so the ROI dataset consumes a
  value ADR 0046 requires to be absent.
- **Attribution:** Commit `0060ac61d3363c0af430d84070cf8a9cf190b125`
  introduced the Claude interval parser, its incomplete fail-closed branch,
  the tests, and the ADR amendment. This behavior does not exist on `main`.
- **Required correction:** Treat every `tool_result` without a string
  `tool_use_id` as unattributable and add a focused regression asserting
  that `nonCommandTimeMs` is absent.

## Standards notes

- `src/orchestrator.ts` grows from 6,193 to 6,563 lines and still contains
  substantial envelope routing and generator situation construction around
  `runSliceExecute`, despite useful extractions into
  `context-envelope.ts`, `contract-prompt-orchestration.ts`, and the gate
  modules. This conflicts with `ARCHITECTURE.md`, “Hubs — do not grow these;
  extract instead.” It is structural debt, but I found no separate unsafe
  shipped path beyond A1.
- `validateExplorerEvidenceMap` is invoked directly in
  `src/orchestrator.ts` at the negotiation boundary rather than represented
  as a declared gate with evidence. That conflicts with
  `ARCHITECTURE.md`, “Placement rules: A new deterministic check is a gate
  in the catalog.” The current check fails safely before planner dispatch,
  so this is a convention note.
- `InvokeOptions.contextEnvelope` in `src/agent-provider.ts` carries
  orchestration-owned evidence through providers that explicitly ignore it.
  ADR 0002 and ADR 0030 define providers as command/output adapters and the
  shared runtime as the invocation lifecycle seam. Keeping this metadata on
  an orchestration wrapper would preserve a deeper provider interface.
- ADR 0046 says the orchestrator copies `nonCommandTimeMs` onto the
  pre-dispatch `prompt-assembly` event, while the implementation correctly
  learns it only after return and writes it to `invocation-completed`
  (`src/orchestrator.ts:959–976`). Amend the ADR to match the causal event
  model; this documentation conflict does not add a second behavior blocker.

## Spec notes

- I did not treat the absence of an explorer revision template as a defect:
  `docs/specs/afk-v2-agent-roles.md` §1 explicitly says there is no
  re-exploration loop.
- I did not treat the split pre-QA/full-suite sequencing as unapproved PRD 4
  scope: ADR 0012’s 2026-09-02 amendment and
  `docs/specs/afk-v2-plan.md`, “Early PRD 4 delivery during PRD 3,” explicitly
  authorize the shipped subset.
- `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST` is manifest-only and describes
  candidate and sibling handoffs as omitted, while the live legacy
  `evaluator-qa` prompt still requires both. Because no assembly or dispatch
  consumes this deferred manifest, it does not change shipped evaluation,
  but it is speculative and should not be called a complete role contract
  until the deferred evaluator-envelope work replaces the legacy prompt.
