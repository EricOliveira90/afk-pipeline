# Product Guardian Review — PRD 3 selected slices

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed HEAD `27a88a8` against the PRD and selected slices 01 (#83), 02
(#90), 03 (#95), and 04 (#99). No manifest slice was skipped. I accepted the
already-passed pre-ship sanity gate and did not rerun the full suite.

## Requirement verification

| Slice | Result | Product outcome |
|---|---|---|
| 01 — Generator runs on the focused envelope | **Partial** | Initial and repair invocations use the focused envelope, computed failure set, one repair template, fail-closed budgets, fresh provider processes, reduced handoffs, and pre-dispatch evidence. The generator manifest does not declare all paths that the role is instructed to write. |
| 02 — Explorer four-section evidence map | Delivered | The explorer receives the FACT/INFERENCE/UNKNOWN rule, exact ordered sections, ADR-title pushed selection without full ADR bodies, optional `ARCHITECTURE.md`, and a fail-closed budget. Output is validated before planning and routed downstream by section rather than per-item role tags. |
| 03 — Planner and contract-evaluator envelopes | Delivered | Planner initial and revision rounds use focused fresh templates; both receive repository context when present, while revisions receive only open findings and affected control context. Contract evaluators receive the contract pair, manifest, gate catalog, and the selected behavior/preservation plus unknown explorer view. Revision judgment stays scoped to prior open findings and changed text. |
| 04 — Envelope parity and evidence completeness | Delivered | Scoped manifests are complete and validated; undeclared classes, rendered-order mismatches, and over-budget prompts fail before dispatch. Assembly is deterministic, named provider stubs receive the same logical envelope, stable IDs survive projection, invocation events record exact envelope evidence and exposed token names, and summaries aggregate exact prompt and token totals. |

## Fix before ship

### 1. Declare the generator's complete allowed write scope

The PRD promises that every versioned role manifest declares its allowed write
scope. The generator manifest currently names only production paths from the
acceptance manifest, while both shipped generator templates require a
three-section handoff and permit a structured escalation artifact. A
maintainer reading or validating the manifest therefore does not get the
complete role boundary promised by user story 1.

- **File and location:** `src/context-envelope.ts`,
  `GENERATOR_CONTEXT_MANIFEST.allowedWriteScope` at line 125 and
  `outputArtifact` at line 149; `prompts/generator.md`, Write boundary and
  Handoff contract at lines 6–16 and 55–70; `prompts/generator-repair.md`,
  Write boundary and Handoff contract at lines 6–16 and 64–79.
- **What I read:** the manifest declares only
  `acceptance-manifest.fileScope`, but its own stop condition and output
  artifact require a handoff. Both templates instruct the generator to write
  `{{SLICE_DIR}}/handoff.md` and, on escalation, to write
  `{{SLICE_DIR}}/escalation.md`.
- **What I ran:** line-numbered reads and `rg -n
  "allowedWriteScope|handoff.md|escalation.md"` confirmed no generator
  manifest entry for either slice artifact. The manifest completeness test at
  `src/context-envelope.test.ts:1431` checks only that write scope is
  non-empty, so this inaccurate boundary is not rejected.

**Clear condition:** Include the acceptance-manifest file scope,
`slice/handoff.md`, and conditional `slice/escalation.md` in the generator
manifest's allowed write scope, and add a focused assertion that the manifest
matches both generator templates' actual write contract.

## Evidence reviewed

- Read the PRD, slice index, every slice handoff and contract artifact, scoped
  prompt templates, envelope assemblers, orchestration dispatch paths,
  provider adapters, event schema, summary aggregation, and focused tests.
- Verified the former planner-revision gap is closed in
  `src/context-envelope.ts`: `PlannerRevisionEnvelopeInput`,
  `PLANNER_CONTEXT_MANIFEST.inputOrder.revision`, and
  `assemblePlannerRevisionEnvelope` now derive, render, order, and record the
  ADR index and `ARCHITECTURE.md`, with a no-entry fallback.
- Verified the former evaluator-selection gap is closed by
  `projectContractEvaluatorEvidence` and both evaluator assemblers, which keep
  `Files and current behavior` plus `Unknowns` and omit the patterns/harness
  and data sections. Focused tests cover initial and revision prompts.
- Verified all planner call sites pass the worktree root, generator failure
  sets contain only unresolved finding fields and failed required gates, and
  Kiro/Claude/Codex dispatch each receives the assembled prompt unchanged.
- Verified the remaining blocker directly from the generator manifest,
  templates, and manifest-completeness test; it is within selected slice 01.
- `git diff --check` passed. A fresh focused Vitest run was unavailable because
  this review worktree has no local Vitest binary; no dependency installation
  was attempted because only this review file may be written.

## Out-of-scope PRD gaps

- The live Kiro, Claude Code, and Codex parity matrix remains explicitly
  deferred; slice 04 delivers provider-independent assembly and named-stub
  parity.
- Prompt assembly for candidate/final evaluators, cleaner, hardener, and
  remediator remains assigned to later PRDs. The candidate-evaluator manifest
  entry lands here as planned, but its assembly path is deferred.
- Acceptance/scope-gate execution remains PRD 4 work.
- Provider model selection, authentication, and streaming changes remain out
  of scope.
