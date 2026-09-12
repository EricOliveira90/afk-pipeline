<!--
Hand-reconstructed fixture for eval-packs/afk case 01-192-pre-restart-1-planner.

Provenance: the explorer evidence map the PRD 4 slice-01 planner read on
launch `run-20260907-223720`, archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-1/context.md`
(#192 "Evidence"). That tree is gitignored and absent from this checkout, so
this map is reconstructed from material this repository does carry: the shape
and the still-true FACTs of the committed
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/context.md`
(the later Claude-backend run's map), GH #84 as of 2026-09-07, and PRD 4's
`prd.md` at `93bf6bd`.

Reconstructed to the state of knowledge at this launch, which means two
deliberate differences from the committed map: the `#194` casing FACT and the
`src/gate-policy.ts` naming inferences are absent (both post-date 2026-09-08),
and D1's `gatePolicy` member shapes are recorded as an UNKNOWN, because
`fe2628a` ("fix D1's version-1 gatePolicy member shapes") had not been written
when this launch ran. That UNKNOWN is what the planner escalated.
-->

# Context — Slice 01 (#84): Gate policy reader

## Files and current behavior

- FACT: No module in `src/` reads `afk.config.json` today. A search for
  `afk.config.json` across `src/**/*.ts` (non-test) returns zero matches; the
  only repository hits are docs, spec files and the file itself
  (`afk.config.json`, `docs/specs/afk-v2-plan.md`, `ARCHITECTURE.md`,
  `.kiro/specs/afk-v2-acceptance-scope-gates/{prd.md,issues.md,afk.json}`).
  This slice creates the first reader.
- FACT: `afk.config.json` (repo root) currently holds exactly three top-level
  keys: `version` (`1`), `resourceKeys` (an object of regex strings) and
  `architectureDoc` (a path string) — `afk.config.json:1-7`. `gatePolicy` is a
  new, optional fourth top-level key; this slice must not touch the other
  three.
- FACT: `src/base-gates.ts` exports `resolveBaseGateDeclarations`,
  `resolvePreQAGateDeclarations` and `resolveFullSuiteGateDeclarations`, all
  built from `BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const`
  (`src/base-gates.ts:4-36`) via `projectSanityGateDeclarations`, which maps
  gate ids onto `resolveSanityPlan(cwd).steps` from `src/preship.ts`. This is
  the "derived baseline catalog" the issue says every consumer falls back to
  when `gatePolicy` is absent.

## Patterns and test harness

- FACT: `src/afk-manifest.ts` is the closest existing precedent for this
  slice's shape: a pure validator (`parseAfkManifest(value, source)`) that
  accepts an already-parsed value or JSON text and throws `Error` messages
  naming the offending field, plus a file-reading entry point
  (`loadAfkManifest(prdDir)`, `src/afk-manifest.ts:154-158`) that returns
  `null` when the file does not exist and otherwise delegates to the pure
  parser.
- FACT: `src/acceptance-manifest.ts:32-46` holds `requireExactKeys`, an
  exact-key validator that throws naming both unexpected and missing keys. It
  is not exported (no `export` keyword at `:32`), so it is not importable
  without editing that file.
- FACT: `src/json-scan.ts` exports `parseJsonWithUniqueKeys(text, source)`,
  which strips a leading BOM, calls `JSON.parse`, and refuses JSON repeating a
  key inside one object (`src/json-scan.ts:94-123`). `parseAfkManifest` uses
  bare `JSON.parse` instead (`src/afk-manifest.ts:54`), so both precedents
  exist and the issue settles neither.
- FACT: `src/afk-manifest.test.ts` is the test-file precedent: tempdir
  fixtures via `mkdtempSync(join(tmpdir(), "<prefix>-"))`, cleanup in
  `afterEach` through a `roots: string[]` array (`src/afk-manifest.test.ts:1-23`).
  This slice's tests are pure unit tests — no git, no spawned processes — so
  they belong in a new `src/gate-policy.test.ts`.

## Data and integration

- FACT: The issue's `## What to build` fixes the *key names* this slice owns —
  `version` (literal `1`), `protectedPaths` with optional `gatePolicyPaths` and
  `testGlobs` string arrays, and `riskClasses` as a flat array of three literal
  strings — and fixes the defaults for the two `protectedPaths` members.
- FACT: PRD 4's `prd.md` D1 (`@93bf6bd`) fixes only the *ownership split* of
  `gatePolicy`'s top-level keys across slices 01, 02 and 05, in a three-row
  table of "Key | Owner | Contents". It states no JSON shape for any member.
- FACT: `gatePolicy.version` is declared independent of `afk.config.json`'s
  existing top-level `version` (issue body), so the reader must not conflate
  the two version fields or reuse one check for both.
- FACT: Downstream consumers named in the issue are #85 (adds `acceptance`) and
  #86 (adds `cost`). Neither exists in `src/` yet; this slice's exports are the
  seam both will import.

## Unknowns

- UNKNOWN: The version-1 JSON shape of the `gatePolicy` members themselves —
  whether `protectedPaths` and `riskClasses` are required or optional members
  of `gatePolicy`; whether an empty `riskClasses` array is legal or refuses;
  whether an absent `protectedPaths` yields the documented defaults as a parsed
  value or is preserved as absent for a consumer to default. The issue lists
  the members and their contents; D1 lists their owners. Neither states the
  object shape a version-1 policy must satisfy, and no reader in `src/` has one
  to copy — this slice writes the first one, and #85 and #86 widen exactly this
  shape.
- UNKNOWN: Whether `requireExactKeys` is meant to be exported and reused or
  whether `gate-policy.ts` defines its own local key check.
- UNKNOWN: Whether the new module needs a row in `ARCHITECTURE.md`'s module
  table. The Gates row lists `src/gate-runner.ts`, `src/base-gates.ts`,
  `src/candidate-gate-phase.ts` and `src/post-qa-gates.ts` as public seam;
  nothing for a policy reader is listed on either side.
- UNKNOWN: The exact wording required of the "refuses the launch" messages,
  beyond the `` throw new Error(`${source} <field> <problem>`) `` convention
  `afk-manifest.ts` and `acceptance-manifest.ts` share.
