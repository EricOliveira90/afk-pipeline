# Product Guardian Review — PRD 3 selected slices

**Verdict:** ACCEPT-WITH-NOTES

## Scope

Reviewed HEAD `2e3726e` against the PRD, issue bodies, available slice
contracts and manifests, and implementations for slices 01 (#83), 02 (#90),
03 (#95), and 04 (#99). No manifest slice was skipped. I accepted the
already-passed pre-ship sanity gate and did not rerun the full suite.

## Requirement verification

| Requirement area | Result | Product outcome |
|---|---|---|
| Slice 01 — Generator focused envelope | Delivered | Initial and repair dispatches use a versioned, fail-closed envelope. The generator receives the projected locked contract, acceptance manifest, inline file scope, selected patterns/harness, verbatim verification command, and the current computed failure set. Resumes are repair-situation data, resolved findings and passing logs are excluded, retired resume templates are absent, and assembly evidence is journaled immediately before every dispatch. |
| Slice 02 — Explorer evidence map | Delivered | The explorer receives the FACT/INFERENCE/UNKNOWN rule, exact ordered four-section task, ADR-title index and optional `ARCHITECTURE.md`, with no persona or per-item role tags. Malformed output is rejected before planning. The generator receives only `Patterns and test harness`; contract evaluators receive behavior/preservation evidence and unknowns. Missing repository-context inputs degrade cleanly. |
| Slice 03 — Planner and contract evaluator | Delivered | Planner and contract evaluator each have focused initial and revision envelopes. Planner initial receives the complete explorer map, gates, migration reservation, ADR index, and architecture context; revisions receive only the current contract pair, open findings, control situation, gates, migration reservation, and repository context. Evaluators receive the contract/manifest, gate catalog, selected explorer evidence, and revision-scoped judgment inputs. |
| Slice 04 — Parity and evidence completeness | Delivered | Explorer, planner, contract evaluator, and generator all dispatch through provider-independent versioned manifests. Assembly rejects incomplete manifests, undeclared or unordered context classes, rendered-order mismatches, and over-budget prompts before dispatch. Repeated assembly is deterministic; stub-provider parity preserves behavior, gate, finding, and checkpoint IDs. |
| Invocation and run evidence | Delivered | Every scoped dispatch records prompt bytes, ordered artifact classes and IDs, omitted classes, and manifest version; successful completions add only provider-exposed token names. Slice/run summaries aggregate the same four assembled-role population. HEAD's round-7 fix correctly excludes unassembled evaluator token counts while retaining their separate completion evidence. |
| Fresh context and prompt reduction | Delivered | Prior conversations, other-role conversations, resolved findings, passing raw logs, sibling handoffs, and full ADR bodies are excluded where promised. Generator handoff is reduced to what shipped, decisions, and gotchas, with verification status left to gates. |
| PRD-carried reading-time evidence | Delivered | Measured `nonCommandTimeMs` is durable for assembled roles, candidate QA, and shared-preview evaluation, and remains absent when a provider cannot measure it. It does not affect control flow. |
| Candidate-evaluator manifest entry | Delivered within scope | A complete versioned candidate-evaluator manifest records its objective, boundaries, accepted inputs, output, order, omissions, and budget. Live candidate-evaluator envelope assembly remains deferred as planned. |

## Notes

1. Stricter role budgets are configurable through internal `PipelineConfig`
   fields, but the shipped CLI and `<prd-dir>/afk.json` do not expose them.
   Fixed versioned budgets still fail closed, so the safety outcome ships;
   exposing the stricter project-policy setting would complete the normal
   operator-facing configuration story.

## Evidence reviewed

- Read the PRD, slice index, all current slice artifacts, the retained slice
  02 and slice 04 contracts/manifests, all four GitHub issue bodies, and the
  governing role/context decisions.
- Read all seven scoped prompt templates, the role manifests, generic and
  role-specific assemblers, section validators/projections, orchestration
  dispatch paths, failure-set construction, run-event schema, provider token
  handling, and summary aggregation.
- Verified from `src/orchestrator.ts:makeSliceContext` that prompt-assembly
  evidence is emitted inside the retry callback immediately before provider
  dispatch, and completion evidence is emitted after successful return.
- Verified the generator failure set is built from unresolved finding IDs,
  clear conditions and artifact references plus failed required gates, and
  that post-QA gate repair replaces resolved findings with gates-only evidence.
- Ran the focused envelope, prompt, logger, and provider adapter suites:
  7 files and 134 tests passed. `git diff --check integration/pre-prd3...HEAD`
  also passed.

## Out-of-scope PRD gaps

- The live Kiro/Claude Code/Codex parity matrix remains deferred; slice 04
  delivers provider-independent assembly and named-stub parity.
- Candidate/final evaluator prompt switching and reviewer-handoff exclusion
  remain deferred. Candidate QA still uses its direct prompt path.
- Cleaner, hardener, remediator, and guardian envelopes remain assigned to
  later PRDs.
- Acceptance/scope-gate execution and provider model, authentication, or
  streaming redesign remain out of scope.
