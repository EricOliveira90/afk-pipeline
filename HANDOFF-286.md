# Handoff — #286 (architect finding A-04, `afk-v2-agent-eval-harness`)

Direct in-repo work, two commits, one per independent half. Branch
`fix/286-eval-home-and-decorator-guard`, pushed. No PR opened, nothing merged,
no GitHub comment posted — the maintainer decides merge timing.

## Half one — `roleDispatch` has one home

`src/eval-pack.ts` re-exported `roleDispatch` / `EvalRoleDispatch` from
`src/eval-compare.ts` only so that `prd.md` D32's module table stayed literally
true. No production module read the re-export: `src/eval-command.ts` already
imports from `./eval-compare.js`.

- `.kiro/specs/afk-v2-agent-eval-harness/prd.md` — moved `roleDispatch(role)`
  (and named `EvalRoleDispatch`) from the `src/eval-pack.ts` row of D32's module
  table into the `src/eval-compare.ts` row, plus a paragraph after the table
  saying why the row sits there, so nobody moves it back.
- `src/eval-pack.ts` — deleted the re-export and its comment.
- `src/eval-pack.test.ts` — removed `"B-09 exposes the D9 row through the
  re-export…"` and the now-unused `roleDispatch` import.
- `src/eval-compare.test.ts` — added `"B-09 lives in this module and is not also
  reachable from src/eval-pack.ts"` beside the existing `roleDispatch` describe.
  It asserts the pack reader's module namespace does not carry `roleDispatch`,
  checked against a positive `readEvalPack` key so the absence cannot pass
  vacuously. `EvalRoleDispatch` is a type, so `pnpm run typecheck` is what pins
  where that one lives.

The runtime edge is unchanged (`eval-pack` → `eval-compare` at runtime,
`import type` the other way), so `src/eval-boundary.test.ts`'s import scans were
re-run rather than assumed.

## Half two — the decorator cannot drop an `AgentProvider` member

`withPromptRecording` (`src/prompt-recorder.ts`) hand-copied `name`, `invoke`
and optional `parseStreamLine`. A fourth interface member would have been
dropped on every `--record-prompts` run with no failing test and no type error.

- `src/prompt-recorder.ts` — the wrapper is now `{ ...inner, invoke }`, so a new
  member passes through by construction. Both properties the enumeration held
  are preserved: `name` is the inner's (ADR 0002), and `parseStreamLine` stays
  absent rather than undefined-valued when the inner omits it (ADR 0004), since
  a spread copies no key that is not there. The doc comment records why spread
  is safe here: every provider is an object literal, so there is no prototype
  member for a spread to miss.
- `src/prompt-recorder.test.ts` — new `"B-04 forwards every member the inner
  owns…"`: own enumerable keys of the wrapper equal the inner's, for a provider
  with `parseStreamLine` and one without; and a member the wrapper has never
  heard of (the stand-in for a future interface addition) arrives on the wrapper,
  parses, and is still recorded over.

`src/cli-entries.test.ts` was deliberately left untouched — the unmerged
`fix/275-host-run-lease` branch also edits it, and its existing assertion that
no CLI entry calls `withPromptRecording` directly still holds.

## Verified

An AFK self-run was live on the host, so only `typecheck` and targeted
single-file vitest runs were used. Exact commands and outcomes:

- `pnpm run typecheck` — clean, twice (once per half).
- `npx vitest run src/eval-pack.test.ts src/eval-compare.test.ts
  src/eval-boundary.test.ts` — 3 files, 39 tests, all passed.
- `npx vitest run src/prompt-recorder.test.ts` — 13 tests passed.
- `npx vitest run src/cli-entries.test.ts` — 6 tests passed.
- Both new tests were confirmed RED before being trusted: re-adding
  `export { roleDispatch } from "./eval-compare.js";` to `src/eval-pack.ts`
  fails the new `eval-compare.test.ts` case, and restoring the enumerated
  wrapper fails the new `prompt-recorder.test.ts` case. Both temporary edits
  were reverted and the suites re-run green.

## Still owed

- `pnpm test` (the full suite, ~17–30 min) has NOT been run — the live self-run
  owned the host. Both halves are unit-level and the touched heavy suites are
  none, but that is an argument, not evidence.
- Not touched, deliberately: the slice run artifacts under
  `.kiro/specs/afk-v2-agent-eval-harness/slices/` (`01-eval-runner/handoff.md`
  :13/:44, `02-eval-seed-pack/context.md`:90) still describe the re-export.
  They are historical records of what those slices did, and rewriting them would
  falsify the record; `prd.md` is the spec of record and it now matches the code.
  Say the word if you would rather they carry a "superseded by #286" line.
