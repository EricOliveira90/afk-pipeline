# Context — Slice 01 (#84): Gate policy reader

## Files and current behavior

- FACT: No module in `src/` reads `afk.config.json` today. `grep`-style search
  for `afk.config.json` across `src/**/*.ts` (non-test) returns zero matches;
  the only repo hits are docs, spec files, and the file itself
  (`afk.config.json`, `docs/specs/afk-v2-plan.md`, `ARCHITECTURE.md`,
  `.kiro/specs/afk-v2-acceptance-scope-gates/{prd.md,issues.md,afk.json}`,
  and the anchors file for this slice and for slice 08). This slice creates
  the first reader.
- FACT: `afk.config.json` (repo root) currently holds exactly three top-level
  keys: `version` (`1`), `resourceKeys` (an object of regex strings), and
  `architectureDoc` (a path string) — `afk.config.json:1-7`. `gatePolicy` is a
  new, optional fourth top-level key; this slice must not touch the other
  three.
- FACT: `src/base-gates.ts` exports `resolveBaseGateDeclarations`,
  `resolvePreQAGateDeclarations`, `resolveFullSuiteGateDeclarations`, all
  built from `BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const`
  (`src/base-gates.ts:4-36`) via `projectSanityGateDeclarations`, which maps
  gate ids onto `resolveSanityPlan(cwd).steps` from `src/preship.ts`. This is
  the "derived baseline catalog" the issue says every consumer falls back to
  when `gatePolicy` is absent. This slice reads that relationship but must
  not edit `src/base-gates.ts` (anchors file, "What already exists"; that
  edit belongs to #195).
- FACT: `package.json` has no `dependencies` key (stated in the anchors
  file, "AFK has no runtime dependencies"); `src/` contains no existing glob
  matcher. The glob matcher for `testGlobs` must be hand-rolled with zero new
  npm dependencies.
- INFERENCE: The new module is `src/gate-policy.ts` (named explicitly in the
  issue body, "What to build"), sitting beside `src/base-gates.ts` and
  `src/afk-manifest.ts` at the top level of `src/`, matching those modules'
  placement (no subdirectory for config-shaped readers).
- UNKNOWN: Whether `src/gate-policy.ts` needs a corresponding entry in
  ARCHITECTURE.md's module table. The Gates row currently lists
  `src/gate-runner.ts`, `src/base-gates.ts`, `src/candidate-gate-phase.ts`,
  `src/post-qa-gates.ts` as public seam and `src/candidate-gate-policy.ts`,
  `src/migration-gate.ts`, `src/qa-gate-authorization.ts` as internals
  (ARCHITECTURE.md Modules table, Gates row) — `gate-policy.ts` is not yet
  listed on either side, and this slice's write boundary (context.md only)
  does not cover ARCHITECTURE.md.

## Patterns and test harness

- FACT: `src/afk-manifest.ts` is the closest existing precedent for this
  slice's shape: a pure validator (`parseAfkManifest(value, source)`) that
  accepts an already-parsed value or JSON text and throws `Error` messages
  naming the offending field, plus a file-reading entry point
  (`loadAfkManifest(prdDir)`, `src/afk-manifest.ts:154-158`) that returns
  `null` when the file does not exist (checked via `existsSync`) and
  otherwise delegates to the pure parser. `loadGatePolicy(repoRoot)` should
  mirror this: `existsSync(join(repoRoot, "afk.config.json"))` gate, then
  parse.
- FACT: `afk-manifest.ts` enforces exact-key validation with a per-field
  helper pattern: collect `Object.keys(value)`, diff against an expected set,
  and throw naming both unexpected and missing keys (see
  `acceptance-manifest.ts:32-46`'s `requireExactKeys`, used the same way).
  Two separate existing helpers do this (`afk-manifest.ts`'s inline checks
  and `acceptance-manifest.ts`'s `requireExactKeys`); neither is imported by
  the other, so this slice can either reuse `requireExactKeys` (if it is
  exported — it is not currently exported from `acceptance-manifest.ts`, only
  used internally) or write its own local exact/unknown-key check in
  `gate-policy.ts` in the same style.
- FACT: `src/afk-manifest.test.ts` is the test-file precedent: tempdir-based
  fixtures via `mkdtempSync(join(tmpdir(), "<prefix>-"))`, `mkdirSync`,
  `writeFileSync`, cleanup in `afterEach` via a `roots: string[]` array and
  `rmSync(root, { recursive: true, force: true })` (`src/afk-manifest.test.ts:1-23`).
  Per the CLAUDE.md test-loop guidance this slice's tests are pure unit tests
  (no git, no spawned processes), so they belong in a new
  `src/gate-policy.test.ts` run directly with `pnpm vitest run
  src/gate-policy.test.ts` while iterating — this is not one of the heavy
  spawning suites (`orchestrator`, `wave`, `resume-integration`,
  `qa-orchestration`, `clean-failed`) and does not need a `test:heavy:*`
  script.
- FACT: `src/json-scan.ts` exports `parseJsonWithUniqueKeys(text, source)`,
  which strips a leading BOM, calls `JSON.parse`, and additionally refuses
  JSON that repeats a key inside one object (`src/json-scan.ts:94-123`). It is
  already used by `contract-review.ts`, the adjudication artifact, and
  `acceptance-manifest.ts`-adjacent parsers per its own doc comment (lines
  14-19). INFERENCE: since `loadGatePolicy` reads a file from disk (a
  human/agent-editable JSON file, same risk class as the artifacts
  `parseJsonWithUniqueKeys` was built for), reusing it instead of bare
  `JSON.parse` would keep this reader consistent with the repo's established
  JSON-boundary parsing convention, though the issue text does not mandate
  it and `afk-manifest.ts`'s own `parseAfkManifest` uses bare `JSON.parse`
  instead (`src/afk-manifest.ts:54`) — so both precedents exist in the
  codebase and the issue does not settle which this slice should follow.
- FACT: Error-throwing convention across `afk-manifest.ts` and
  `acceptance-manifest.ts` is `throw new Error(\`${source} <field> <problem>\`)`
  with `source` defaulting to a filename constant (e.g.
  `ACCEPTANCE_MANIFEST_FILENAME` referenced at `acceptance-manifest.ts:59`)
  and the offending key/value interpolated into the message text, never
  returned as structured data.

## Data and integration

- FACT: The issue's required shape (`## What to build`) is: `gatePolicy` is
  an object with `version` (literal `1`), `protectedPaths` (object of
  optional `gatePolicyPaths: string[]` and `testGlobs: string[]`, defaulting
  to `["afk.config.json", "suite-budgets.json"]` and `["**/*.test.ts"]`
  respectively when absent), and `riskClasses` (flat array restricted to the
  literals `"gate-policy"`, `"deleted-test"`, `"skipped-test"`). Unknown
  top-level or nested members refuse the launch by name.
- FACT: `gatePolicy.version` is declared independent of `afk.config.json`'s
  existing top-level `version` (issue body and anchors file both state this
  explicitly) — the reader must not conflate the two version fields or
  reuse one check for both.
- FACT: The anchors file (`anchors/01-gate-policy-reader.md:34-41`) explicitly
  distinguishes this slice's glob matcher (case-sensitive, for `testGlobs`)
  from `acceptance-manifest.ts`'s `normalizePath` (case-**in**sensitive,
  lowercases at `acceptance-manifest.ts:64-71`, used for `fileScope`
  comparison). These are two different comparisons for two different
  purposes and must not share an implementation or be conflated — a past
  review round (#194) lost a round over exactly this conflation.
- FACT: Downstream consumers of this slice are named in the issue: #85 (adds
  `acceptance` key), #86 (adds `cost` key), #195 (file-scope gate, consumes
  the exported glob matcher), #193 (feedback integrity / `GATE-SCOPE`
  channel, also consumes the glob matcher). None of these exist yet in
  `src/`; this slice's exports (`loadGatePolicy`, the pure validator, and the
  exported glob-matcher function) are the seam those slices will import.
