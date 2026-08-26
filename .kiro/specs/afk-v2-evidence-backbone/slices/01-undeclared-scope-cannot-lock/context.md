# Slice 01 Context: Undeclared Scope Cannot Lock

## Issue Baseline

- **FACT** — GH issue #75 requires a minimal acceptance manifest containing declared file scope and migration count; missing, empty, placeholder, or malformed scope must spend a planner round and be refused before contract evaluation, while concrete and explicit no-change declarations may lock (`gh issue view 75`).
- **FACT** — The parent PRD assigns this slice US-5, US-12–15, and US-19 and requires preservation of DAG, wave, lane, narrowed-run, resume, cancellation, MERGE-PENDING, and blocked-ship behavior (`.kiro/specs/afk-v2-evidence-backbone/prd.md:20`, `:28`, `:35-42`, `:52-53`; `.kiro/specs/afk-v2-evidence-backbone/issues.md:7`).
- **FACT** — HEAD already includes six #75 commits implementing manifest refusal, lane and migration consumption, prior-lock reopening, and parser hardening (`git log --oneline -- src/acceptance-manifest.ts src/orchestrator.ts src/wave.ts prompts/planner.md`: `6fcbd50`, `c943077`, `4384a59`, `cc15f98`, `21f3b2b`, `21085ef`).

## Relevant Files

- **FACT** — `src/acceptance-manifest.ts` defines `AcceptanceManifest`, strict parsing/loading, path normalization, and conversion of explicit no-change scope to `[]` (`src/acceptance-manifest.ts:1-7`, `:60-155`).
- **FACT** — `src/orchestrator.ts` owns planner/evaluator negotiation, manifest pre-evaluator refusal, prior-lock reopening, round accounting, and the post-ACCEPT lock callback (`src/orchestrator.ts:1211-1225`, `:1322-1400`, `:1427-1529`, `:1531-1605`).
- **FACT** — `src/wave.ts` supplies migration lock policy, loads validated manifest paths into each locked `Slice.files`, partitions lanes, and preserves downstream wave execution (`src/wave.ts:110-164`, `:208-288`, `:334-348`).
- **FACT** — `src/migration-claims.ts` reads manifest `migrationCount` and paths for prefix claims and generated-file validation (`src/migration-claims.ts:136-180`, `:183-220`, `:262-292`).
- **FACT** — `src/issues-parser.ts` documents `Slice.files` as manifest-populated after lock; `undefined` remains conservative unknown scope and `[]` means explicit no repository changes (`src/issues-parser.ts:3-19`).
- **FACT** — `src/lanes.ts` normalizes paths, unions overlaps and migration resources, conservatively unions undefined scope with the wave, and leaves explicit empty scope separate (`src/lanes.ts:74-95`, `:141-165`, `:190-247`).
- **FACT** — `src/artifacts.ts` keeps contract status orchestrator-owned through `lockContract()` and `reopenContract()` (`src/artifacts.ts:418-446`).
- **FACT** — `prompts/planner.md` requires exact prose paths plus a version-1 `acceptance-manifest.json`, with either non-empty exact paths or `no-repository-changes` and migration count zero (`prompts/planner.md:35-63`, `:117-131`).
- **FACT** — Focused tests are `src/acceptance-manifest.test.ts`, `src/orchestrator.test.ts`, `src/wave.test.ts`, `src/migration-claims.test.ts`, `src/lanes.test.ts`, and `src/artifacts.test.ts` (respective test declarations at `:6`, `:1755`, `:429`, `:52`, `:32`, `:415`).

## Existing Behavior In Touched Files

- **FACT** — The parser accepts only exact root/file-scope keys and version 1; migration count must be a non-negative safe integer (`src/acceptance-manifest.ts:9-23`, `:73-94`, `:103-128`).
- **FACT** — Concrete paths are trimmed, slash-normalized, lowercased, non-empty, unique, exact repo-relative files; placeholders, globs, absolute paths, repeated separators, trailing separators, and dot segments fail (`src/acceptance-manifest.ts:25-57`, `:129-137`; `src/acceptance-manifest.test.ts:33-50`).
- **FACT** — Explicit `no-repository-changes` accepts no extra fields and requires `migrationCount: 0`; missing manifests fail closed (`src/acceptance-manifest.ts:104-115`, `:141-146`).
- **FACT** — Every planner round deletes the previous manifest, invokes the planner, validates the newly written manifest, and only then increments/invokes the evaluator round (`src/orchestrator.ts:1450-1506`, `:1531-1570`).
- **FACT** — Invalid manifests create `contract-lock-refused` warnings, return the exact parser defect in the next planner prompt, do not create evaluator feedback, and escalate when planner rounds expire (`src/orchestrator.ts:1378-1424`, `:1498-1528`; `src/orchestrator.test.ts:1755-1828`).
- **FACT** — A prior `LOCKED` contract with a missing/invalid manifest is reopened to `NEGOTIATING` before evaluator or generator invocation (`src/orchestrator.ts:1427-1447`; `src/wave.test.ts:2236-2313`).
- **FACT** — Evaluator ACCEPT still causes the orchestrator to write `LOCKED`; an external lock-gate objection reopens it and uses the ordinary round budget (`src/orchestrator.ts:1593-1605`; `src/artifacts.ts:425-446`).
- **FACT** — Lanes use machine scope rather than prose: normalized overlapping manifest paths share a lane and explicit no-change gets a singleton lane (`src/wave.ts:274-288`; `src/wave.test.ts:429-490`).
- **FACT** — Manifest-less planners never reach lane partitioning, regardless of prose file-list shape (`src/wave.test.ts:556-654`).
- **FACT** — Manifest migration count controls claim allocation, and manifest migration paths must match assigned prefixes; prose migration declarations are not the machine source (`src/migration-claims.ts:147-180`, `:269-291`; `src/migration-claims.test.ts:166-223`).
- **FACT** — Legacy migration collision checks read manifest paths, while the merge-mutex authority and MERGE-PENDING/real-CONFLICT behavior remain present (`src/wave.ts:134-163`; `src/wave.test.ts:1919-1960`, `:2325-2466`).

