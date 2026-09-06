# Product Guardian Review — PRD 3 selected slices

**Verdict:** ACCEPT-WITH-NOTES

## Scope

Reviewed HEAD `37c5fef` against the PRD, parent role decisions and plan,
the four selected issue bodies, and the slice artifacts for 01 (#83), 02
(#90), 03 (#95), and 04 (#99). No manifest slice was skipped. I accepted
the already-passed pre-ship sanity gate and did not rerun the full suite.

## Requirement verification

| Requirement area | Result | Product outcome |
|---|---|---|
| Slice 01 — Generator focused envelope | Delivered | Initial and repair dispatches use the versioned, fail-closed envelope path. The generator receives the projected locked contract, manifest behaviors, inline file scope, selected patterns/harness, verbatim verification command, and only the current open findings and failed gates at the end. Resume and STUCK situations use the repair template as data blocks; retired resume templates and prompt rituals are absent. |
| Slice 02 — Explorer evidence map | Delivered | The explorer prompt carries the FACT/INFERENCE/UNKNOWN rule, exact ordered four-section task, optional ADR-title index and `ARCHITECTURE.md`, and a fail-closed budget. The orchestrator rejects malformed section structure before planning. Generator and evaluator consumers receive the promised section projections rather than per-item role tags. |
| Slice 03 — Planner and contract evaluator | Delivered | Planner and contract evaluator each have focused initial and revision templates. Planner initial receives all explorer evidence plus repository context; revisions receive current contract state, open findings, control context, gates, migration reservation, and repository context without resolved history. Evaluators receive the manifest, gate catalog, selected behavior/preservation evidence and unknowns, and revision-scoped judgment rules. |
| Slice 04 — Parity and evidence completeness | Delivered | Explorer, planner, contract evaluator, and generator dispatch through provider-independent versioned manifests. Assembly validates complete manifest contracts, declared artifact classes, logical and rendered order, deterministic output, stable IDs, and fail-closed budgets. Events record exact prompt bytes, ordered classes/IDs, omissions, manifest version, and exposed token names; summaries aggregate prompt and token totals. |
| PRD-carried plan item 13 — reading-time evidence | Delivered | Claude and Codex derive `nonCommandTimeMs` only when command time is attributable. Successful assembled-role, candidate-QA, and shared-preview evaluator invocations now persist it in `invocation-completed` events with issue, slice, round, role, and evaluator attempt identity; unmeasured invocations omit the field rather than inventing zero. |
| Candidate-evaluator manifest entry | Delivered within scope | A complete versioned candidate-evaluator role manifest declares the change-summary-first order, accepted inputs, reviewer handoff exclusions, output, stop/escalation conditions, and budget. Its prompt assembly remains correctly deferred to PRD 4. |

## Notes

1. Project-specific stricter envelope budgets are implemented as internal
   `PipelineConfig` fields, but the shipped CLI runtime options and
   `<prd-dir>/afk.json` do not expose them. The selected slices still deliver
   fixed versioned budgets and fail closed, so the safety outcome ships; a
   future configuration surface would make the PRD's “project policy may set
   stricter budgets” decision available to normal CLI users without a custom
   caller.

## Evidence reviewed

- Read the PRD, `issues.md`, all current slice artifacts, the retained slice
  02 contract/manifest, all four GitHub issue bodies, parent context-envelope
  decisions, and the carried plan items.
- Read all scoped prompt templates, role manifests, generic and role-specific
  assemblers, section projections, negotiation routes, generator initial and
  repair routes, provider invocation/completion evidence, event schema, and
  summary aggregation.
- Verified the previous reading-time blocker is closed in
  `src/orchestrator.ts:makeSliceContext` and `runQAStage`: evaluator calls now
  supply `completionEvidence`, successful results emit
  `invocation-completed`, and the field remains absent when not measured.
- Verified focused tests cover exact prompt/evidence order, section
  selection, exclusions, deterministic assembly, one-byte-over budget
  failures, provider-stub parity, stable IDs, summary totals, provider prompt
  delivery, and measured/unmeasured reading-time evidence.
- `git diff --check main...HEAD` passed. This review worktree has no installed
  `node_modules`, so the narrow Vitest commands were unavailable; I did not
  install dependencies or rerun the already-passed full gate.

## Out-of-scope PRD gaps

- The live Kiro/Claude Code/Codex parity matrix remains explicitly deferred;
  slice 04 delivers provider-independent assembly and named-stub parity.
- Candidate/final evaluator prompt switching, cleaner, hardener, remediator,
  and guardian envelopes remain assigned to later PRDs.
- Acceptance/scope-gate execution and provider model, authentication, or
  streaming redesign remain out of scope.
