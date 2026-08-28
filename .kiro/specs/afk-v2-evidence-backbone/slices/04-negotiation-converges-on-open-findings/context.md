# Slice 04 Context: Negotiation Converges on Open Findings

## Issue Scope

- **FACT** GH #78 requires code-tracked `OPEN / RESOLVED / CONTESTED / WITHDRAWN` findings, round-2 input containing exactly open findings and clear-conditions, contested planner evidence, mechanical re-raise and revision-citation checks, impasse/non-convergence exhaustion records, and unchanged two-round accounting (`gh issue view 78 --json number,title,body,url,labels`).
- **FACT** The architecture spec states that clear-conditions bind their author, a held contested finding is an impasse, and a new round-2 finding must cite revision-changed text (`docs/specs/afk-v2-agent-roles.md:65-83`, `docs/specs/afk-v2-agent-roles.md:252-282`).

## Relevant Files

- **FACT** `src/contract-review.ts` defines and strictly parses the version-1 review/finding schema, derives blocking/re-raised counts, and formats findings (`src/contract-review.ts:4-57`, `src/contract-review.ts:281-410`).
- **FACT** `src/orchestrator.ts` owns planner/evaluator rounds, prompt inputs, artifact loading, status transitions, extension assessment, escalation, and per-attempt archiving (`src/orchestrator.ts:712-830`, `src/orchestrator.ts:1534-1980`).
- **FACT** `src/artifacts.ts` names review archives and writes `stuck.md` plus negotiation archives (`src/artifacts.ts:276-369`, `src/artifacts.ts:410-493`).
- **FACT** `prompts/planner.md` is the runtime planner contract template and reserves optional `resolutions-rN.md` files without defining a machine response artifact (`prompts/planner.md:22-25`, `prompts/planner.md:125-190`).
- **FACT** `prompts/evaluator-contract.md` defines evaluator inputs and the exact current JSON/markdown outputs (`prompts/evaluator-contract.md:26-42`, `prompts/evaluator-contract.md:44-132`).
- **FACT** `agents/planner.md` and `agents/evaluator.md` are shipped role personas; their contract-negotiation sections describe two rounds and the canonical review (`agents/planner.md:121-132`, `agents/evaluator.md:23-56`).
- **FACT** `src/contract-review.test.ts` covers parser invariants, gap metrics, and rendering; `src/orchestrator.test.ts` covers REVISE-to-ACCEPT prompts, extensions, fail-closed artifacts, and archives (`src/contract-review.test.ts:58-524`, `src/orchestrator.test.ts:2052-2245`, `src/orchestrator.test.ts:2342-2833`).
- **FACT** `src/test-support.ts:9-42` supplies `writeContractReview`, the shared schema-valid fixture writer used by orchestrator, wave, and resume fixtures (`rg -n "writeContractReview" src -g "*.ts"`).
- **FACT** `src/cli-options.ts:1-10` and the three CLI entrypoints expose the configured contract-round cap (`src/afk.ts:34-102`, `src/afk-claude.ts:32-75`, `src/afk-codex.ts:32-75`).

## Existing Behavior in Touched Files

- **FACT** A review is exactly `{version: 1, verdict, findings}`; each finding is exactly `id`, `severity`, `behaviorIds`, `evidence`, `expected`, `observed`, and `clearCondition`, with no lifecycle state or planner-response fields (`src/contract-review.ts:28-80`, `src/contract-review.ts:197-267`).
- **FACT** Parsing rejects malformed JSON, duplicate JSON keys/IDs, missing or extra keys, wrong field types, `ACCEPT` with blocking findings, and `REVISE` without a blocking finding (`src/contract-review.ts:281-331`).
- **FACT** Current metrics count blocking findings and treat a blocking ID repeated from the previous review as re-raised; advisory findings do not count (`src/contract-review.ts:351-391`).
- **FACT** The next planner prompt receives every `lastFindings` entry, including advisory entries, plus a link to prior prose; it does not receive a computed open set (`src/orchestrator.ts:1637-1666`).
- **FACT** Round-2 evaluator input names the prior prose companion and asks for stable IDs, but supplies neither the previous structured review nor changed-revision text (`src/orchestrator.ts:1829-1843`).
- **FACT** Each evaluator attempt first deletes stale JSON/markdown, archives both outputs by round/attempt, and terminates with `ERROR` if the new JSON is missing or invalid (`src/orchestrator.ts:1821-1894`; `src/artifacts.ts:300-335`).
- **FACT** `ACCEPT` makes the orchestrator lock `contract.md`; `REVISE` leaves negotiation active; final failure writes structured findings into `stuck.md` and archives slice artifacts (`src/orchestrator.ts:1911-1978`; `src/artifacts.ts:429-486`).
- **FACT** Existing round logic can grant one extra round when blocking count falls and no ID repeats (`src/orchestrator.ts:729-763`, `src/orchestrator.ts:1924-1958`).

## Patterns in Use

- **FACT** Control flow trusts only schema-validated JSON; `feedback-rN.md` is a human companion with no parsed verdict or counts (`prompts/evaluator-contract.md:28-42`, `prompts/evaluator-contract.md:113-117`).
- **FACT** Raw JSON text is scanned before `JSON.parse` output is trusted because `JSON.parse` collapses duplicate keys (`src/contract-review.ts:111-190`, `src/contract-review.test.ts:131-191`).
- **FACT** The evaluator reuses stable finding IDs across rounds, and the orchestrator, not an agent, derives counts (`prompts/evaluator-contract.md:95-108`, `src/contract-review.ts:362-391`).
- **FACT** The orchestrator owns `LOCKED`/`NEGOTIATING`; evaluator and planner prompts do not own the final lock transition (`prompts/evaluator-contract.md:130-132`, `src/orchestrator.ts:1913-1922`).
- **FACT** Runtime prompts use `{{PLACEHOLDER}}` interpolation, and missing values fail prompt rendering tests (`src/prompt-template.test.ts:8-37`, `src/prompt-template.test.ts:101-114`).