## Patterns In Use

- **FACT** — Validators throw defect-specific `Error` messages and reject unknown/missing keys via `requireExactKeys()` (`src/acceptance-manifest.ts:9-23`, `:60-139`).
- **FACT** — Node ESM imports use `.js` suffixes from TypeScript, and exported APIs use explicit interfaces/functions (`src/acceptance-manifest.test.ts:1-4`; `src/acceptance-manifest.ts:1`, `:60`, `:141`, `:149`).
- **FACT** — Orchestration tests use real temporary git repositories plus stub `AgentProvider.invoke()` implementations and assert disk artifacts, events, counters, and outcomes (`.kiro/specs/afk-v2-evidence-backbone/prd.md:55-60`; `src/orchestrator.test.ts:1757-1827`).
- **FACT** — Machine scope and migration count are read through `loadAcceptanceManifest()` by all current consumers rather than reparsing contract prose (`src/wave.ts:134-136`, `:279-281`; `src/migration-claims.ts:140-143`, `:152-153`, `:277-279`).

## Test Infrastructure

- **FACT** — Vitest includes `src/**/*.test.ts`, uses two worker threads, 60-second test/hook timeouts, and ignores worker unhandled-error reporting because git-heavy synchronous work can block reporter RPC (`vitest.config.ts:3-35`).
- **FACT** — `pnpm test:fast` excludes the heavy orchestrator, wave, resume-integration, QA-orchestration, clean-failed, and E2E suites; targeted commands are `pnpm vitest run src/<file>.test.ts` (`package.json:23-32`; repository `AGENTS.md` test-loop instructions).
- **FACT** — This area's heavy blast radius is `src/orchestrator.test.ts` and `src/wave.test.ts`; focused parser/claim tests remain in the fast suite (`package.json:23-30`; `src/acceptance-manifest.test.ts:6`; `src/migration-claims.test.ts:52`).
- **FACT** — Shared Windows fixture cleanup is `rmDirWithRetry()` in `src/test-support.ts`; existing claim tests instead maintain temporary roots and remove them in `afterEach` (`src/test-support.ts:1-31`; `src/migration-claims.test.ts:17-21`).
- **FACT** — The slice handoff reports the full `pnpm test` run exited 0 despite an ignored Vitest worker-RPC timeout (`.kiro/specs/afk-v2-evidence-backbone/slices/01-undeclared-scope-cannot-lock/handoff.md:15-20`).

## Data Model

- **FACT** — `acceptance-manifest.json` version 1 is `{ version: 1, fileScope: { kind: "paths", paths: string[] } | { kind: "no-repository-changes" }, migrationCount: number }` (`src/acceptance-manifest.ts:1-7`).
- **FACT** — No database table or migration is introduced by this slice; migration metadata is a count plus declared paths used by the existing run-state claim flow (`src/migration-claims.ts:269-291`; `docs/adr/0034-afk-manifest-and-migration-claims.md:100-109`).

## Integration Boundaries

- **FACT** — Planner output enters through `prompts/planner.md`; `runSliceNegotiate()` validates it before `evaluator-contract`; `runWave()` then feeds normalized paths to lanes and migration gates (`prompts/planner.md:44-63`; `src/orchestrator.ts:1472-1547`; `src/wave.ts:274-288`).
- **FACT** — `acceptance-manifest.ts` exports `AcceptanceManifest`, `parseAcceptanceManifest`, `loadAcceptanceManifest`, `acceptanceManifestPaths`, and `ACCEPTANCE_MANIFEST_FILENAME` (`src/acceptance-manifest.ts:1`, `:60`, `:141`, `:149`, `:159`).
- **FACT** — The npm package exports only `./afk-manifest`; the acceptance-manifest API is internal source-module surface (`package.json:11-16`).

## Potential Conflicts

- **FACT** — Current branch diff from `origin/main` includes the #75 implementation plus PRD/recovery documentation; likely implementation files are already changed on HEAD (`git diff --name-only origin/main...HEAD`).
- **FACT** — No `TODO` or `FIXME` occurs in the scoped source, tests, or planner prompt (`rg -n "TODO|FIXME" src/acceptance-manifest.ts src/orchestrator.ts src/wave.ts src/acceptance-manifest.test.ts src/orchestrator.test.ts src/wave.test.ts prompts/planner.md` returned no matches).
- **FACT** — The only discovered `handoff.md` under this PRD's slices is this slice's own handoff; it warns that prose file/migration sections remain human views and no longer drive lanes, claims, or collision gates (`Get-ChildItem .kiro/specs/afk-v2-evidence-backbone/slices -Recurse -Filter handoff.md`; slice `handoff.md:15-17`).

## Unknowns

- **UNKNOWN** — Should the planner contract treat the already-merged #75 implementation on this recovered branch as the implementation baseline to verify, or expect additional source changes?
- **UNKNOWN** — The issue requests “schema-validated” parsing, but the current implementation is a handwritten strict validator rather than an external schema library; no issue comment clarifies whether that distinction matters (`gh issue view 75` reports zero comments).
