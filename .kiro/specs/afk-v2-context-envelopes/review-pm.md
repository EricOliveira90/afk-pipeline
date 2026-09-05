# Product Guardian Review — PRD 3 selected slices

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed HEAD `1bbf2d5` against the PRD and selected slices 01 (#83), 02
(#90), 03 (#95), and 04 (#99). No manifest slice was skipped. I accepted the
already-passed pre-ship sanity gate and did not rerun the full suite.

## Requirement verification

| Slice | Result | Product outcome |
|---|---|---|
| 01 — Generator runs on the focused envelope | Delivered | Initial and repair prompts use a versioned manifest, inline file boundary, compact locked-contract and explorer projections, computed open finding/gate failures, one repair template for resume situations, stricter-only fail-closed budgets, fresh provider invocations, reduced handoffs, and the required escalation criteria. Prompt evidence is written immediately before every dispatch, including transient retries. |
| 02 — Explorer four-section evidence map | Delivered | The explorer receives the citation-label rule, exact ordered evidence-map sections, ADR-title pushed selection, optional repository architecture, and a fail-closed budget. Its output is validated before planning, and the generator receives only the patterns/harness section. |
| 03 — Planner and contract-evaluator envelopes | **Partial** | Initial and revision templates, open-finding convergence, judgment-only evaluator rules, manifest/gate inputs, common dispatch, and evidence recording are present. Planner revisions lose the promised repository context, and contract evaluators receive the whole explorer map rather than a role-selected section view. |
| 04 — Envelope parity and evidence completeness | Delivered | Scoped manifests are complete and validated; undeclared classes and over-budget prompts fail before dispatch; assembly is deterministic; named provider stubs receive identical logical envelopes; stable IDs survive projection; invocation evidence records ordered artifacts and provider token fields; summaries aggregate exact prompt and token totals. |

## Fix before ship

### 1. Keep ADR and architecture context in fresh planner revision rounds

The PRD says the planner envelopes carry the ADR index and
`ARCHITECTURE.md` when present (PRD line 22), and user story 20 promises the
planner those placement rules in its envelope (line 45). A revision is a
fresh planner invocation, so the initial round's memory is unavailable.

- **File and location:** `src/context-envelope.ts`,
  `PLANNER_CONTEXT_MANIFEST.inputOrder.revision` (lines 481–487),
  `PlannerRevisionEnvelopeInput` (lines 941–950), and
  `assemblePlannerRevisionEnvelope` (lines 1164–1226).
- **What I read:** initial assembly derives repository context from
  `repoRoot`, but revision input has no repository root, its declared order
  has no repository-context slot, and its assembler includes only the
  current contract pair, open findings/control situation, gates, and
  migration reservation. `prompts/planner-revision.md` has no repository
  context block.
- **What I ran:** a direct `assemblePlannerRevisionEnvelope` probe reported
  `hasRepositoryContext:false`, `hasAdrIndex:false`, and
  `hasArchitecture:false`; its evidence classes contained only the contract
  pair, gate catalog, and migration reservation.

**Clear condition:** Derive and render the optional ADR index and
`ARCHITECTURE.md` in planner revision envelopes, declare them in revision
input order/evidence, preserve the no-entry fallback, and assert the
dispatched revision prompt for repositories with and without those entries.

### 2. Select explorer evidence by section for contract evaluators

The PRD requires section-level selection (solution line 21 and user story 10)
and gives the contract evaluator explorer sections for repository-reality
judgment (story 8). The governing role design specifies that planners get all
sections, generators get patterns/harness, and evaluators get the
behavior/preservation view (`docs/specs/afk-v2-agent-roles.md`, lines
181–183).

- **File and location:** `src/context-envelope.ts`,
  `assembleContractEvaluatorInitialEnvelope` (lines 1228–1274) and
  `assembleContractEvaluatorRevisionEnvelope` (lines 1276–1358).
- **What I read:** both modes interpolate `input.explorerContext` unchanged
  and record one aggregate `explorer-evidence-map` artifact. No projection
  selects evaluator-relevant sections before rendering.
- **What I ran:** a direct evaluator-envelope probe supplied distinct
  behavior, patterns, data, and unknown markers. The assembled prompt
  reported all four as present, including `PATTERN-ONLY` and `DATA-ONLY`.

**Clear condition:** Add a deterministic contract-evaluator projection that
includes the specified behavior/preservation and required unknown evidence
while excluding sections assigned to other roles; record the selected
section artifacts and test both initial and revision dispatches.

## Verification performed

- Read the PRD, slice index, every file under the selected slices, the scoped
  prompts, envelope implementation, orchestration dispatch, provider
  adapters, event schema, summary aggregation, and focused tests.
- Ran
  `pnpm vitest run src/context-envelope.test.ts src/contract-prompt-orchestration.test.ts src/logger.test.ts src/kiro.test.ts src/claude.test.ts src/codex.test.ts`:
  114 tests passed.
- Ran the targeted transient-retry evidence test in
  `src/orchestrator-runs.test.ts`: 1 passed.
- Ran direct assembly probes for both blocking findings.
- Did not rerun the full suite.

## Out-of-scope PRD gaps

- The live Kiro, Claude Code, and Codex parity matrix remains deferred; slice
  04 covers provider-independent assembly and named stubs.
- Assembled prompts for candidate/final evaluators, cleaner, hardener, and
  remediator remain assigned to later PRDs.
- Acceptance/scope-gate execution remains PRD 4 work.
- Provider model selection, authentication, and streaming changes remain out
  of scope.