## Test Infrastructure

- **FACT** Vitest discovers `src/**/*.test.ts`; tests run with two workers and hermetic Git environment variables (`vitest.config.ts:3-55`).
- **FACT** `src/contract-review.test.ts` is the existing pure-test boundary for gap metrics and finding formatting; the existing spawned REVISE-to-ACCEPT scenario captures second-round prompts (`src/contract-review.test.ts:452-524`, `src/orchestrator.test.ts:2052-2165`).
- **FACT** `pnpm test:fast` excludes orchestrator integration files; the touched heavy command is `pnpm run test:heavy:orchestrator` (`package.json:25-29`).
- **FACT** AFK slice handoff requires `pnpm test:fast` plus touched heavy suites, not the full suite (`AGENTS.md:26-38`).
- **FACT** Harness/config blast radius is `src/test-support.ts`, `src/orchestrator.fixtures.ts`, `vitest.config.ts`, `package.json`, `suite-budgets.json`, and `scripts/timed-suite.mjs`; the current orchestrator budget is 400 seconds (`src/orchestrator.fixtures.ts:104-120`, `package.json:23-33`, `suite-budgets.json:103-110`).

## Data Model

- **FACT** Negotiation data is filesystem JSON/Markdown under the slice and `.afk/artifacts/<run>/slice-<NN>/reviews`; no table, migration, or access-control implementation appears in the negotiation path (`src/contract-review.ts:334-348`, `src/artifacts.ts:276-335`).
- **FACT** The desired lifecycle is specified but absent from executable schema/code: repository search finds `CONTESTED`, `WITHDRAWN`, and negotiation `RESOLVED` only in specs/PRD (`rg -n "CONTESTED|WITHDRAWN|non-convergence|impasse" src prompts agents docs .kiro/specs/afk-v2-evidence-backbone`).

## Integration Boundaries

- **FACT** `orchestrator.ts` imports review parsing/metrics/formatting from `contract-review.ts`; `artifacts.ts` imports finding formatting/types for archives; tests and integration fixtures import `writeContractReview` (`src/orchestrator.ts:103-111`, `src/artifacts.ts:10-15`, `src/test-support.ts:3-7`).
- **FACT** Planner output is `contract.md` plus `acceptance-manifest.json`; evaluator output is `contract-review.json` plus `feedback-rN.md`; orchestration passes them through filesystem paths and prompt variables (`prompts/planner.md:56-59`, `prompts/evaluator-contract.md:72-117`, `src/orchestrator.ts:1735-1751`, `src/orchestrator.ts:1821-1845`).
- **FACT** Non-LOCKED negotiation outcomes flow from `runSliceNegotiate` into wave outcome classification (`src/orchestrator.ts:904-924`, `src/wave.ts:12-17`, `src/wave.ts:591-607`).

## Potential Conflicts

- **FACT** Commits `6d1dec4` and `cc26760` introduced the canonical parser and fail-closed orchestration immediately before this slice (`git log -8 --oneline -- src/contract-review.ts src/orchestrator.ts prompts/evaluator-contract.md`).
- **FACT** Slice 03 requires fixtures to use `writeContractReview`, records per-attempt archives, and defines reused IDs as re-raises (`.kiro/specs/afk-v2-evidence-backbone/slices/03-contract-review-fails-closed/handoff.md:41-53`, `.kiro/specs/afk-v2-evidence-backbone/slices/03-contract-review-fails-closed/handoff.md:87-90`, `.kiro/specs/afk-v2-evidence-backbone/slices/03-contract-review-fails-closed/handoff.md:116-120`).
- **FACT** Slice 02 requires negotiation fixtures to provide a version-2 manifest bound to a real discovered command (`.kiro/specs/afk-v2-evidence-backbone/slices/02-every-behavior-locks-with-an-executable-binding/handoff.md:19-23`).
- **FACT** GH #78 says max rounds remains 2, while current code defaults `--max-contract-rounds` to 3 and can add one extension; the existing unit test expects default 3 (`gh issue view 78 --json body`; `src/cli-options.ts:1`; `src/cli-options.test.ts:11`; `src/orchestrator.ts:1948-1955`).
- **FACT** No TODO/FIXME appears in the likely touched source, prompt, persona, or test files (`rg -n "TODO|FIXME" src/contract-review.ts src/orchestrator.ts src/artifacts.ts src/contract-review.test.ts src/orchestrator.test.ts src/test-support.ts prompts/evaluator-contract.md prompts/planner.md agents/evaluator.md agents/planner.md`).

## Unknowns

- **UNKNOWN** Which versioned artifact and exact fields record lifecycle transitions, planner contested evidence, evaluator hold/withdraw decisions, and both positions at impasse?
- **UNKNOWN** Does `contract-review.json` version increment, and must the parser accept archived version-1 artifacts?
- **UNKNOWN** What machine-readable source defines “revision-changed text” for validating a fresh round-2 finding: a contract diff, manifest diff, planner response, or quoted before/after text?
- **UNKNOWN** Do advisory findings participate in lifecycle/open-set routing, or only blocking findings?
- **UNKNOWN** Does “max negotiation rounds remains 2” replace the current default-3 plus extension behavior, or refer to another accounting boundary?
