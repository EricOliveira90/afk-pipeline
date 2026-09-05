# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `20986047890ac39f1717112888e01f64c91197e6`
against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD, all slice
contracts and handoffs, `ARCHITECTURE.md`, and the governing ADRs. I accepted
the recorded pre-ship result and did not rerun the full suite.

## FIX-BEFORE-SHIP

### A1 — Candidate-evaluator reading-time evidence is dropped at the invocation seam

- **Convention:** ADR 0046, “Amendment (2026-09-05): per-invocation
  non-command time,” requires `nonCommandTimeMs` as per-invocation durable
  evidence for the context-envelope ROI analysis. It also says the
  orchestrator invocation seam records the measurement. ADR 0030 assigns the
  shared invocation runtime the invocation lifecycle and provider-returned
  statistics.
- **File and location:** `src/orchestrator.ts`, `makeSliceContext`'s `invoke`
  wrapper (lines 892–978), especially the `opts.contextEnvelope !== undefined`
  guard at lines 959–976; `runQAStage`'s `invokeEvaluator` path (lines
  4086–4125); and `src/logger.ts`, `addInvocationStats` (lines 124–135).
- **Evidence gathered:** I read the provider/runtime/statistics path and ran
  `rg -n "contextEnvelope|invocation-completed|nonCommandTimeMs|invokeAgent"`
  across the provider, runtime, orchestrator, event, and logger modules. I
  inspected `git blame` and `git show 0060ac6` for the introducing hunk, plus
  `git show 29f6946` for the later event split. Claude and Codex can return
  `nonCommandTimeMs`; `addInvocationStats` retains only cost and tool calls;
  the durable `invocation-completed` event is emitted only when
  `contextEnvelope` exists. Candidate QA invokes the same wrapper without
  that metadata because its envelope path is deferred.
- **Concrete failure path:** a Claude- or Codex-backed candidate evaluator
  completes successfully and returns measured `nonCommandTimeMs`. The wrapper
  drops it from in-memory totals, skips `invocation-completed`, and no other
  reader persists it. The candidate evaluator is the role whose reading-time
  change the roadmap's ROI rider is meant to compare, so the resulting
  `events.jsonl` cannot answer the required question. No retry or later phase
  reconstructs the lost measurement.
- **Attribution:** commit `0060ac61d3363c0af430d84070cf8a9cf190b125`
  introduced the metric and conditioned its durable write on
  `contextEnvelope`; commit `29f6946c` moved the post-return facts to
  `invocation-completed` while retaining that guard. This behavior is absent
  from `main`.
- **Required correction:** decouple per-invocation completion telemetry from
  PRD-3 envelope evidence. Persist measured `nonCommandTimeMs` for candidate
  QA as well as the four assembled roles, with enough role/slice/round/attempt
  identity to correlate it, and add a focused regression for a successful
  evaluator-QA invocation.

## Standards notes

- `validateExplorerEvidenceMap` is still an inline deterministic check in
  `src/orchestrator.ts:2766–2825`, rather than a declared gate with evidence.
  This conflicts with `ARCHITECTURE.md`, “Seams — GateDeclaration” and
  “Placement rules.” It fails safely before planner dispatch, so I record it
  as debt rather than a second blocker.
- `src/orchestrator.ts` grows from 6,193 to 6,563 lines and retains generator
  repair-situation construction and envelope routing. The extractions into
  `context-envelope.ts`, `contract-prompt-orchestration.ts`, and gate modules
  help, but the net growth still conflicts with `ARCHITECTURE.md`, “Hubs — do
  not grow these; extract instead.”
- `InvokeOptions.contextEnvelope` is orchestration-owned evidence explicitly
  ignored by providers. This leaks PRD-specific metadata through the
  provider seam defined by ADR 0002 and ADR 0030, and is the coupling that
  causes A1.
- ADR 0046 says `nonCommandTimeMs` is copied onto `prompt-assembly`; the code
  correctly learns it only after return and writes `invocation-completed`.
  Amend the ADR to match the causal event model.

## Spec notes

- `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST` is manifest-only while the live
  evaluator-QA prompt remains outside envelope assembly. Its declared omitted
  handoff classes therefore do not govern the current prompt, which still
  reads handoffs. The live handoff behavior predates this feature and the PRD
  defers the candidate-evaluator prompt redesign, so this is not attributed as
  a ship blocker; the manifest should not be treated as authoritative until
  the deferred assembly path consumes it.
