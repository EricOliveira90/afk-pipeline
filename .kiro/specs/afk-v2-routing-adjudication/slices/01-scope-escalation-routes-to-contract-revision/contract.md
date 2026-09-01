# Slice Contract — Scope escalation routes to contract revision

**Parent PRD:** .kiro/specs/afk-v2-routing-adjudication/prd.md
**GH issue:** #80
**Status:** LOCKED
**Negotiation round:** 2

## Scope lock
Deliver the generator-side pre-build route from a validated scope escalation to one focused planner/evaluator contract revision, then resume generation under the revised lock without spending the escalating implementation round (GH #80; PRD stories 1, 2, 13).

### In scope
- [behavior:B-01] Given any initial, repair, or resumed generator finds that a cited finding's correct fix needs an undeclared path, when it stops before making that out-of-scope edit, then it writes the version-1 `escalation.md` payload with non-empty `findingIds`, `paths`, and `reason` (GH #80 What to build; PRD story 1).
- [behavior:B-02] Given `escalation.md` is missing a finding ID or path, has a blank reason, extra/wrong-typed fields, or a non-declarable, declared, or migration path, when the orchestrator validates it, then the slice ends `ERROR`, no planner or gate runs, and the raw artifact is retained (GH #80 AC2/AC4; PRD story 13; ADR 0048).
- [behavior:B-03] Given a valid escalation names an undeclared non-migration path, when the generator returns, then the orchestrator archives the attempt, spends no implementation round, and sends its finding IDs, paths, and reason through one focused planner revision and fresh contract evaluation (GH #80 AC1; PRD Implementation Decisions).
- [behavior:B-04] Given the revised contract and manifest declare the requested scope and the evaluator accepts them, when the orchestrator re-locks the contract, then a fresh generator invocation runs with the revised scope and the same remaining implementation-round budget (GH #80 AC3; PRD Implementation Decisions).
- [behavior:B-05] Given generator invocations produce valid or malformed escalations, when attempts are archived, then each raw file is stored under `.afk/artifacts/<run-slug>/slice-<n>/reviews/` as `escalation-r<round>-a<attempt>.md`, and an existing archive is never overwritten (GH #80 AC2/AC5; ADR 0048 archive convention).

### Non-goals (explicit out-of-scope)
- QA-side `SCOPE_AMENDMENT`, direct orchestrator amendment instead of planner/evaluator revision, or changes to QA re-grading (GH #80 boundary; ADR 0048).
- Adjudication, impasse parking, bounded human waits, stuck-diagnosis assembly, or `afk adopt` (PRD stories 3-12, 16-17).
- Cleaner, hardener, remediator consumers, prompt-envelope redesign, or new terminal status taxonomy (PRD Out of Scope and Implementation Decisions).

### Existing behavior to preserve
- [behavior:P-01] Given a generator emits no escalation, when it returns normally, then migration checks, base gates, QA, retries, and existing `PASS`/`STUCK`/`ERROR`/`CANCELLED` outcomes proceed unchanged (PRD Implementation Decisions).
- [behavior:P-02] Given ordinary contract negotiation or revision, when planner/evaluator artifacts are processed, then exact artifact validation, the two-round cap, orchestrator-owned lock transitions, and round/attempt archives remain intact (PRD parent dependency; GH #80 revision-template requirement).
- [behavior:P-03] Given QA requests `SCOPE_AMENDMENT` for already-written correct work, when QA routing runs, then `planScopeAmendment`/`applyScopeAmendment`, amendment records, and same-round re-grading retain ADR 0048 behavior (GH #80 boundary; ADR 0048).

### Changes to existing behavior (only if the issue asks for it)
- Generator handling of required undeclared work changes from keeping/reverting it for later QA handling to: “a fix outside the declared files is never yours to make - escalate, do not edit, do not stall” (GH #80 What to build).

## Files expected to change
- agents/generator.md
- prompts/generator.md
- prompts/generator-resume.md
- prompts/generator-resume-stuck.md
- src/escalation.ts
- src/escalation.test.ts
- src/artifacts.ts
- src/artifacts.test.ts
- src/scope-amendment.ts
- src/scope-amendment.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/orchestrator.fixtures.ts
- src/prompt-template.test.ts

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- `escalation.md` contains only `{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}`. Keys are exact; arrays contain distinct non-blank strings; paths use acceptance-manifest normalization and ADR 0048 migration refusals. No new dependency.

## Test plan
- Given each current generator prompt, when rendered, then it names the exact artifact schema and directs the generator to stop before an undeclared edit.
- Given valid and invalid payload matrices, when parsed with focused tests, then only exact, non-empty, declarable scope requests pass.
- Given two attempts for one round, when archived, then both stamped files remain and a duplicate destination is refused.
- Given a stub generator submits `{"findingIds":["F-17","F-18"],"paths":["src/extra-a.ts","src/extra-b.ts"],"reason":"both parser modules must change"}`, when `pnpm run test:heavy:orchestrator` drives the slice, then the captured focused-planner input contains that exact evidence, the captured fresh-generator input contains the evaluator-accepted locked manifest's complete revised `fileScope` including both paths, planner/evaluator run before fresh generation, and the generator round count is unchanged.
- Given malformed and absent-field escalation variants, when the heavy orchestration scenario runs, then it returns `ERROR`, preserves raw evidence, and records no planner, gate, or QA invocation.
- Given the completed slice, when the evaluator runs `pnpm run typecheck` and `pnpm test:fast`, then the changed parser, archive, amendment, prompt, and type contracts pass.

## Definition of done
- [ ] Every generator template emits the same canonical scope-escalation instruction and schema.
- [ ] Valid escalation evidence reaches the focused planner exactly, and the evaluator-accepted revised lock reaches fresh generation without consuming the escalating implementation round.
- [ ] Invalid escalation fails closed with its raw attempt archived and no downstream execution.
- [ ] Attempt archives are round/attempt stamped and non-overwriting.
- [ ] Existing normal generation, contract negotiation, and QA amendment paths retain their specified behavior.
