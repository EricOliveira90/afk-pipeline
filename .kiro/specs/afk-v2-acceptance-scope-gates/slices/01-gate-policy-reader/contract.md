# Slice Contract — Gate policy reader

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #84
**Status:** LOCKED

**Lock-Provenance:** negotiation round 1
**Negotiation round:** 1

## Scope lock

Create `src/gate-policy.ts`, the first reader of the optional top-level
`gatePolicy` object in the repo-root `afk.config.json`, and add that object to
this repository's own `afk.config.json` in prd.md D1's documented shape. Three
deliverables: two pure functions — `parseGatePolicy`, a validator over an
already-parsed value, and `matchesGlob`, a hand-rolled case-sensitive matcher
for the narrow D6 dialect — plus one explicitly impure function,
`loadGatePolicy(repoRoot)`, which reads `<repoRoot>/afk.config.json` and
delegates to the validator. All three ship with a success-path assertion. Every
rejection throws an `Error` naming the offending key, member, value or
character, per the `src/afk-manifest.ts` convention; nothing is silently
ignored (prd.md D1). No consumer is wired up: the gate runner, file-scope gate
and feedback channel are #195's and #193's, so with `gatePolicy` absent every
consumer still falls back to today's derived baseline in `src/base-gates.ts`.

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
`loadGatePolicy` parses with `parseJsonWithUniqueKeys` (`src/json-scan.ts`),
not bare `JSON.parse`, because a duplicated key in a hand-edited config would
silently drop a policy; and the unknown-key check is local here rather than a
new export from `src/acceptance-manifest.ts`, whose `requireExactKeys` is
module-private and out of scope to change.

### In scope

