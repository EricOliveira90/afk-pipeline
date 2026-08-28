# Slice 01 Context: Scope Escalation Routes to Contract Revision

## Relevant Files

- **FACT** `src/orchestrator.ts:1689-2340 runSliceNegotiate()` owns explorer/planner/contract-evaluator negotiation, the two-round cap, revision prompts, artifact validation, contract locking, and negotiation failure; `src/orchestrator.ts:2989-3487 runSliceExecute()` owns generator rounds, gates, QA, and STUCK handling.
- **FACT** `src/contract-review.ts:4-127` defines the canonical contract-review, planner-response, revision-citation, attempt-record, and negotiation-outcome shapes; `:481-609` parses/loads planner responses; `:680-685` selects OPEN findings; `:738-810 validateRound2ContractReview()` begins revision lifecycle validation.
- **FACT** `src/scope-amendment.ts:36-66` defines request/plan/record vocabulary; `:80-159 planScopeAmendment()` validates requested paths; `:173-271` applies additive scope changes and builds the archive record.
- **FACT** `src/artifacts.ts:260-342` defines the slice/review archive paths and non-overwriting round/attempt-stamped contract-review archives; `:413-425 archiveScopeAmendment()` stores amendment records.
- **FACT** `src/acceptance-manifest.ts:1-28` models locked file scope and behaviors; `:46-95 normalizeAcceptanceManifestPath()` is the shared exact repo-relative path validator.
- **FACT** `prompts/generator.md:38-56` supplies the normal generator invariants and currently routes an undeclared changed file to later QA amendment; `prompts/generator-resume.md:41-121` and `prompts/generator-resume-stuck.md:31-125` are alternate generator invocation templates.
- **FACT** `agents/generator.md:88-115` is the shipped generator persona and already says to stop/request contract revision, but defines no canonical escalation artifact.
- **FACT** `src/orchestrator.test.ts:1448-3102` covers contract negotiation, revision, fail-closed review artifacts, and attempt archives; `src/qa-orchestration.test.ts:1234-1455` covers QA-side scope amendment.
- **FACT** `src/orchestrator.fixtures.ts:58-82,213-318` supplies `SliceFixture` and a real-git stub provider with per-slice generator-round tracking; `src/test-support.ts:24-153` centralizes canonical contract/QA artifact writers.
- **FACT** `src/artifacts.test.ts:55-566`, `src/scope-amendment.test.ts:91-278`, and `src/prompt-template.test.ts:6-178` are the focused archive, scope-policy, and prompt-contract suites.
- **INFERENCE** A new escalation parser/model and focused unit test have no existing file; repository search found no production `escalation.md` parser (`rg -n -i "escalat" src prompts`, 2026-08-28).

## Existing Behavior in Touched Files

- **FACT** A generator invocation currently increments the persisted generator round before prompt rendering/invocation, then proceeds directly to migration and base gates; there is no post-invocation escalation-artifact branch (`src/orchestrator.ts:3044-3141`).
- **FACT** Normal execution renders one of three generator templates, invokes role `generator`, and closes/logs the phase before gate work (`src/orchestrator.ts:3066-3123`).
- **FACT** A normal generator must keep correct undeclared work for QA to amend and must not edit the locked list (`prompts/generator.md:48-56`); a STUCK resume instead says an out-of-scope change must be reverted (`prompts/generator-resume-stuck.md:60-67`).
- **FACT** Contract revision currently routes prior OPEN review findings to planner round 2, requires exact-ID `contract-response.json`, snapshots before/after contract and manifest text, then sends both to a fresh evaluator-contract invocation (`src/orchestrator.ts:1983-2059,2110-2245`).
- **FACT** Evaluator ACCEPT locks the contract; REVISE spends the next planner round; exhaustion returns `ESCALATE`; malformed review output returns `ERROR` without a default verdict (`src/orchestrator.ts:2246-2326`).
- **FACT** The legacy wrapper executes only after negotiation returns LOCKED (`src/orchestrator.ts:3506-3531`); the wave path likewise uses separate negotiate/execute phases so lane partitioning can read locked scopes (`src/orchestrator.ts:3507-3511`).
- **FACT** Contract-review raw attempts are deleted before invocation, archived after every attempt as `contract-review-r<round>-a<attempt>.json`, and copied with overwrite refusal (`src/orchestrator.ts:2203-2226`; `src/artifacts.ts:290-325`).
- **FACT** QA scope amendment only adds normalized, non-migration paths that are undeclared but already changed; it refuses unchanged requested paths and `no-repository-changes` contracts (`src/scope-amendment.ts:80-159`).
- **FACT** Applied QA amendments update both `acceptance-manifest.json` and `contract.md`, preserve all other contract terms, archive a record, and re-grade in the same QA round without an implementation round (`src/scope-amendment.ts:161-271`; `src/orchestrator.ts:2856-2907`).

## Patterns in Use

- **FACT** Canonical control artifacts use exact-key, versioned parsers and reject malformed, duplicate-key, missing, extra, contradictory, or wrong-type data (`src/contract-review.ts:129-179,460-577`).
- **FACT** Fixed-name working artifacts are removed before attempts; archives include round and attempt and use exclusive creation (`src/orchestrator.ts:2203-2210`; `src/artifacts.ts:312-340,363-403`).
- **FACT** Structured findings carry stable IDs and observable clear conditions; planner revision routing formats only OPEN findings (`src/contract-review.ts:47-77,654-685`).
- **FACT** Scope changes use additive plan/apply/refusal semantics and aggregate all refusal reasons rather than short-circuiting (`src/scope-amendment.ts:68-78,102-159`).
- **FACT** Prompt arguments are exact in both directions: missing placeholders and unused supplied arguments throw (`src/prompt-template.ts:5-34`).

