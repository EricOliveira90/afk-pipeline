# Research Context - Slice 02: Every Behavior Locks with an Executable Binding

## Scope And Required Behavior

FACT GH #76 requires every in-scope behavior to carry a stable behavior ID, source citation, Given/When/Then, observable result, preservation flag, and one or more gate IDs, with duplicate behavior IDs and unknown gate IDs rejected before contract evaluation (GH issue #76, "What to build" and acceptance criteria 1-5).
FACT GH #76 requires untouched behavior IDs to remain stable across negotiation revisions and requires lock refusals to spend a planner round without invoking `evaluator-contract` (GH issue #76, acceptance criteria 5-6).
FACT The slice index assigns this slice US-4, US-6, and US-18 and blocks it on slice 01/#75 (`.kiro/specs/afk-v2-evidence-backbone/issues.md:8`).
FACT The PRD limits this slice to obligation-format validation: executing gates against behavior IDs arrives in PRD 4/#72, while existing DAG, wave, lane, narrowed-invocation, resume, cancellation, MERGE-PENDING, and blocked-ship semantics must remain intact (`.kiro/specs/afk-v2-evidence-backbone/prd.md:48`, `:53`, `:64`).
FACT The contract evaluator must receive the manifest and configured gate catalog and judge scenario honesty and gate-binding aptness; mechanical schema, coverage, and gate-existence checks run first (`.kiro/specs/afk-v2-evidence-backbone/prd.md:20`, `:29`, `:50`; `docs/specs/afk-v2-agent-roles.md:263-274`).

## Relevant Files

FACT `src/acceptance-manifest.ts` owns the strict manifest type, parser, loader, filename, and normalized path projection (`src/acceptance-manifest.ts:1-159`).
FACT `src/acceptance-manifest.test.ts` covers schema/path validation and checks the planner prompt's manifest example (`src/acceptance-manifest.test.ts:6-62`).
FACT `src/orchestrator.ts` derives the policy-less base-gate catalog and runs contract negotiation, manifest refusal, evaluator invocation, and lock transition (`src/orchestrator.ts:166-186`, `:1322-1605`).
FACT `src/orchestrator.test.ts` supplies shared manifest fixtures and filesystem-level negotiation tests (`src/orchestrator.test.ts:709-799`, `:1696-1899`).
FACT `src/preship.ts` discovers the commands behind policy-less base gate IDs (`src/preship.ts:17-28`, `:84-135`).
FACT `src/prompt-template.ts` enforces exact prompt placeholder arguments (`src/prompt-template.ts:5-34`).
FACT `prompts/planner.md` defines the contract and manifest artifacts emitted each planner round (`prompts/planner.md:27-63`, `:82-154`).
FACT `prompts/evaluator-contract.md` defines the current human judgment step after deterministic validation (`prompts/evaluator-contract.md:1-59`).
FACT `src/migration-claims.test.ts`, `src/wave.test.ts`, and `src/resume-integration.test.ts` contain manifests that the extended strict schema must keep valid (`rg -l "acceptance-manifest.json" src -g "*.test.ts"`).

## Data Model And Existing Behavior In Touched Files

FACT `AcceptanceManifest` is currently strict version 1 with only `version`, `fileScope`, and `migrationCount`; unknown or missing root keys fail `requireExactKeys` (`src/acceptance-manifest.ts:1-7`, `:9-23`, `:77-85`).
INFERENCE Adding required `behaviors` to version 1 will intentionally invalidate every old/minimal manifest unless compatibility is designed explicitly, because the parser requires exact keys (`src/acceptance-manifest.ts:77-85`; slice 01 handoff `.kiro/specs/afk-v2-evidence-backbone/slices/01-undeclared-scope-cannot-lock/handoff.md:12`).
FACT The parent design defines `contract.md` as unparsed judged prose and the acceptance manifest as the sole structured control artifact containing all behavior fields (`docs/specs/afk-v2-agent-roles.md:34-47`).
FACT `runSliceNegotiate` deletes `acceptance-manifest.json` before every planner invocation, loads the newly written file, and skips evaluator invocation on parse failure (`src/orchestrator.ts:1469-1506`, `:1531-1559`).
INFERENCE Mechanical cross-round ID stability needs the previous valid behavior set captured before that deletion or read from another retained artifact; the current loop does not preserve the prior manifest (`src/orchestrator.ts:1469-1471`; `src/orchestrator.test.ts:1831-1898`).
FACT After evaluator `ACCEPT`, the orchestrator owns the `LOCKED` status transition and then consults `onContractLocked`; that callback is currently a post-evaluator migration-prefix boundary, not the required pre-evaluator behavior lock gate (`src/orchestrator.ts:1596-1605`; `:506-523`).
FACT Previously locked contracts are revalidated on resume; an invalid manifest reopens the contract before proceeding, while a valid one reaches `onContractLocked` (`src/orchestrator.ts:1427-1446`).

## Patterns In Use

