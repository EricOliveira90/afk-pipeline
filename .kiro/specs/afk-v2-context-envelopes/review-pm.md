# Product Guardian Review — PRD 3 selected slices

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed HEAD `2098604` against the PRD, parent plan, issue bodies, and selected
slices 01 (#83), 02 (#90), 03 (#95), and 04 (#99). No manifest slice was
skipped. I accepted the already-passed pre-ship sanity gate and did not rerun
the full suite.

## Requirement verification

| Requirement area | Result | Product outcome |
|---|---|---|
| Slice 01 — Generator focused envelope | Delivered | Initial and repair dispatches use one versioned, budgeted envelope; the repair failure set contains current open findings and failed gates at the end; resume data is a repair block; resolved findings, passing logs, prior conversation, sibling handoffs, full ADR bodies, and prompt rituals are excluded; the complete generator write contract and three escalation tests are declared. |
| Slice 02 — Explorer evidence map | Delivered | The explorer receives the FACT/INFERENCE/UNKNOWN rule, exact ordered four-section task, ADR-title index, optional `ARCHITECTURE.md`, and a fail-closed budget. Output structure is validated before planning, and generator/evaluator consumers receive selected sections rather than per-item role tags. |
| Slice 03 — Planner and contract evaluator | Delivered | Initial and revision prompts use focused fresh envelopes. Planner revisions carry only open findings plus affected control context and retain repository context. Evaluators receive the contract pair, manifest, gate catalog, selected behavior/preservation evidence and unknowns; revision findings are mechanically tied to changed text. |
| Slice 04 — Parity and envelope evidence | Delivered | The four assembled PRD 3 roles use provider-independent manifests, fail on undeclared classes or budget overflow, preserve stable IDs, record ordered envelope evidence and exposed token names, and contribute exact prompt/token totals to run summaries. |
| PRD 3 carried item 13 — per-invocation reading-time evidence | **Missing for candidate QA** | Claude/Codex can compute `nonCommandTimeMs`, but candidate-QA and shared-preview evaluator invocations do not write it to `events.jsonl`. The run therefore cannot measure the evaluator reading time that the PRD says will score the envelope change. |

## Fix before ship

### 1. Record reading-time evidence for candidate-evaluator invocations

The PRD explicitly carries plan item 13. The plan requires per-invocation
`nonCommandTime` as first-class evidence and names evaluator
`nonCommandTime` as the measurement used to judge the envelope investment.
The provider/runtime half exists, but the candidate-evaluator result is
discarded instead of becoming durable run evidence.

- **File and location:** `src/orchestrator.ts`,
  `makeSliceContext`'s `invoke` wrapper at lines 958-977, and
  `runQAStage`'s `invokeEvaluator` at lines 4086-4125.
- **What I read:** the wrapper emits `invocation-completed` only inside
  `if (opts.contextEnvelope !== undefined)`. The candidate-QA and
  shared-preview calls invoke role `evaluator-qa` without a
  `contextEnvelope`, so a measured `result.stats.nonCommandTimeMs` is never
  journaled for those invocations.
- **Corroborating implementation read:** `src/logger.ts:addInvocationStats`
  at lines 129-140 retains only cost and tool-call totals, so the omitted
  metric is not preserved through another channel. `src/run-events.ts`,
  `invocation-completed` at lines 107-132, is restricted to assembled
  `PromptAssemblyRole` values and describes the ROI consumer as
  `events.jsonl`.
- **What I ran:** `rg -n
  "nonCommandTimeMs|invocation-completed|contextEnvelope"` across the
  provider, runtime, orchestrator, event, logger, and test files. It found
  provider/runtime derivation and the conditional assembled-role event, but
  no candidate-QA event or alternate durable storage.

**Clear condition:** When Claude or Codex returns a measured
`nonCommandTimeMs`, persist it with issue, slice, round, and role identity for
every successful candidate-QA/shared-preview evaluator invocation, without
requiring the deferred candidate prompt to switch to PRD 3 envelope assembly.
Add a focused test proving an `evaluator-qa` invocation produces that durable
event and that an unmeasured provider still omits the field.

## Evidence reviewed

- Read the PRD, slice index, all current slice artifacts, the retained #90
  contract, all four GitHub issue bodies, the seven scoped prompt templates,
  every role manifest and assembler, negotiation/generator/QA dispatch paths,
  provider metric derivation, run-event schema, summary aggregation, and
  focused tests.
- Verified the previous generator write-scope blocker is closed:
  `GENERATOR_CONTEXT_MANIFEST.allowedWriteScope` now includes repository file
  scope, `handoff.md`, and conditional `escalation.md`, with a template-bound
  assertion.
- Verified planner revision repository context and evaluator section
  selection are present, and scoped invocation evidence is journaled
  immediately before every assembled-role dispatch.
- `git diff --check` passed. This worktree has no local Vitest binary, so I
  did not install dependencies or write anything beyond this review file.

## Out-of-scope PRD gaps

- The live Kiro/Claude Code/Codex parity matrix remains explicitly deferred;
  slice 04 delivers provider-independent assembly and named-stub parity.
- Candidate/final evaluator prompt switching, cleaner, hardener, remediator,
  and guardian envelopes remain assigned to later PRDs. This finding concerns
  only the PRD 3 reading-time evidence that must exist before those prompt
  changes can be evaluated.
- Acceptance/scope-gate execution and provider model, authentication, or
  streaming redesign remain out of scope.
