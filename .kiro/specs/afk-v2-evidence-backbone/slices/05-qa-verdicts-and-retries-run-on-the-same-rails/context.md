# Slice 05 Context: QA Verdicts and Retries Run on the Same Rails

## Issue Scope

- **FACT** GH #79 requires a canonical slice-QA verdict artifact with one `PASS | FAIL` verdict, one `NONE | IMPLEMENTATION | INFRASTRUCTURE` failure class, shared-schema findings with clear-conditions, fail-closed contradictions, code-computed unresolved retry input, preserved per-round/per-attempt reports, and unchanged implementation/infrastructure accounting (`gh issue view 79 --json number,title,body,state,labels,assignees,url,comments`).
- **FACT** The parent design says every judge uses one finding shape and code tracks lifecycle/counts/re-raises; agents do not reconcile reports, marker-line parsing leaves control flow, and repair input is the orchestrator-computed unresolved set (`docs/specs/afk-v2-agent-roles.md:65-83`, `docs/specs/afk-v2-agent-roles.md:291-308`).
- **FACT** The parent PRD keeps Markdown as a human companion and declares canonical contract-review and slice-QA artifacts schema-validated and fail-closed (`.kiro/specs/afk-v2-evidence-backbone/prd.md:14-20`).

## Primary Code

- **FACT** `src/orchestrator.ts:2120-2251` owns deterministic/shared-preview evaluator invocation, report freshness, attempt retries, report archiving, and QA outcome classification; `src/orchestrator.ts:2301-2715` owns the three generator rounds and final PASS/STUCK decision.
- **FACT** `src/artifacts.ts:116-149` parses QA verdict/failure-class marker lines and copies Markdown attempt reports; `src/artifacts.ts:575-576` also treats the working Markdown PASS marker as passing QA.
- **FACT** `prompts/evaluator-qa.md:10-104` defines the current Markdown-only output and tells evaluators to reconcile prior reports; `prompts/generator.md:8-24` tells retry generators to read every preserved QA report.
- **FACT** `agents/evaluator.md:84-123` independently documents the Markdown QA verdict/finding template and therefore duplicates output-contract details from `prompts/evaluator-qa.md`.
- **FACT** `src/contract-review.ts:47-84` defines the existing finding/verdict model, `src/contract-review.ts:283-409` strictly parses finding fields, and `src/contract-review.ts:660-715` filters open findings, renders clear-conditions, and derives per-attempt unresolved identity.
- **FACT** `src/artifacts.ts:288-355` and `src/orchestrator.ts:758-840` archive contract-review raw attempts plus code-derived lifecycle records under `.afk/artifacts/<run>/slice-<NN>/reviews`.
- **FACT** `src/run-events.ts:75-85` documents and emits the QA phase outcome vocabulary consumed by status/event readers.

## Current Behavior

- **FACT** `runQAStage` reads `**Verdict:**` from Markdown and returns PASS before reading failure class, so `PASS + IMPLEMENTATION` and `PASS + INFRASTRUCTURE` advance (`src/orchestrator.ts:2233-2235`; `src/artifacts.ts:116-140`).
- **FACT** QA findings are free-form Markdown and never enter a parser, so a PASS report with any blocking finding also advances (`prompts/evaluator-qa.md:75-104`; `src/orchestrator.ts:2233-2251`).
- **FACT** Missing reports retry as infrastructure until attempts exhaust, unrecognized verdicts become implementation failures, and an absent/invalid failure class defaults to implementation (`src/orchestrator.ts:2228-2251`; `src/artifacts.ts:116-140`).
- **FACT** Valid infrastructure reports retry inside the same generator round; valid implementation reports advance the generator round; progress increments once after QA stages finish (`src/orchestrator.ts:2235-2251`, `src/orchestrator.ts:2599-2639`).
- **FACT** Each report attempt is copied to `qa-report-r<round>-a<attempt>.md` or `uat-report-r<round>-a<attempt>.md`, including infrastructure attempts (`src/orchestrator.ts:2224-2232`; `src/qa-orchestration.test.ts:321-353`).
- **FACT** Retry generators currently receive every accumulated base-gate evidence/log and QA/UAT report path through one `repairReferences` list (`src/orchestrator.ts:2306-2308`, `src/orchestrator.ts:2361-2363`, `src/orchestrator.ts:2549-2565`, `src/orchestrator.ts:2601-2634`).
- **FACT** QA evaluators likewise receive all prior deterministic and shared-preview report paths and must restate unresolved and resolved findings (`src/orchestrator.ts:2171-2173`; `prompts/evaluator-qa.md:30-31`, `prompts/evaluator-qa.md:61-63`).

