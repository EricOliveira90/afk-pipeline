# Context — Slice 01 (#84): Gate policy reader

## Files and current behavior

- FACT: No module in `src/` reads `afk.config.json` today; this slice creates
  the first reader. The file holds exactly three top-level keys — `version`
  (`1`), `resourceKeys`, `architectureDoc` (`afk.config.json:1-7`) — and
  `gatePolicy` is a new, optional fourth key this slice must add without
  touching the other three.
- FACT: **`package.json` has no `dependencies` key at all.** AFK ships with
  zero runtime dependencies; the only installed packages are devDependencies
  (TypeScript, vitest, the linter). Adding one is a repository-level decision
  nothing in this PRD authorizes, and #84 states it outright: "AFK has **no
  runtime dependencies**; do not add one."
- FACT: **`src/` contains no glob matcher.** A search across `src/**/*.ts` for
  `minimatch`, `fnmatch`, `globToRegExp`, `picomatch` and for a `*`-expanding
  path comparison returns nothing. Every existing path comparison in the
  repository is either exact-after-normalization (`normalizePath`,
  `src/acceptance-manifest.ts:64-71`) or a hand-written `RegExp` over a
  configured pattern string (`resourceKeys` in `afk.config.json`, read by
  `laneResourceGroups`). There is no dialect in the codebase to be
  "compatible" with.
- FACT: `src/base-gates.ts` holds the derived baseline catalog
  (`BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const`,
  `src/base-gates.ts:4-36`) that every consumer falls back to when `gatePolicy`
  is absent. This slice reads that relationship and does not edit the module.

## Patterns and test harness

- FACT: `src/afk-manifest.ts` is the shape precedent: a pure validator
  (`parseAfkManifest(value, source)`) throwing `Error` messages that name the
  offending field, plus `loadAfkManifest(prdDir)`
  (`src/afk-manifest.ts:154-158`) — an `existsSync` gate, `null` when the file
  is absent, otherwise delegation to the pure parser. `loadGatePolicy(repoRoot)`
  mirrors it.
- FACT: `requireExactKeys` (`src/acceptance-manifest.ts:32-46`) is the
  exact-key check the repository already uses, throwing on both unexpected and
  missing keys. It is not exported (`:32` carries no `export`).
- FACT: `src/afk-manifest.test.ts:1-23` is the harness precedent — tempdir
  fixtures via `mkdtempSync`, cleanup in `afterEach` through a `roots: string[]`
  array. A glob matcher and a config validator are both pure functions, so this
  slice's whole test surface is unit tests in a new `src/gate-policy.test.ts`,
  with no git and no spawned process; it is not one of the heavy spawning suites
  and needs no `test:heavy:*` script.
- FACT: The repository holds two path comparisons that are deliberately not the
  same. `normalizePath` lowercases (`src/acceptance-manifest.ts:64-71`) and is
  what `fileScope` is stored and compared through; the `testGlobs` matcher this
  slice writes is specified **case-sensitive on every platform** (#84). They
  must not share an implementation.

## Data and integration

- FACT: PRD 4's `prd.md` D6 (`@93bf6bd`) fixes the *rule*: a path matching
  `gatePolicy.protectedPaths.testGlobs` that exists on the comparison base and
  not in the candidate tree is a deletion; absent policy the default glob
  `**/*.test.ts` applies; a deletion fails closed naming the exact path unless
  a D5 waiver covers it.
- FACT: #84 fixes the matcher's *surface*: literal segments, `*` within one
  segment, `**` for zero or more segments, over paths normalized to forward
  slashes, case-sensitive on every platform, and any other metacharacter in a
  `testGlob` refuses the launch naming the character. The matcher is exported
  from `src/gate-policy.ts` and #195 and #193 call it rather than writing a
  second.
- FACT: D5 is fully settled at this launch: the record lives in the PRD
  directory's `afk.json` as `protectedChangeWaivers`, an array of
  `{ riskClass, path, author, reason }`, read once at launch; the three
  `riskClass` literals are `gate-policy`, `deleted-test`, `skipped-test`; an
  unknown `riskClass` fails closed at launch; contract file scope never implies
  a waiver.
- FACT: `gatePolicy.version` is its own schema version, independent of
  `afk.config.json`'s top-level `version` (#84).

## Unknowns

- UNKNOWN: The exact wording required of the "refuses the launch" messages,
  beyond the `` throw new Error(`${source} <field> <problem>`) `` convention
  `afk-manifest.ts` and `acceptance-manifest.ts` share.
- UNKNOWN: Whether `requireExactKeys` is meant to be exported and reused or
  whether `gate-policy.ts` defines its own local key check. It is not currently
  exported, so reuse would need an edit to `src/acceptance-manifest.ts`.
- UNKNOWN: Whether `src/gate-policy.ts` needs a row in `ARCHITECTURE.md`'s
  module table; nothing for a policy reader is listed on either side of the
  Gates row today, and this slice's write boundary does not cover that file.
- UNKNOWN: Whether the parsed policy gets an exported type name analogous to
  `AfkManifest`; #84 describes the shape without naming a type.
