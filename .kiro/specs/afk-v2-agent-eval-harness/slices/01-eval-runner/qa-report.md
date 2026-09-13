# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run

- `pnpm install --frozen-lockfile` — PASS (exit 0). Run here, not skipped: the
  authorization's install ran in a different checkout.
- `pnpm run typecheck` — PASS (`tsc --noEmit`, no diagnostics). Re-run rather
  than cited, because it is a five-second command; it agrees with the
  orchestrator's gate evidence
  (`attempt-105b1113c798.json`, tree `86b50581c152f144acd2d639e8c3355f2e8bc809`).
- `pnpm vitest run src/eval-pack.test.ts src/eval-compare.test.ts
  src/eval-report.test.ts src/eval-command.test.ts src/eval-boundary.test.ts` —
  68 passed / 5 files / 5.17s. This is the slice's own test surface, not the
  project suite, which the orchestrator runs after this stage.

The change summary at
`.afk/artifacts/afk-v2-agent-eval-harness-claude-code/slice-01/change-summary.json`
does not exist in this worktree (`.afk/` is gitignored and absent from the
checkpoint), so the change set was derived from git instead:
`git diff --stat a4325c5 HEAD`.

### Boundary compliance

Every non-artifact path in `git diff --stat a4325c5 HEAD` is declared under
"Files expected to change":

`src/eval-pack.ts`, `src/eval-compare.ts`, `src/eval-report.ts`,
`src/eval-command.ts`, `src/eval.fixtures.ts`, `src/afk.ts`,
`src/afk-claude.ts`, `src/afk-codex.ts`, the five `src/eval-*.test.ts` files,
`eval-packs/fixtures/refused/01-unknown-member.json`, `CONTEXT.md`,
`ARCHITECTURE.md`. The remaining diff entries are this slice's own pipeline
artifacts under `.kiro/specs/afk-v2-agent-eval-harness/slices/01-eval-runner/`.
No `package.json`, no migration, nothing outside the list. Migration
requirement of 0 new files is met. No `SCOPE_AMENDMENT` is needed.

The working tree carries two modified files —
`slices/01-eval-runner/acceptance-manifest.json` and `contract.md` — both
LF→CRLF only (`git diff` reports the line-ending warning and no hunks). They
predate this review.

### Behavior verification (spot checks beyond the suite)

- **B-01/B-08/B-13/B-15/B-16/B-19/B-20/B-21/B-24/B-25**: read against
  `src/eval-command.ts` and `src/eval-report.ts` line by line and confirmed by
  the passing named tests. Exit codes are 2 for every pre-dispatch failure
  (`parseArgs` throw, `readEvalPack` throw, `mkdirSync` throw with
  `dispatchBegan === false`) and 1 only for a post-dispatch seam throw
  (`src/eval-command.ts:291,313,351`) — the "non-zero iff no report.json"
  invariant holds.
- **B-30 placement**: the four new entries land at `CONTEXT.md:472,480,487,495`,
  inside `### Pipeline concepts` (`:217`) and before the next `##` heading
  (`## Relationships`, `:524`). `**Prompt record**` is still at `:389` and its
  body is unedited.
- **B-31**: `ARCHITECTURE.md` is 112 lines, one `| Agent eval |` row.
- **P-01**: every pre-existing bare-token branch survives in each entry and the
  `eval` branch sits before `parsePipelineRuntimeOptions` in all three — read in
  the diff and asserted by the passing P-01 test.
- **Definition of done, anchor coverage**: scripted check over
  `src/eval*.test.ts` for an `it("<id> …")` per anchor found all 36 of
  B-01–B-31 and P-01–P-05 present. Zero missing.

### Probes (temporary, discarded with this worktree)

Two mutation probes, to confirm the two guard tests can actually fail rather
than passing vacuously:

1. Prepended `import { EVAL_PACK_VERSION } from "./eval-pack.js";` to
   `src/status.ts`, then `pnpm vitest run src/eval-boundary.test.ts -t "B-27"`:
   ```
   - Expected
   + Received
   - []
   + [
   +   "status.ts",
   + ]
    ❯ src/eval-boundary.test.ts:90:23
   ```
   The boundary test detects a real offender. Reverted.