## Data Model and Reuse Boundary

- **FACT** The shipped shared finding fields are `id`, `severity`, `behaviorIds`, `evidence`, `expected`, `observed`, `clearCondition`, `state`, and contract-specific `revisionCitation`; states are exactly `OPEN | RESOLVED | CONTESTED | WITHDRAWN` (`src/contract-review.ts:29-84`, `src/contract-review.ts:129-177`).
- **FACT** The lifecycle record stores `id`, severity/state, derived `unresolved`, planner position/evidence, and evaluator evidence, but not the issue-requested summary or artifact references (`src/contract-review.ts:103-119`, `src/contract-review.ts:687-715`; GH #79 body).
- **FACT** Contract lifecycle helpers currently accept contract-specific `ContractReviewFinding`/`ContractReviewResponse` values; QA currently supplies neither type (`src/contract-review.ts:660-715`; `src/orchestrator.ts:2120-2251`).
- **FACT** Deterministic and shared-preview stages append reports to the same `qaReports` history, while base-gate evidence/log paths and QA report paths append to the same `repairReferences` array (`src/orchestrator.ts:2549-2565`, `src/orchestrator.ts:2585-2634`).

## Integration and Compatibility

- **FACT** Contract review already deletes stale working artifacts, validates canonical JSON fail-closed, archives raw attempts, and writes lifecycle records only for schema-valid attempts (`src/orchestrator.ts:764-840`; slice 04 handoff “Decisions made during implementation”).
- **FACT** Contract artifact parsing rejects malformed JSON, duplicate keys/IDs, extra/missing keys, wrong types, favorable verdict with active BLOCKING findings, and unfavorable verdict without one (`src/contract-review.ts:179-281`, `src/contract-review.ts:421-478`).
- **FACT** Prompt rendering rejects both missing placeholders and extra arguments, so changing prior-report/retry variables requires synchronized template, call-site, and prompt-template test edits (`src/prompt-template.ts:11-34`; `src/prompt-template.test.ts:46-84`, `src/prompt-template.test.ts:117-119`).
- **FACT** ADR 0014 requires the existing Markdown archive names and implementation/infrastructure retry semantics, but its requirement to send complete report history for agent reconciliation is superseded by GH #79 and the parent evidence-backbone design (`docs/adr/0014-prd-070-qa-and-shared-preview-isolation.md:22-31`; GH #79 body).
- **FACT** `sliceArtifactNames` recognizes `qa-report-rN.md`/`uat-report-rN.md`, not current `-aN` names, while live QA attempt preservation happens directly in the slice directory (`src/artifacts.ts:358-385`; `src/orchestrator.ts:2224-2232`).
- **FACT** GH #79 explicitly requires the current per-round/per-attempt QA report archives to remain preserved exactly as today (`gh issue view 79`, acceptance criterion 4).

## Tests and Blast Radius

- **FACT** `src/qa-orchestration.test.ts:187-475` is the existing real-git/stub-provider execution seam for QA retries, round accounting, report archives, generator prompts, and final PASS/STUCK outcomes.
- **FACT** The current retry scenario asserts all prior report paths appear in later generator prompts, exactly the behavior GH #79 replaces (`src/qa-orchestration.test.ts:355-387`).
- **FACT** Pure parser/lifecycle precedent lives in `src/contract-review.test.ts:430-549` and `src/contract-review.test.ts:920-988`; archive-record precedent lives in `src/artifacts.test.ts:51-87`.
- **FACT** No direct test currently imports `readQAVerdict`, `readQAFailureClass`, or `hasPassingQA` (`rg -n "readQAVerdict|readQAFailureClass|hasPassingQA" src --glob '*.test.ts'` returned no matches).
- **FACT** Shared pipeline fixtures write marker-only `qa-report.md` files directly in `src/orchestrator.fixtures.ts:281-297`, `src/wave.fixtures.ts:293-299`, and `src/resume-integration.fixtures.ts:219-224`; schema changes can therefore affect orchestrator, wave, and resume suites even without edits to their assertions.
- **FACT** `src/prompt-template.test.ts:46-84,117-119` pins evaluator prompt arguments; `vitest.config.ts:3-67` controls test discovery, hermetic Git, worker count, and timeout/error handling for every suite.
- **FACT** `pnpm test:fast` excludes `qa-orchestration.test.ts`; the touched heavy command is `pnpm run test:heavy:qa`, currently budgeted at 87 seconds (`package.json:scripts.test:fast`, `package.json:scripts.test:heavy:qa`; `suite-budgets.json:suites.qa-orchestration`).
- **FACT** AFK slice discipline requires `pnpm test:fast` plus touched heavy suites, not full `pnpm test`, and asks new assertions to prefer pure tests or an existing spawned scenario (`AGENTS.md`, “Test loop discipline” and “Where a new assertion goes”).

## History and Sibling Gotchas

- **FACT** Current QA rails and retry-history test originate in `3cffee5 fix(qa): isolate infrastructure failures from QA rounds`; canonical fail-closed review arrived in `6d1dec4`/`cc26760`, and lifecycle/open-only routing arrived in `74e5941`/`ad8e54f`/`9726f6e` (`git blame` and `git log --all --oneline --grep='#77\|#78\|lifecycle\|finding'`).
- **FACT** Slice 03 warns that `JSON.parse` hides duplicate keys, every verdict fixture should use a shared writer, stale artifacts must be deleted before attempts, and malformed attempts still need raw archives (`slices/03-contract-review-fails-closed/handoff.md`, “Gotchas / learnings”).
- **FACT** Slice 04 warns that lifecycle records exist only for schema-valid attempts and terminal resolved/withdrawn IDs must not reactivate across infrastructure retries (`slices/04-negotiation-converges-on-open-findings/handoff.md`, “Decisions made during implementation” and “Gotchas / learnings”).
- **FACT** No TODO/FIXME/HACK/XXX appears in the relevant QA, lifecycle, artifact, prompt, persona, or PRD files (`rg -n -S "TODO|FIXME|HACK|XXX" src prompts agents .kiro/specs/afk-v2-evidence-backbone docs/adr` returned only generic persona/example mentions).

## Unknowns

- **UNKNOWN** GH #79 does not name the canonical QA JSON file, schema version, exact root keys, summary field, or artifact-reference representation.
- **UNKNOWN** GH #79 does not state whether a valid FAIL may carry `failureClass: NONE`, whether advisory findings route to retries, or whether CONTESTED is legal in generator/QA lifecycle.
- **UNKNOWN** The terminal classification for a missing/malformed/contradictory canonical QA artifact is unspecified: contract review uses terminal `ERROR`, while legacy missing QA reports consume infrastructure attempts.
- **UNKNOWN** The destination/naming for canonical QA raw attempts and lifecycle records is unspecified; existing Markdown attempts live in the slice, while contract records live in the central run archive.
- **UNKNOWN** Whether the fallback `generator-stuck` prompt should receive structured unresolved findings instead of report paths is not stated, although it currently consumes the same `repairReferences` list (`src/orchestrator.ts:2680-2699`).
