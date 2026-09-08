# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run

- `pnpm install --frozen-lockfile` — PASS (exit 0). Run here; the skip
  authorization does not cover the install, which ran in a different checkout.
- `pnpm run typecheck` — PASS (exit 0, `tsc --noEmit`, no diagnostics). Run
  rather than skipped: it is on the pre-QA list and costs seconds. This agrees
  with the orchestrator's gate evidence
  (`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260908-030758/gates/s01/attempt-81ad97f2c8d4.json`,
  gate attempt `81ad97f2-c8d4-4c1a-a257-850f15a667ed`, tree
  `7b285c8ffc70751e4369a67722925478055df805`).
- `pnpm vitest run src/gate-policy.test.ts` — 18 tests, 18 passed, 0 skipped,
  22ms. This is the slice's own pure unit file named by the contract's
  definition of done, not the project suite; the suite itself was not run and
  is the orchestrator's to run on the accepted tree.

### Behavior verification

Every in-scope behavior has a named, executed assertion in
`src/gate-policy.test.ts`, and each assertion matches its manifest
given/when/then:

- B-01 — `Object.keys(gatePolicyModule).sort()` deep-equals the six pinned
  names (`src/gate-policy.test.ts:63`). Confirmed against
  `src/gate-policy.ts`: the three types are `export type` / `export interface`
  and erase, so nothing else reaches the namespace.
- B-02 — the D1 example policy round-trips deep-equal
  (`src/gate-policy.test.ts:76`).
- B-03 — all four reduced policies return the documented baselines, and a
  separate test mutates every returned array and re-asserts the three
  `DEFAULT_`/`GATE_RISK_CLASSES` constants, so the copies in
  `src/gate-policy.ts:227,247,258,310` are pinned, not incidental
  (`src/gate-policy.test.ts:87,123`).
- B-04 — all six malformed inputs reject naming `gatePolicy`,
  `protectedPaths`, `gatePolicyPaths` or `riskClasses`
  (`src/gate-policy.test.ts:141`). `protectedPaths: []` is caught by the
  explicit `Array.isArray` arm at `src/gate-policy.ts:231`, which a bare
  `typeof === "object"` check would have let through.
- B-05 — `cost`, `acceptance`, `typo` and the nested `testGlob` each appear in
  their rejection message (`src/gate-policy.test.ts:161`). The nested case
  asserts the *quoted* `"testGlob"`, which is what distinguishes it from the
  `testGlobs` in the message's "knows only …" tail — the assertion would pass
  vacuously without the quotes.
- B-06 — absent, `2` and `"1"` all reject through the strict
  `input.version !== 1` check (`src/gate-policy.ts:297`), and a fourth case
  drives `loadGatePolicy` at a temp config whose *top-level* `version` is a
  valid `1` while `gatePolicy.version` is `2`, which is the independence claim
  AC3 actually makes (`src/gate-policy.test.ts:193`).
- B-07 — `gatePolicy` and `deleted-tests` are each named in their message, and
  `GATE_RISK_CLASSES` is pinned to the three declared classes
  (`src/gate-policy.test.ts:202`).
- B-08 — all four filesystem states asserted: policy returned deep-equal, no
  config → `null`, config without `gatePolicy` → `null`, unknown member →
  throws naming `cost` (`src/gate-policy.test.ts:225`). Case one is a
  deep-equal on a written policy, so a stub that always returns `null` fails.
- B-09 — the six pairs assert `true, true, false, true` and `true, false`
  (`src/gate-policy.test.ts:253`). `**` spanning zero segments and the
  backslash-path normalization (`src/gate-policy.ts:215`) are both covered.
- B-10 — `src/a.Test.ts` fails, `SRC/a.test.ts` matches (`**` absorbs `SRC`,
  no literal compared), `src/Gate.ts` vs `src/gate.ts` fails
  (`src/gate-policy.test.ts:263`). The source-text test asserts no
  `toLowerCase` and no `toUpperCase` anywhere in the module, so the rule
  cannot silently become platform-dependent. I re-read `src/gate-policy.ts`
  independently: comparison is `===`, `startsWith`, `endsWith`, `indexOf`
  only, with no locale- or case-sensitive collation call.
- B-11 — all eleven metacharacters plus `src/***.ts` and `a**/b.ts` are
  driven through **both** `matchesGlob` and `parseGatePolicy` in one loop, each
  asserting the offending character or segment appears in the message
  (`src/gate-policy.test.ts:275`). Both paths reach the single
  `assertGlobDialect` (`src/gate-policy.ts:128`), called from
  `src/gate-policy.ts:212` and `:260`, so "one shared validator" is structural,
  not coincidental. The `src\a.ts` row is the pair to B-09's normalized
  backslash *path*, exactly as the manifest asked.
- B-12 — `loadGatePolicy(REPO_ROOT)` deep-equals the D1 example
  (`src/gate-policy.test.ts:307`), and the committed
  `afk.config.json` carries that object verbatim.