- INFERENCE: Because `riskClasses`' risk-class-to-path association is
  explicitly "code in this module, not config" (issue body), `gate-policy.ts`
  is expected to eventually contain some mapping/logic beyond pure parsing,
  but this slice's acceptance criteria only test parsing and the glob
  matcher — no risk-class-to-path behavior is in this slice's acceptance
  criteria list, so INFERENCE: that association's implementation (if any) is
  out of scope for #84 and belongs to a later slice that consumes
  `riskClasses`.

## Unknowns

- UNKNOWN: Whether `requireExactKeys` from `acceptance-manifest.ts` is
  intended to be exported and reused, or whether `gate-policy.ts` should
  define its own local key-validation helper. It is not currently exported
  (`src/acceptance-manifest.ts:32`, no `export` keyword), so as of now it is
  not importable without a change to that file, which is outside this
  slice's write boundary to make yet (this slice only writes `context.md`;
  the eventual contract-writing step will need to decide).
- UNKNOWN: The exact function/export names beyond what the issue fixes
  (`loadGatePolicy` is named explicitly; the "pure validator" is described
  but not named — precedent in `afk-manifest.ts` calls the analogous
  function `parseAfkManifest`, suggesting `parseGatePolicy` as a likely
  name, but this is not settled by the issue text).
- UNKNOWN: Whether `gate-policy.ts` should also export a type for the parsed
  policy (analogous to `AfkManifest` / `AcceptanceManifestV1`) — the issue
  describes the shape but does not name a type.
- UNKNOWN: Exact wording/format required for the "refuses the launch" error
  messages (e.g. whether they must include the literal string "refuses the
  launch" or simply throw a descriptive `Error`, matching the
  `afk-manifest.ts`/`acceptance-manifest.ts` convention of throwing an
  `Error` with a source-prefixed message).
