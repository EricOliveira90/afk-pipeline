# Code anchors — slice 01 (#84), Gate policy reader

Verified against `integration/pre-prd4` on 2026-09-08. Read this before writing
the contract.

## What already exists

- **No code reads `afk.config.json` today** — zero non-test matches in `src/`. You
  write the first reader. The file currently holds `version`, `resourceKeys` and
  `architectureDoc`; `gatePolicy` is a fourth top-level key beside them and
  changes neither. `gatePolicy.version` is its own schema version, independent of
  the file's.
- **AFK has no runtime dependencies.** `package.json` has no `dependencies` key,
  and `src/` contains no glob matcher. Any "use library X" reasoning is wrong by
  default; the matcher is yours to write as a pure function.
- `src/base-gates.ts` holds the derived baseline (`BASE_GATE_IDS` is exactly
  `["typecheck","lint","tests"]`). You **read** the fallback relationship; you do
  not edit that file. #195 owns the gate-runner changes.

## Settled — do not escalate

- The member shapes are named arrays, not rule records: `protectedPaths` is an
  object of `gatePolicyPaths` and `testGlobs` string arrays; `riskClasses` is a
  flat array of three literal strings (prd.md D1). D6 cites the dotted path
  `gatePolicy.protectedPaths.testGlobs`, which a record array would leave
  unresolvable.
- An unknown member refuses the launch, naming the key. #85 and #86 widen the
  known set as they land; serial lanes make that safe (prd.md D1).
- The glob dialect is the narrow hand-rolled subset — literal segments, `*`, `**`
  — case-sensitive on every platform. Gitignore semantics were rejected because
  platform-native case sensitivity would decide differently on Windows than on CI
  (prd.md D6).

## Do not conflate two case rules

Your glob matcher is **case-sensitive**. The acceptance manifest's `fileScope`
comparison is case-**in**sensitive, because `normalizePath`
(`src/acceptance-manifest.ts:64-71`) lowercases and the parser stores the
normalized form (`:269`). Two comparisons, two purposes: globs decide which paths
are test files, manifest comparison decides which paths a contract declared.
Round 1 of 2026-09-08 lost a round to a reviewer that conflated them (#194).

## Method

Every gap found on this slice's ancestor came from a **type signature or a
persisted schema version**, never from a missing path. Before writing the
contract, check the actual declaration of anything the PRD asserts about.