Boundary: the slice's three commits touch exactly
`src/gate-policy.ts`, `src/gate-policy.test.ts` and `afk.config.json`, plus
the handoff artifact:

```
1028254  src/gate-policy.test.ts, src/gate-policy.ts
7fba600  afk.config.json
d7cb19b  .kiro/.../01-gate-policy-reader/handoff.md
```

No file outside the declared list changed, so no scope amendment is needed.
(The larger `git diff origin/main` on this worktree is the feature branch's
pre-existing commits from earlier slices, not this slice's work.) No entry was
added to `package.json`; the glob matcher is hand-rolled in
`src/gate-policy.ts:151-195` with no runtime dependency, satisfying the D6
non-goal.

Preservation:

- P-01 — PASS. `src/base-gates.ts` is untouched by every slice commit, and
  `resolveBaseGateDeclarations` on a policy-less temp root still yields exactly
  `["typecheck", "lint", "tests"]` with `loadGatePolicy` returning `null`
  (`src/gate-policy.test.ts:338`). Nothing in the slice reads a policy on the
  gate path, so a project with no `gatePolicy` reaches today's catalog.
- P-02 — PASS. The `afk.config.json` diff is purely additive: `version`,
  `resourceKeys` and `architectureDoc` are byte-identical and `gatePolicy` is
  appended as a fourth key. Asserted, not just inspected — the test pins all
  three values and the sorted top-level key list
  (`src/gate-policy.test.ts:318`).
- P-03 — PASS. `src/acceptance-manifest.ts` is unmodified; `src/gate-policy.ts`
  imports only `node:fs`, `node:path` and `./json-scan.js`, and the test asserts
  the source contains neither `from "./acceptance-manifest.js"` nor
  `toLowerCase` (`src/gate-policy.test.ts:348`). The two case rules stay two
  implementations — the conflation that cost #194 a round is structurally
  blocked here.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

Error messages follow the repo's `${source} <field> <problem>` convention and
name the offending key, member, value or character in every arm, including the
plural/singular split in `requireKnownKeys`. The `parseJsonWithUniqueKeys`
choice recorded in the contract is honoured at `src/gate-policy.ts:329`, so a
duplicated key in a hand-edited config cannot silently drop a policy. Failure
ordering is deterministic and documented (metacharacters in list order, then
the `**`-segment check), which is what makes B-11's per-character assertions
meaningful rather than order-dependent.

The matcher is the only non-obvious code, and it holds up: `matchesSegment`'s
final `pathSegment.length - last.length >= cursor` is the head/tail overlap
guard that a naive `startsWith`/`endsWith` pair gets wrong, and it is correct
for the zero-width `*` case. The `**` recursion in `matchesFrom` is
unmemoized and therefore exponential in the number of `**` segments; the
handoff says so explicitly and no glob in this PRD approaches it, so this is a
noted limit rather than a defect.

Two notes that do not affect the verdict. `parseStringArray` also refuses a
blank string — strictness the contract did not name, but consistent with
`parseAfkManifest` and correct on the merits, since a blank glob would pass the
dialect check and match nothing. And `assertGlobDialect` returns its argument
despite the `assert` prefix, which reads oddly but keeps the `.map` at
`src/gate-policy.ts:260` clean. The one advisory below is recorded as
`QA-01`.

Tests assert observable outcomes rather than implementation shape wherever a
behavioral assertion was possible; the two source-text reads are confined to
B-10 and P-03, where the contract's own test plan named them as the mechanism
for pinning a negative.

## Resolved findings
- None. This is the first QA stage on this slice; no findings were routed.

## Findings
### Finding 1 — matchesGlob rejections misattribute the glob to afk.config.json's testGlobs
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/gate-policy.ts:212` passes the constant `CONFIG_FILENAME`
into `assertGlobDialect`, so `matchesGlob("src/[ab].ts", "src/a.ts")` throws
`afk.config.json testGlobs glob "src/[ab].ts" contains the metacharacter "["…`
even though no `afk.config.json` was read and no `testGlobs` member was
involved. Reproduced by the B-11 loop, which asserts only that the character
is named and so passes either way.
**What the contract expected:** [behavior:B-11] "One shared validator runs from
both `matchesGlob` and `parseGatePolicy`, so both refuse identically" — a
shared validator and identical refusal, not a message that asserts a
provenance the matcher cannot know.
**What I observed:** Every rejection raised through `matchesGlob` claims the
glob came from the config file's `testGlobs`. #195 and #193 are the first
consumers to call `matchesGlob` with globs that will not come from
`afk.config.json`, and their users would be sent to the wrong file to fix a bad
glob. This clears if `matchesGlob` takes an optional source/field label
defaulting to today's value — which keeps the default message byte-identical
between the two entry points and leaves B-11 passing — or if the message drops
the file attribution while still naming the offending character or segment.
Advisory: the current behavior is what the contract literally pinned, so this
is a note for the consuming slices, not a defect that blocks this one.
