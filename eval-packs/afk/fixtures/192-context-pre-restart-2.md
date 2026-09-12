<!--
Hand-reconstructed fixture for eval-packs/afk case 02-192-pre-restart-2-planner.

Provenance: the explorer evidence map the PRD 4 slice-01 planner read on
launch `run-20260907-225023`, archived by the operator at
`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-2/context.md`
(#192 "Evidence"). That tree is gitignored and absent from this checkout, so
this map is reconstructed from material this repository does carry: the shape
and the still-true FACTs of the committed
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/01-gate-policy-reader/context.md`,
GH #84 as of 2026-09-07, and PRD 4's `prd.md` at `93bf6bd`.

Reconstructed to the state of knowledge at this launch: D1's member shapes are
now settled (`fe2628a`, 22:50, is the amendment that restarted the run), and the
open question has moved to D5 — how a waiver's `path` is matched against a
changed path. That UNKNOWN is what the planner escalated. The `#194` casing FACT
is absent, because it post-dates 2026-09-08.
-->

# Context — Slice 01 (#84): Gate policy reader

## Files and current behavior

- FACT: No module in `src/` reads `afk.config.json` today; this slice creates
  the first reader. The file holds exactly three top-level keys — `version`
  (`1`), `resourceKeys`, `architectureDoc` (`afk.config.json:1-7`) — and
  `gatePolicy` is a new, optional fourth.
- FACT: `src/afk-manifest.ts` is the launch-input parser this slice must
  extend. `parseAfkManifest` builds its result from four known fields —
  `version`, `selectedSlices`, `migrationPrefixes`, and the PRD slug — and
  rejects no unknown key, so a `protectedChangeWaivers` array in an `afk.json`
  today is accepted and then silently discarded.
- FACT: `trimUnclaimedMigrationPrefixes` (`src/afk-manifest.ts`) rebuilds the
  manifest object from the parsed fields and writes it back, so any field the
  parser does not carry is dropped on the next rewrite. A waiver array added to
  the file without extending `AfkManifest` would not survive one launch.
- FACT: `src/base-gates.ts` holds the derived baseline catalog
  (`BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const`,
  `src/base-gates.ts:4-36`) that every consumer falls back to when `gatePolicy`
  is absent.

## Patterns and test harness

- FACT: `loadAfkManifest(prdDir)` (`src/afk-manifest.ts:154-158`) is the
  file-reading precedent: an `existsSync` gate, `null` when the file is absent,
  otherwise delegation to the pure parser. `loadGatePolicy(repoRoot)` mirrors it.
- FACT: The repository already holds two path comparisons and they are not the
  same comparison. `normalizePath` (`src/acceptance-manifest.ts:64-71`) ends
  with `path = path.toLowerCase()` and is what `fileScope` entries are stored
  and compared through (`src/acceptance-manifest.ts:269`;
  `outOfScopeChangedPaths`, `src/escalation.ts:236-241`). The `testGlobs`
  matcher this slice writes is specified **case-sensitive on every platform**
  (#84). Two comparisons, two purposes.
- FACT: `src/afk-manifest.test.ts:1-23` is the test harness precedent —
  tempdir fixtures, `afterEach` cleanup through a `roots: string[]` array. This
  slice's tests are pure unit tests and belong in `src/gate-policy.test.ts`.
- FACT: `src/json-scan.ts` exports `parseJsonWithUniqueKeys(text, source)`
  (`:94-123`); `parseAfkManifest` uses bare `JSON.parse` (`:54`). Both
  precedents exist for a JSON boundary and the issue settles neither.

## Data and integration

- FACT: PRD 4's `prd.md` D5 (`@93bf6bd`) fixes: where the waiver record lives
  (`protectedChangeWaivers` in the PRD directory's `afk.json`), its four
  members (`riskClass`, `path`, `author`, `reason`), that it is read once at
  launch from `--prd-dir`, that an agent never writes one, that
  `parseAfkManifest` must carry it, that an unknown `riskClass` fails closed at
  launch, and the three literal `riskClass` strings (`gate-policy`,
  `deleted-test`, `skipped-test`).
- FACT: D5 also fixes that "contract file scope never implies a waiver" (plan
  §3d item 17) and that each applied waiver's four fields are recorded in gate
  evidence and `run-summary.md`.
- FACT: The `afk.json` in `.kiro/specs/afk-v2-acceptance-scope-gates/` already
  pre-records one waiver whose `riskClass` is `gate-policy`, and D5 requires
  that string and the declared vocabulary to match exactly.
- FACT: `gatePolicy.version` is its own schema version, independent of
  `afk.config.json`'s top-level `version` (#84).

## Unknowns

- UNKNOWN: How a waiver's `path` member is matched against a changed path.
  D5 gives the member its name and its position in the record and nothing else:
  it does not say whether `path` is an exact repo-relative string, a glob in
  the same dialect as `testGlobs`, or a directory prefix that covers everything
  beneath it; nor whether the comparison is case-sensitive like the `testGlobs`
  matcher this slice writes or case-insensitive like `normalizePath`, which the
  repository uses for the other path comparison a gate makes. Both existing
  comparisons are reachable from this slice and they disagree, so neither
  settles it by precedent. The answer decides which protected changes a
  recorded waiver actually exempts, and #195 and #193 read the same records.
- UNKNOWN: Whether an unmatched waiver is silent, a note, or a refusal. D5
  requires applied waivers to be recorded but says nothing about a waiver that
  matched no path in a run.
- UNKNOWN: Whether `requireExactKeys` (`src/acceptance-manifest.ts:32`, not
  exported) is meant to be reused or whether `gate-policy.ts` writes its own.
- UNKNOWN: Whether `src/gate-policy.ts` needs a row in `ARCHITECTURE.md`'s
  module table; nothing for a policy reader is listed on either side of the
  Gates row today.
