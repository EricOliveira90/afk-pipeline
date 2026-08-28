# Slice Contract — Undeclared Scope Cannot Lock

**Parent PRD:** .kiro/specs/afk-v2-evidence-backbone/prd.md
**GH issue:** #75
**Status:** LOCKED
**Negotiation round:** 2

## Scope lock
This slice delivers the minimal versioned acceptance manifest for file scope and migration count, rejects absent or invalid machine scope before contract evaluation, and makes lane and migration consumers use that validated declaration. It excludes behavior/gate bindings, finding and verdict artifacts, gate execution, and new pipeline outcomes (GH #75 "What to build"; PRD Solution, Implementation Decisions, and Out of Scope).

### Non-goals (explicit out-of-scope)
- Behavior IDs, gate catalog bindings, and contract-manifest behavior coverage (GH #75 limits this slice to the "minimal acceptance manifest"; PRD Implementation Decisions).
- Executing acceptance or coverage gates (PRD Out of Scope).
- Finding lifecycle, canonical verdicts, and adjudication routing (PRD Solution; PRD Out of Scope).
- Replacing the merge-mutex migration authority or adding outcomes or rounds (ADR 0028; GH #75 says the claims flow is otherwise unchanged).

### In scope
- A strict version-1 `acceptance-manifest.json` represents either non-empty exact repo-relative file paths or explicit `no-repository-changes`, plus a non-negative migration count (GH #75 AC 3 and 5; PRD US-5, US-18-19).
- Missing files, malformed JSON, empty path arrays, `<unknown>` placeholders, `src/*.ts` globs, `src/` trailing-separator directory shapes, and paths duplicated after normalization fail closed with a defect naming the rejected class (GH #75 AC 1 and 5; PRD US-12).
- Each planner round must write a fresh manifest; an invalid declaration consumes that planner round, emits existing `contract-lock-refused` evidence with the parser defect, and invokes neither contract evaluator nor generator (GH #75 AC 1 and 5; ADR 0028 refusal pattern; PRD US-13).
- A valid concrete declaration reaches contract evaluation; evaluator `ACCEPT` produces the orchestrator-owned `LOCKED` status, after which normalized manifest paths populate slice scope and drive overlap-based lane partitioning rather than prose (GH #75 AC 2; PRD US-15).
- Explicit `no-repository-changes` with migration count zero can lock and remains distinguishable from unknown scope (GH #75 AC 3; PRD US-5).
- Migration reservation claims use manifest migration count and paths; legacy collision checks use the same paths while their authority and flow remain unchanged (GH #75 AC 4; PRD US-19; ADR 0028).
- A prior `LOCKED` contract with a missing or invalid manifest reopens to `NEGOTIATING` and passes through the same pre-evaluator refusal path (PRD preservation decision; ADR 0028 prior-lock rule).

### Existing behavior to preserve
- Contract evaluator `ACCEPT` still causes orchestrator-owned status transition to `LOCKED` — `src/orchestrator.ts:runSliceNegotiate`.
- DAG, wave continuation, normalized overlap lanes, cancellation, resumption, `MERGE-PENDING`, and blocked-ship semantics remain unchanged — GH #75 AC 6; PRD Implementation Decisions.
- Migration claims remain stable across rounds and runs, and the merge-mutex collision check remains authoritative — `src/migration-claims.ts`; ADR 0028.
- `contract.md` retains human-readable file and migration sections, while planner/evaluator markdown remains available to people — GH #75 "What to build"; PRD M1.

### Changes to existing behavior (only if the issue asks for it)
- Prose file scope stops driving lanes and migration claims: "Lane partitioning and migration claims read the validated manifest declaration; the prose \"Files expected to change\" section remains as the human view only." — GH #75.
- Scope validation moves before judgment: "A deterministic lock gate runs before the contract evaluator is invoked." — GH #75.

## Files expected to change
- prompts/planner.md
- src/acceptance-manifest.test.ts
- src/acceptance-manifest.ts
- src/issues-parser.ts
- src/migration-claims.test.ts
- src/migration-claims.ts
- src/orchestrator.test.ts
- src/orchestrator.ts
- src/resume-integration.test.ts
- src/wave.test.ts
- src/wave.ts

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- New internal version-1 JSON schema: `{ version: 1, fileScope: { kind: "paths", paths: string[] } | { kind: "no-repository-changes" }, migrationCount: number }`; strict keys, no new dependency (GH #75; PRD M1).

## Test plan
- Given each declaration in this matrix, when parsed, then it fails with the stated defect: absent file -> `is missing`; malformed `{` -> `not valid JSON`; `paths: []` -> `non-empty paths`; `["<unknown>"]` -> `placeholder`; `["src/*.ts"]` -> `glob syntax`; `["src/"]` -> `file path`; `["./SRC/a.ts", "src/a.ts"]` -> `unique`.
- Given an initially missing or invalid manifest, when negotiation runs with invocation recording, then one planner round is consumed, `contract-lock-refused` names the parser defect, and both evaluator-contract and generator invocation counts are zero.
- Given round one writes a valid manifest and receives `REVISE`, when round two omits the manifest, then stale data is absent and round two is refused before its evaluator or generator invocation.
- Given a stub planner writes a concrete manifest for `src/a.ts` and leaves status `NEGOTIATING`, when the stub evaluator returns `ACCEPT`, then evaluator invocation count is one and the contract on disk is orchestrator-owned `LOCKED`.
- Given two locked contracts whose normalized manifest paths overlap while prose differs, when the wave partitions lanes, then `lanes-partitioned` places them in the same lane from manifest scope.
- Given explicit `no-repository-changes` with count zero, when negotiation and lane partitioning run, then it locks and is represented as known empty scope rather than unknown scope.
- Given reserved migration prefixes, when manifest count or paths disagree with the claim, then lock is refused; matching values proceed. Given legacy mode, manifest paths feed ADR 0028 collision refusal.
- Given a prior locked contract without a valid companion manifest, when resumed, then it reopens before evaluator or generator invocation and receives the manifest defect.
- Given the slice implementation, when the evaluator runs `pnpm test:fast`, `pnpm vitest run src/orchestrator.test.ts`, and `pnpm vitest run src/wave.test.ts`, then each command exits zero with these scenarios covered.

## Definition of done
- [ ] The version-1 parser accepts only concrete paths or explicit no-change scope and emits the matrix's class-specific defects.
- [ ] Missing or invalid manifests cannot reach contract evaluation or generation and produce refusal evidence with correct planner-round accounting.
- [ ] A concrete manifest can pass the pre-evaluator gate and reach orchestrator-owned `LOCKED`.
- [ ] Locked slices use manifest scope for lanes and manifest count/paths for migration claims and legacy collision checks.
- [ ] Explicit no-change scope locks as known empty scope, while invalid prior locks reopen for correction.
