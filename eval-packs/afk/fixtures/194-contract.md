<!--
Hand-reconstructed fixture for eval-packs/afk case 04-194-f03-evaluator-contract.

Provenance: the round-1 `contract.md` the contract evaluator reviewed on
`run-20260908-014522` for PRD 4 slice 01 (#84), archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/` (#194
"Evidence"). That tree is gitignored and absent from this checkout, and the
`contract.md` committed at
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/contract.md`
is the *later* successful run's pair: slice 01 was split on 2026-09-08
(`9e888b8`, `71eb394`) so the committed contract carries twelve behaviors, no
`B-16`, and no casing defect. This file is therefore hand-authored to
reproduce the one condition #194 records about the round it lost: the contract
and `B-16` say `ARCHITECTURE.md`, while the acceptance manifest's `fileScope`
declares `architecture.md`.

Reconstructed from: #194's quotation of F-03 and of the manifest/contract
disagreement; #84 as of 2026-09-08 (pre-split, so this slice still carries the
feedback channel and the file-scope gate that became #193 and #195); the
committed slice-01 pair for section order, heading set and citation style; and
PRD 4's `prd.md` D1–D6. Nothing else about the pair is asserted as archived
fact — the casing mismatch is the load-bearing detail, and it is quoted
verbatim from the issue.
-->

# Slice Contract — Gate policy reader

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #84
**Status:** LOCKED

**Lock-Provenance:** negotiation round 1
**Negotiation round:** 1

## Scope lock

Create `src/gate-policy.ts`, the first reader of the optional top-level
`gatePolicy` object in the repo-root `afk.config.json`, add that object to this
repository's own `afk.config.json` in prd.md D1's documented shape, and wire the
two consumers this slice owns: the file-scope gate's comparison against
`gatePolicy.protectedPaths`, and the feedback channel that carries a refused
policy to the operator. Three pure deliverables — `parseGatePolicy`,
`matchesGlob` and `loadGatePolicy(repoRoot)` — plus the gate declaration
`scope` and the `GATE-SCOPE` feedback path. Every rejection throws an `Error`
naming the offending key, member, value or character, per the
`src/afk-manifest.ts` convention; nothing is silently ignored (prd.md D1).
`ARCHITECTURE.md` gains one row for the new module, because the module is a
public seam two later slices import.

Pinned surface of `src/gate-policy.ts`:

```ts
export type GateRiskClass = "gate-policy" | "deleted-test" | "skipped-test";
export const GATE_RISK_CLASSES: readonly GateRiskClass[];
export const DEFAULT_GATE_POLICY_PATHS: readonly string[];
export const DEFAULT_TEST_GLOBS: readonly string[];
export interface GatePolicyProtectedPaths {
  gatePolicyPaths: string[];
  testGlobs: string[];
}
export interface GatePolicy {
  version: 1;
  protectedPaths: GatePolicyProtectedPaths;
  riskClasses: GateRiskClass[];
}
export function parseGatePolicy(value: unknown, source?: string): GatePolicy;
export function loadGatePolicy(repoRoot: string): GatePolicy | null;
export function matchesGlob(glob: string, path: string): boolean;
```

Two calls recorded rather than escalated, both reversible before merge:
`loadGatePolicy` parses with `parseJsonWithUniqueKeys` (`src/json-scan.ts`), not
bare `JSON.parse`, because a duplicated key in a hand-edited config would
silently drop a policy; and the unknown-key check is local here rather than a
new export from `src/acceptance-manifest.ts`, whose `requireExactKeys` is
module-private and out of scope to change.

### In scope

- [behavior:B-01] `src/gate-policy.ts` exports the surface pinned above and no
  other runtime value (GH #84 "What to build"; prd.md D1 ownership table).
- [behavior:B-02] `parseGatePolicy` accepts prd.md D1's example policy and
  returns it as a `GatePolicy` deep-equal to the input (GH #84).
- [behavior:B-03] A policy omitting `protectedPaths`, `riskClasses`, or either
  member of `protectedPaths` parses and returns the documented baselines:
  `["afk.config.json", "suite-budgets.json"]`, `["**/*.test.ts"]`, and all three
  of `GATE_RISK_CLASSES` (GH #84 AC5; prd.md D1).
- [behavior:B-04] A malformed policy throws an `Error` naming the offending
  key — a non-object policy, a `protectedPaths` that is an array or string, a
  `gatePolicyPaths` holding a non-string, a non-array `riskClasses` (GH #84 AC1).
- [behavior:B-05] An unknown member throws an `Error` naming it, both at the top
  level (`cost` and `acceptance`, owned by #86 and #85 and unknown until they
  land) and inside `protectedPaths` (GH #84 AC2; prd.md D1).
- [behavior:B-06] A `version` that is absent, `2`, or `"1"` throws;
  `gatePolicy.version` is validated independently of `afk.config.json`'s own
  top-level `version` (GH #84 AC3).
- [behavior:B-07] An unrecognised string in `riskClasses` throws at parse time,
  naming it (GH #84 AC6; prd.md D1 and D5's three classes).
- [behavior:B-08] `loadGatePolicy(repoRoot)` returns the validated policy when
  `<repoRoot>/afk.config.json` carries a well-formed `gatePolicy`, `null` when
  the file is absent and when it carries no `gatePolicy`, and propagates the
  validator's `Error` when the policy is malformed (GH #84 AC7).
- [behavior:B-09] `matchesGlob` implements the D6 dialect: literal segments, `*`
  within one segment only, `**` over zero or more segments, on the path with
  backslashes normalized to forward slashes first (prd.md D6).
- [behavior:B-10] `matchesGlob` is case-sensitive on every platform: a path
  differing only in case does not match (prd.md D6).
- [behavior:B-11] A `testGlob` outside the dialect throws an `Error` naming what
  it rejected — any of the metacharacters `? [ ] { } ( ) ! + @ \`, named
  individually, or the segment where `**` is not the whole segment. One shared
  validator runs from both `matchesGlob` and `parseGatePolicy` (GH #84 AC10).
- [behavior:B-12] This repository's `afk.config.json` gains prd.md D1's example
  `gatePolicy` object as a fourth top-level key, and `loadGatePolicy` on the
  repository root returns it validated (GH #84; prd.md slice-01 map).
- [behavior:B-13] The gate runner gains a declaration whose id is `scope`,
  ordered after `typecheck` and before `tests`, which reads the launch policy
  once through `loadGatePolicy` and compares the candidate's changed set against
  `gatePolicy.protectedPaths.gatePolicyPaths` with `matchesGlob`
  (prd.md D2, D3).
- [behavior:B-14] A changed path matching `gatePolicyPaths` with no covering
  waiver fails the `scope` gate closed, and the `GateResult.findings` entry
  names the exact path and its risk class (prd.md D4, D5).
- [behavior:B-15] A refused or malformed `gatePolicy` reaches the operator
  through the feedback channel as a `GATE-SCOPE` finding rather than an
  uncaught throw, so a policy typo parks the slice instead of aborting the run
  (prd.md D7).
- [behavior:B-16] `ARCHITECTURE.md` gains one row for `src/gate-policy.ts` in
  the Gates section of the module table, naming the three exported functions as
  the public seam #85 and #86 import. `ARCHITECTURE.md` is the only document
  this slice edits.

### Non-goals (explicit out-of-scope)

- Deletion and skip detection, and the risk-class-to-path association consuming
  `riskClasses` beyond `gate-policy` (prd.md D6's deletion rule).
- The `acceptance` (#85) and `cost` (#86) members — unknown keys here, by B-05.
- Any runtime dependency for glob matching (prd.md D6).
- Any change to `src/acceptance-manifest.ts`.

### Existing behavior to preserve

- [behavior:P-01] `src/base-gates.ts:32` `resolveBaseGateDeclarations` still
  derives exactly the ids `["typecheck", "lint", "tests"]`, so a project with no
  `gatePolicy` keeps today's baseline catalog (GH #84 AC4).
- [behavior:P-02] `afk.config.json`'s `version`, `resourceKeys` and
  `architectureDoc` keep their current values; `gatePolicy` is added beside them
  (GH #84).
- [behavior:P-03] `src/acceptance-manifest.ts:64` `normalizePath` stays
  case-**in**sensitive and its `fileScope` comparison is untouched;
  `src/gate-policy.ts` shares no implementation with it, because the `scope`
  gate's glob comparison is case-sensitive and the manifest's path comparison is
  not (prd.md D6).

### Changes to existing behavior (only if the issue asks for it)

- `afk.config.json` gains the optional top-level `gatePolicy` key, authorized by
  GH #84 "What to build" and prd.md D1. No existing key changes.
- `src/gate-runner.ts` gains the `scope` declaration; the existing three
  declarations and their order are unchanged.

## Files expected to change

- src/gate-policy.ts
- src/gate-policy.test.ts
- src/gate-runner.ts
- afk.config.json
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New config schema: the optional `gatePolicy` object, version `1`, widened
  later by #85 and #86 (prd.md D1).
- A glob dialect AFK owns: literal segments, `*`, `**`, case-sensitive
  (prd.md D6). No new npm dependency.

## Test plan

Unit assertions live in a new `src/gate-policy.test.ts` — no git, no spawned
processes, so they run under `pnpm test:fast` (CLAUDE.md). Filesystem cases use
`mkdtempSync` with `rmSync` cleanup (`src/afk-manifest.test.ts:1-23`); the
repository root is `fileURLToPath(new URL("..", import.meta.url))`. The two gate
behaviors (B-13, B-14) add `it` blocks to the existing `src/gate-runner.test.ts`
scenario rather than a new spawned run (AGENTS.md assertion ladder).

- Given the pinned inputs of each behavior above, when the named export is
  called, then the manifest's `observableResult` for that behavior holds; the
  manifest is the authoritative given/when/then.
- The static facts are assertions, not reviewer inspection:
  `resolveBaseGateDeclarations(repoRoot)` ids for P-01; `readFileSync` +
  `JSON.parse` over the committed `afk.config.json` for P-02 and B-12;
  `readFileSync` over `src/gate-policy.ts` asserting no `toLowerCase`, no
  `toUpperCase` and no `./acceptance-manifest.js` import for P-03 and B-10; and
  `readFileSync` over `ARCHITECTURE.md` asserting the new row for B-16.

## Definition of done

- [ ] `src/gate-policy.ts` exists and its sorted runtime exports equal the six
      pinned names; `pnpm run typecheck` accepts the pinned signatures.
- [ ] Every acceptance criterion of GH #84 has a passing assertion in
      `src/gate-policy.test.ts`, including the success path of
      `parseGatePolicy`, `loadGatePolicy` and `matchesGlob`.
- [ ] `afk.config.json` carries the `gatePolicy` block and its other three
      top-level keys are unchanged.
- [ ] The `scope` gate declaration runs in the documented order and its failure
      finding names the exact path and risk class.
- [ ] `ARCHITECTURE.md` carries one new row for `src/gate-policy.ts`.
- [ ] `src/base-gates.ts` and `src/acceptance-manifest.ts` are unmodified; no
      file outside the five declared paths changes.
- [ ] No entry was added to `package.json`'s dependencies.
- [ ] `pnpm vitest run src/gate-policy.test.ts` passes with nothing skipped, and
      `pnpm run typecheck` reports no error in the declared files.