FACT No current source parser reads `### In scope`; the only contract section parser found is legacy `readContractFiles` for `## Files expected to change` (`rg -n "parse.*contract|In scope|extract.*section" src prompts`; `src/artifacts.ts:220-275`).
UNKNOWN The primary sources do not define a machine-checkable way to identify every prose "in-scope contract behavior" while also requiring that no parser touch `contract.md` (`.kiro/specs/afk-v2-evidence-backbone/prd.md:17`, `:47`; `docs/specs/afk-v2-agent-roles.md:36-47`).
INFERENCE The contract format or lock-check contract needs an explicit identity convention that preserves prose-only status; relying on semantic comparison of free text would violate deterministic coverage intent (`.kiro/specs/afk-v2-evidence-backbone/prd.md:20`, `:57-59`).
FACT The policy-less catalog is derived as stable IDs `typecheck`, `lint`, and `tests`; each ID is always declared, but only discovered package scripts receive commands and become required (`src/orchestrator.ts:166-186`; `src/orchestrator.test.ts:452-478`).
FACT Script discovery maps `typecheck`, `lint`, and preferred `test:run`/fallback `test` to `pnpm run <script>` and shares that plan with base gates, QA command text, and pre-ship sanity (`src/preship.ts:17-28`, `:84-135`).
UNKNOWN GH #76 does not clarify whether a catalog entry with `required: false` and no command is an "executable binding," even though current policy-less discovery retains such IDs (`src/orchestrator.ts:178-185`; GH issue #76, "What to build").
FACT The future quality-policy model allows richer gate declarations, but no quality policy exists yet; this slice must use the derived baseline catalog (`docs/specs/afk-deterministic-quality-gauntlet.md:176-187`; `.kiro/specs/afk-v2-evidence-backbone/prd.md:48`).

## Integration Boundaries And Test Infrastructure

FACT `prompts/planner.md` currently tells the planner to emit only file scope and migration count and must be extended with the behavior schema, stable-revision rule, and catalog-only binding rule (`prompts/planner.md:44-63`; GH issue #76, "What to build").
FACT `prompts/evaluator-contract.md` currently receives neither manifest content nor gate catalog and still asks the evaluator to enforce falsifiability broadly (`prompts/evaluator-contract.md:7-20`, `:32-44`).
FACT Prompt rendering rejects both missing and unused arguments, so adding evaluator catalog input requires synchronized call-site, template, and prompt-template test changes (`src/prompt-template.ts:11-34`; `src/prompt-template.test.ts:85-103`).
INFERENCE The likely implementation surface is `src/acceptance-manifest.ts`, focused parser/lock-check tests, `src/orchestrator.ts`, negotiation integration tests, `prompts/planner.md`, `prompts/evaluator-contract.md`, and prompt rendering tests; the PRD excludes gate execution from this slice (`.kiro/specs/afk-v2-evidence-backbone/prd.md:58`, `:64`).
FACT Manifest fixtures exist in five test files, so a required root `behaviors` field can break unrelated migration, wave, resume, and orchestration scenarios unless their helpers are updated (`rg -l "acceptance-manifest.json" src -g "*.test.ts"` returned `acceptance-manifest.test.ts`, `migration-claims.test.ts`, `orchestrator.test.ts`, `resume-integration.test.ts`, and `wave.test.ts`).
FACT The project's preferred seams are pure manifest/lock validation and real temporary-git orchestration with stub providers, asserting artifacts, events, round counts, and terminal outcomes rather than internal calls (`.kiro/specs/afk-v2-evidence-backbone/prd.md:55-60`; `src/orchestrator.test.ts:1757-1827`).
FACT As an AFK slice agent, verification is `pnpm test:fast` plus touched heavy suites, not full `pnpm test`; this slice directly touches the heavy orchestrator suite (`AGENTS.md:15-31`).

## Potential Conflicts And Recent History

FACT Slice 01 established strict exact-key versioning, fresh-manifest-per-round deletion, pre-evaluator refusal, fail-closed resume, normalized downstream scope, and persisted migration-count authority (`.kiro/specs/afk-v2-evidence-backbone/slices/01-undeclared-scope-cannot-lock/handoff.md:3-20`).
FACT Slice 01 warns that unrelated planner fixtures must write valid manifests and that prose file/migration sections are human views only (`.kiro/specs/afk-v2-evidence-backbone/slices/01-undeclared-scope-cannot-lock/handoff.md:17-20`).
FACT Recent commits `ad2b0c3` and `6fcbd50` introduced the strict manifest and pre-review refusal, `46db748` required freshness each round, and `3b19574` made persisted migration-count disagreement a planner-facing refusal (`git show --stat ad2b0c3 6fcbd50 46db748 3b19574`).
FACT Commit `e59fccd` recently fixed base-gate preparation inside candidate checkpoints; current catalog derivation and gate execution both consume `resolveSanityPlan` (`git show --format=fuller --stat e59fccd`; `src/orchestrator.ts:166-186`; `src/preship.ts:84-120`).
FACT No TODO or FIXME appears in the scoped manifest, negotiation, catalog, or prompt files (`rg -n "TODO|FIXME" src/acceptance-manifest.ts src/orchestrator.ts src/preship.ts src/gate-runner.ts prompts/planner.md prompts/evaluator-contract.md` returned no matches).

## Unknowns

UNKNOWN The exact JSON property names and nesting for source citation, Given/When/Then, observable result, preservation flag, and gate IDs are not specified beyond the semantic field list (GH issue #76, "What to build"; `.kiro/specs/afk-v2-evidence-backbone/prd.md:17`).
UNKNOWN The allowed syntax and normalization rules for stable behavior IDs, including case sensitivity and duplicate detection after normalization, are not defined in GH #76 or the parent PRD (GH issue #76, acceptance criteria 3 and 6; `.kiro/specs/afk-v2-evidence-backbone/prd.md:27`).
UNKNOWN The sources do not say whether stability compares only immediately adjacent planner rounds, all rounds in the run, or prior locked manifests on resume (GH issue #76, acceptance criterion 6).
UNKNOWN The sources do not define whether behavior coverage includes only `### In scope`, also `### Existing behavior to preserve`, or both, despite the manifest's required preservation flag (`prompts/planner.md:100-114`; GH issue #76, "What to build").