## Test Infrastructure

- **FACT** Vitest includes `src/**/*.test.ts`, uses two thread workers, 60-second test/hook limits, and hermetic Git environment variables (`vitest.config.ts:3-56`).
- **FACT** Focused commands are `pnpm vitest run src/<file>.test.ts`; AFK slice handoff requires `pnpm test:fast` plus touched heavy suites, not the full suite (`AGENTS.md:23-38`).
- **FACT** The orchestration blast-radius command is `pnpm run test:heavy:orchestrator`, which runs both `src/orchestrator.test.ts` and `src/orchestrator-runs.test.ts`; `test:fast` excludes those and other heavy integration files (`package.json:24-33`).
- **FACT** Integration fixtures create real temporary Git repos and deterministic stub providers; fixture helpers live outside test discovery via `.fixtures.ts` (`src/orchestrator.fixtures.ts:1-15,93-125`).
- **FACT** Existing scope-amendment orchestration tests call `runQAStage` directly because no prior scenario reaches the required locked-contract/undeclared-change state (`src/qa-orchestration.test.ts:1234-1238`).
- **FACT** Changes to prompt placeholders typically require `src/prompt-template.test.ts`; canonical fixture schema changes typically require `src/test-support.ts` and `src/orchestrator.fixtures.ts` (`src/prompt-template.test.ts:143-178`; `src/test-support.ts:24-28`; `src/orchestrator.fixtures.ts:213-318`).

## Artifact Data Model

- **FACT** Issue #80 requires `escalation.md` to carry finding IDs, needed paths, and reason; missing findings or paths is invalid; valid and malformed attempts must be archived per round/attempt without overwrite (`GH #80 body`, fetched by `gh issue view 80`).
- **FACT** Existing scope requests are `{ findingId: string, paths: readonly string[] }`; archive records are version 1 with stage, round, attempt, finding IDs, and paths (`src/scope-amendment.ts:36-66`).
- **FACT** Locked scope is `fileScope: {kind:"paths",paths:string[]} | {kind:"no-repository-changes"}`, with migration count and version-2 behaviors preserved separately (`src/acceptance-manifest.ts:1-28`).

## Integration Boundaries

- **FACT** `orchestrator.ts` imports contract lifecycle helpers, artifact storage, acceptance-manifest validation, and `planScopeAmendment`/`applyScopeAmendment`; it exports `runSliceNegotiate`, `runSliceExecute`, `makeSliceContext`, and `runPipeline` to tests/wave orchestration (`src/orchestrator.ts:123-169,743-851,1689-1703,2989-2992,3534-3537`).
- **FACT** The generator-side route must occur before base gates and QA and must reuse ADR 0048 vocabulary/records rather than a parallel amendment path (`GH #80 body`; `docs/adr/0048-qa-findings-name-their-remedy.md:39-61`).
- **FACT** Lane partitioning depends on the locked contract between negotiate and execute, so revised scope is externally consumed before execution (`src/orchestrator.ts:3507-3511`).

## Potential Conflicts

- **FACT** Commit `054ce3e` (merged by `a04370a`, 2026-08-28) most recently changed `orchestrator.ts`, `artifacts.ts`, `scope-amendment.ts`, `prompts/generator.md`, and their tests for QA-side amendment (`git log/show a04370a`).
- **FACT** Slice 04's handoff says round-2 planner responses are mandatory after prior review, revision citations compare before/after snapshots, and the negotiation cap is hard two rounds (`.kiro/specs/afk-v2-evidence-backbone/slices/04-negotiation-converges-on-open-findings/handoff.md:14-27`).
- **FACT** Slice 03's handoff says malformed canonical artifacts retain raw attempts, refused artifacts are `ERROR`, and shared fixture verdicts go through `writeContractReview` (`.kiro/specs/afk-v2-evidence-backbone/slices/03-contract-review-fails-closed/handoff.md:31-60,78-85,116-123`).
- **FACT** No TODO/FIXME/HACK appears in the identified source, test, or generator-prompt files (`rg -n "TODO|FIXME|HACK" ...`, exit 1, 2026-08-28).

## Unknowns

- **UNKNOWN** What exact version, field names, Markdown structure, escaping rules, duplicate policy, and finding-ID/path uniqueness rules define schema-valid `escalation.md`? GH #80 names only the required information.
- **UNKNOWN** Does an escalation reopen the current LOCKED contract into an additional focused revision round, or restart the existing two-round negotiation state with a specified remaining round budget?
- **UNKNOWN** What terminal phase/cause should a malformed escalation produce, and should archive failure itself be terminal?
- **UNKNOWN** Do escalation archives live directly under `slice-<n>/` or its existing `reviews/` child, and what exact filename prefix accompanies `r<round>-a<attempt>`?
- **UNKNOWN** Which resume templates receive the new instruction, and can resumed/STUCK generators emit this artifact?
- **UNKNOWN** After a valid escalation, is the next generator invocation counted as the same unspent implementation round number or as a newly numbered round whose count increments only at dispatch?