2. Added `deps.stdout(formatEvalSummary(report, reportPath));` after
   `writeEvalReport` in `src/eval-command.ts`, then
   `pnpm vitest run src/eval-command.test.ts -t "B-21"`: 1 failed on the
   captured-lines assertion at `src/eval-command.test.ts:470`. The
   stdout/`output` separation is genuinely enforced. Reverted.

`git status --porcelain` afterwards shows only the two pre-existing
line-ending-only spec files, so both probes are gone.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

Each new module opens with a header tying its decisions to the `prd.md`
decision ids, matching the house style of `src/gate-runner.ts` and friends, and
the schema-version pair follows the cited `GATE_EVIDENCE_VERSION` precedent
exactly. `writeEvalReport` serializes key-by-key so B-19's exhaustive key list
and its presence rules are readable in one place rather than implied by object
construction — the right call for a versioned schema. The `roleDispatch`
re-export from `src/eval-pack.ts` back to `src/eval-compare.ts` creates a module
cycle, but the reverse edge is a `import type` only, so there is no runtime
cycle; the comment at `src/eval-pack.ts:373-378` says why the row lives beside
the parsers.

Two notes, neither material:

- The B-27 offender scan is a substring test over `from "…"` specifiers, so it
  would miss a dynamic `await import("./eval-pack.js")` or a bare
  `import "./eval-pack.js"` side-effect form. Both are foreign to this codebase
  and the contract asks for import specifiers, so this is within what was
  declared — noted only so a future reader knows the scan's edge.
- `src/afk.ts`'s new usage line is appended with a literal newline inside the
  template string, where `src/afk-claude.ts` and `src/afk-codex.ts` use an
  inline `\n       ` escape. The printed text is identical; only the source
  differs.

The one test-sufficiency gap worth recording is Finding 1.

## Resolved findings
- None. No findings were routed into this stage.

## Findings
### Finding 1 — B-12's report-level assertion is missing; only its two halves are unit-tested
**Severity:** Minor
**Pass:** 1
**Evidence:** `Select-String -Path src/*.test.ts -Pattern 'B-12'` matches
exactly one test, `src/eval-compare.test.ts:143`. It asserts
`projectOutput(guardian, unparseable)` equals `{ outcome: "UNPARSEABLE" }` and
that `compareProjection({ outcome: "SHIP" }, { outcome: "UNPARSEABLE" })` is
`"MISMATCH"`. `src/eval-command.test.ts` (21 tests, all passing) never
dispatches a `pm` or `architect` case, so no test reads a guardian case's entry
out of a written `report.json`.
**What the contract expected:** acceptance-manifest B-12 observableResult — "a
unit test asserts the pm projection, and asserts the architect case entry in
report.json has outcome MISMATCH with actual.outcome \"UNPARSEABLE\" and no
error key". Contract B-12 — "`UNPARSEABLE` is compared as a value, so an
`UNPARSEABLE` actual against an expected `SHIP` is a `MISMATCH` and never an
`ERROR`".
**What I observed:** The behavior is correct. `src/eval-command.ts:236-242`
attaches `actual` and omits `error` for any non-MATCH comparison result, and
`src/eval-report.ts:83-84` serializes `actual`/`error` by presence, so a
dispatched guardian case with an unparseable review does become a MISMATCH entry
with no `error` key. What is absent is the assertion that says so: the two
composed halves are covered at the unit level, the composition is not. A future
change that routed an `UNPARSEABLE` projection through `failed()`
(`src/eval-command.ts:214`) — turning exactly the outcome this behavior exists
to forbid, an `ERROR` instead of a `MISMATCH` — would leave all 68 tests green.
Advisory rather than blocking: the contracted behavior is present and correct in
the shipped code, and every other behavior anchor has an assertion that fails
when its behavior breaks.
