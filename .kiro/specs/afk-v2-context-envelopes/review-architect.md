# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at
`37c5fef05e9bbef6b239677a8e889ab1a2ca15fc` against base
`817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD, all available slice
contracts and handoffs, `ARCHITECTURE.md`, and the governing ADRs. I accepted
the recorded pre-ship result and did not rerun the full suite.

## FIX-BEFORE-SHIP

### A1 — Run-summary token totals include unassembled evaluator invocations

- **Convention and contract:** ADR 0017 makes `run-summary.md` a stable
  consumer contract. ADR 0046 defines candidate-QA/shared-preview
  `invocation-completed` records as per-invocation ROI evidence. Slice 04
  contract B-06 defines the summary columns as totals for the scoped context
  envelopes: assembled prompt bytes and their exposed provider token counts.
- **File and location:** `src/logger.ts`, `Logger.writeSummary`, lines
  237-260; `src/orchestrator.ts`, `makeSliceContext` lines 996-1019 and
  `runQAStage` lines 4132-4144; `src/run-events.ts`, the
  `invocation-completed` payload at lines 107-139.
- **Evidence gathered:** I read the event producer and summary consumer,
  inspected `git show 37c5fef` and `git blame` for the affected hunks, and
  read the B-06 logger test. `runQAStage` now emits successful
  `evaluator-qa`/`evaluator-uat` completion events carrying provider token
  counts, while `Logger.writeSummary` adds token counts from every
  `invocation-completed` event but adds prompt bytes only from
  `prompt-assembly`. The existing logger test creates only generator
  completions, so the passed suite does not exercise the widened event
  population. `git diff --check main...HEAD` passed.
- **Concrete failure path:** a Claude or Codex candidate evaluator returns
  token usage. The wrapper journals that usage without a matching envelope
  assembly, and the summary adds it to the slice and run “Provider tokens”
  totals. The adjacent “Prompt bytes” total still covers only explorer,
  planner, contract evaluator, and generator envelopes. The durable summary
  therefore reports two totals over different invocation populations and
  overstates B-06 envelope token usage. No later phase corrects the file.
- **Attribution:** commit `37c5fef` widened `invocation-completed` to
  evaluator roles and began emitting those events from `runQAStage`.
  `Logger.writeSummary` already consumed every completion event, so this hunk
  materially changed the population it aggregates. The behavior is absent
  from the base branch.
- **Required correction:** keep evaluator completion events in
  `events.jsonl` for ADR 0046, but exclude unassembled evaluator roles from
  B-06 envelope-summary totals (or require a matching scoped
  `prompt-assembly` identity). Add a focused logger test with evaluator token
  counts proving they do not enter envelope totals.

## Standards

- `src/orchestrator.ts` grows from 6,193 to 6,617 lines and still owns
  envelope telemetry, gate classification, QA authority checks, and repair
  projection. It also imports `candidate-gate-policy.ts`, which
  `ARCHITECTURE.md` lists as a Gates internal. This conflicts with
  `ARCHITECTURE.md`, “Hubs — do not grow these; extract instead” and the
  Modules public/internal boundary. The new checks fail closed before invalid
  state ships, so this is structural debt rather than another blocker.
- `InvokeOptions.contextEnvelope` in `src/agent-provider.ts` is
  orchestration-owned evidence that every provider ignores. ADR 0002 and ADR
  0030 define providers as command/output adapters. Move this metadata to the
  orchestrator invocation wrapper when that seam is next revised.
- `promptAssemblyContext` retains an unused `_journal: unknown` parameter,
  and `recordPromptAssembly` now packages evidence rather than recording it.
  These names preserve an obsolete ownership model and should be cleaned up.

## Spec

- The branch includes the early PRD 4 gate-sequencing change
  (pre-QA checks → candidate QA → full suite) alongside PRD 3. ADR 0012 and
  the parent plan now document that decision, so it is not an undocumented
  authority change, but it substantially enlarges this feature branch and is
  the main source of the orchestrator-hub growth noted above.
- Apart from A1, the four scoped roles use versioned, fail-closed,
  provider-independent envelope assembly, preserve the declared evidence
  identities, and keep candidate-evaluator prompt assembly deferred as the
  PRD requires.
