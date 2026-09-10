# Handoff — slice 01 (#84), gate policy reader

- New migration files: 0

## What shipped

- `B-01`: `src/gate-policy.ts` — the module's six runtime exports and nothing
  else; every type is `export type`/`export interface`, so it is erased.
- `B-02`: `src/gate-policy.ts:parseGatePolicy`
- `B-03`: `src/gate-policy.ts:parseProtectedPaths` and `parseGatePolicy`'s
  `riskClasses` default, over `DEFAULT_GATE_POLICY_PATHS`,
  `DEFAULT_TEST_GLOBS` and `GATE_RISK_CLASSES` (spread into fresh arrays).
- `B-04`: `src/gate-policy.ts:parseGatePolicy`, `parseProtectedPaths`,
  `parseStringArray`
- `B-05`: `src/gate-policy.ts:requireKnownKeys`
- `B-06`: `src/gate-policy.ts:parseGatePolicy`'s `input.version !== 1` check
- `B-07`: `src/gate-policy.ts:parseRiskClasses`
- `B-08`: `src/gate-policy.ts:loadGatePolicy`
- `B-09`: `src/gate-policy.ts:matchesGlob`, `matchesFrom`, `matchesSegment`
- `B-10`: `src/gate-policy.ts:matchesSegment` (literal `===`,
  `startsWith`/`endsWith`/`indexOf` — no case folding anywhere in the module)
- `B-11`: `src/gate-policy.ts:assertGlobDialect`, called from both
  `matchesGlob` and `parseProtectedPaths`
- `B-12`: `afk.config.json`'s new top-level `gatePolicy` key
- `P-01`: unchanged `src/base-gates.ts:resolveBaseGateDeclarations`, asserted
  from `src/gate-policy.test.ts`
- `P-02`: `afk.config.json` — `version`, `resourceKeys` and `architectureDoc`
  are byte-identical; `gatePolicy` is appended
- `P-03`: unchanged `src/acceptance-manifest.ts`; `src/gate-policy.ts` shares
  no implementation with it and imports nothing from it

## Decisions made during implementation

- `assertGlobDialect` reports the *first* offending metacharacter in the order
  `? [ ] { } ( ) ! + @ \`, then falls through to the `**`-segment check, so a
  glob like `src/[ab].ts` is named for its `[`. The contract enumerated the set
  but not a reporting order; first-in-list is deterministic and testable.
- The metacharacter scan runs before the `**`-segment scan, so a glob that
  breaks both rules is named for its character. `src/***.ts` carries no
  metacharacter, so it still reports its segment.
- Both entry points pass the same `source` default (`afk.config.json`), so a
  glob rejected by `matchesGlob` and by `parseGatePolicy` produces the
  identical message; only `loadGatePolicy` substitutes the concrete file path,
  which is the repo's existing `${source} <field> <problem>` convention.
- Unknown members are quoted in the message (`has unknown member "testGlob"`).
  Bare interpolation would make a `testGlob` rejection indistinguishable from
  the `testGlobs` that appears in the "knows only …" tail.
- `parseStringArray` also refuses a blank string, matching
  `parseAfkManifest`'s non-blank convention. A blank glob would otherwise pass
  the dialect check and silently match nothing.
- Every returned array is a fresh copy (`[...DEFAULT_…]`, `Array.map`), so a
  consumer that mutates a policy cannot reach the exported baselines.
- Commits are grouped rather than one-per-behavior: the module and its tests
  are a single compiling unit, so they land together, with the config change
  and this handoff as separate commits. Each message enumerates the behavior
  IDs it delivers.
- `pnpm lint` is not a script in this repository, so the `lint` base gate
  resolves to a declaration with `required: false` — expected, and why `P-01`
  asserts only the declaration *ids*.

## Gotchas / learnings

- `parseGatePolicy` treats a **missing** member as "use the baseline" and an
  **unknown** member as fatal. #85 (`acceptance`) and #86 (`cost`) each have to
  widen `POLICY_KEYS` in `src/gate-policy.ts` in the same commit that adds
  their key to any `afk.config.json`, or the config refuses to load. There is
  no forward-compatibility escape hatch, by D1.
- `loadGatePolicy` returns `null` for two different states — no
  `afk.config.json`, and a config with no `gatePolicy` — and distinguishes
  neither. A consumer that needs to tell "no policy file" from "policy file,
  no gate policy" has to stat the file itself.
- `gatePolicy.version` is checked with `input.version !== 1`, so a JSON string
  `"1"` is refused. It is independent of `afk.config.json`'s own top-level
  `version`, which this module does not read or validate at all.
- The glob dialect normalizes only the **path**; a backslash in a *glob* is a
  refused metacharacter. So `matchesGlob("**/*.test.ts", "src\\a.test.ts")` is
  `true` while `matchesGlob("src\\a.test.ts", …)` throws. Consumers feeding
  `git`-reported paths (already forward-slashed) or Windows paths are both
  fine; consumers building a glob from a Windows path are not.
- Matching is case-sensitive with no case folding, deliberately unlike the
  acceptance manifest's `fileScope` comparison. Two tests pin this from the
  source text (`not.toContain("toLowerCase")`), so adding a case-folding call
  anywhere in `src/gate-policy.ts` — even in an unrelated helper — fails
  `B-10` and `P-03`.
- `matchesFrom` recurses over `**` split points. It is fine for the path depths
  a repo produces, but it is not memoized; a glob with many `**` segments
  against a deep path is exponential. Nothing in this PRD writes such a glob.
- `**` matches zero segments, so `**/*.test.ts` matches a bare `a.test.ts` at
  the repo root. A deleted-test check must not assume a directory prefix.
- Nothing consumes a policy yet. `loadGatePolicy` has no call site outside its
  test; the gate runner (#195) and the feedback channel (#193) add the first
  ones, and until then `gatePolicy` in this repo's config is inert.