- [behavior:B-01] `src/gate-policy.ts` exports the surface pinned above and no
  other runtime value (GH #84 "What to build"; prd.md D1 ownership table).
- [behavior:B-02] `parseGatePolicy` accepts prd.md D1's example policy and
  returns it as a `GatePolicy` deep-equal to the input (GH #84, "a pure
  validator over an already-parsed object").
- [behavior:B-03] A policy omitting `protectedPaths`, `riskClasses`, or either
  member of `protectedPaths` parses and returns the documented baselines:
  `["afk.config.json", "suite-budgets.json"]`, `["**/*.test.ts"]`, and all
  three of `GATE_RISK_CLASSES` (GH #84 AC5; prd.md D1).
- [behavior:B-04] A malformed policy throws an `Error` naming the offending
  key — a non-object policy, a `protectedPaths` that is an array or string, a
  `gatePolicyPaths` holding a non-string, a non-array `riskClasses`
  (GH #84 AC1).
- [behavior:B-05] An unknown member throws an `Error` naming it, both at the
  top level (`cost` and `acceptance`, owned by #86 and #85 and unknown until
  they land) and inside `protectedPaths` (GH #84 AC2; prd.md D1).
- [behavior:B-06] A `version` that is absent, `2`, or `"1"` throws;
  `gatePolicy.version` is validated independently of `afk.config.json`'s own
  top-level `version` (GH #84 AC3).
- [behavior:B-07] An unrecognised string in `riskClasses` throws at parse time,
  naming it (GH #84 AC6; prd.md D1 and D5's three classes).
- [behavior:B-08] `loadGatePolicy(repoRoot)` returns the validated policy when
  `<repoRoot>/afk.config.json` carries a well-formed `gatePolicy`, `null` when
  the file is absent and when it carries no `gatePolicy`, and propagates the
  validator's `Error` when the policy is malformed (GH #84 AC7).
- [behavior:B-09] `matchesGlob` implements the D6 dialect: literal segments,
  `*` within one segment only, `**` over zero or more segments, on the path
  with backslashes normalized to forward slashes first (prd.md D6).
- [behavior:B-10] `matchesGlob` is case-sensitive on every platform: a path
  differing only in case does not match (prd.md D6; anchors "Do not conflate
  two case rules").
- [behavior:B-11] A `testGlob` outside the dialect throws an `Error` naming
  what it rejected — any of the metacharacters `? [ ] { } ( ) ! + @ \`, named
  individually, or the segment where `**` is not the whole segment. One shared
  validator runs from both `matchesGlob` and `parseGatePolicy`, so both refuse
  identically (GH #84 AC10; prd.md D6).
- [behavior:B-12] This repository's `afk.config.json` gains prd.md D1's
  example `gatePolicy` object as a fourth top-level key, and `loadGatePolicy`
  on the repository root returns it validated (GH #84; prd.md slice-01 map).

### Non-goals (explicit out-of-scope)

- Any gate or gate-runner change: `GateDeclaration.run`, `GateResult.findings`,
  gate id `scope` and the file-scope comparison are #195's (prd.md D22, D2–D4).
- The `GATE-SCOPE` channel, waivers, deletion and skip detection, and the
  risk-class-to-path association consuming `riskClasses` (#193; D5, D6's
  deletion rule, D7).
- The `acceptance` (#85) and `cost` (#86) members — unknown keys here, by B-05.
- Any runtime dependency for glob matching (prd.md D6).
- An `ARCHITECTURE.md` row; no check requires one and that file is shared.

### Existing behavior to preserve

- [behavior:P-01] `src/base-gates.ts:32` `resolveBaseGateDeclarations` still
  derives exactly the ids `["typecheck", "lint", "tests"]`, so a project with
  no `gatePolicy` keeps today's baseline catalog (GH #84 AC4; anchors, "#195
  owns the gate-runner changes").
- [behavior:P-02] `afk.config.json`'s `version`, `resourceKeys` and
  `architectureDoc` keep their current values; `gatePolicy` is added beside
  them (GH #84, "resourceKeys and architectureDoc are untouched").
- [behavior:P-03] `src/acceptance-manifest.ts:64` `normalizePath` stays
  case-**in**sensitive and its `fileScope` comparison is untouched;
  `src/gate-policy.ts` shares no implementation with it (prd.md D6; anchors,
  "Two comparisons, two purposes" — #194 lost a round to this conflation).

### Changes to existing behavior (only if the issue asks for it)

- `afk.config.json` gains the optional top-level `gatePolicy` key, authorized
  by GH #84 "What to build" and prd.md D1. No existing key changes.

## Files expected to change

- src/gate-policy.ts
- src/gate-policy.test.ts
- afk.config.json

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New config schema: the optional `gatePolicy` object, version `1`, widened
  later by #85 and #86 (prd.md D1).
- A glob dialect AFK owns: literal segments, `*`, `**`, case-sensitive
  (prd.md D6). No new npm dependency.

## Test plan

All assertions live in a new `src/gate-policy.test.ts` — pure unit tests, no
git, no spawned processes, so they run under `pnpm test:fast` (CLAUDE.md).
Filesystem cases use `mkdtempSync` with `rmSync` cleanup
(`src/afk-manifest.test.ts:1-23`); the repository root is
`fileURLToPath(new URL("..", import.meta.url))`
(`src/context-envelope.test.ts:87`).

- Given the pinned inputs of each behavior above, when the named export is
  called, then the manifest's `observableResult` for that behavior holds; the
  manifest is the authoritative given/when/then.
- The three static facts are assertions, not reviewer inspection:
  `resolveBaseGateDeclarations(repoRoot)` ids for P-01; `readFileSync` +
  `JSON.parse` over the committed `afk.config.json` for P-02 and B-12; and
  `readFileSync` over `src/gate-policy.ts` asserting no `toLowerCase`,
  no `toUpperCase` and no `./acceptance-manifest.js` import for P-03 and B-10.

## Definition of done

- [ ] `src/gate-policy.ts` exists and its sorted runtime exports equal the six
      pinned names; `pnpm run typecheck` accepts the pinned signatures.
- [ ] Every acceptance criterion of GH #84 has a passing assertion in
      `src/gate-policy.test.ts`, including the success path of
      `parseGatePolicy`, `loadGatePolicy` and `matchesGlob`.
- [ ] `afk.config.json` carries the `gatePolicy` block and its other three
      top-level keys are unchanged.
- [ ] `src/base-gates.ts`, `src/gate-runner.ts` and
      `src/acceptance-manifest.ts` are unmodified; no file outside the three
      declared paths changes.
- [ ] No entry was added to `package.json`'s dependencies.
- [ ] `pnpm vitest run src/gate-policy.test.ts` passes with nothing skipped,
      and `pnpm run typecheck` reports no error in the declared files.
