# Handoff — #272 and #238 (pre-ship sanity gate)

Branch `fix/272-238-preship-crash-and-skip`, worktree `C:\Code\afk-272-238`,
pushed to origin. No PR opened, nothing merged, no issue commented.

Two issues on one branch because both live in `src/preship.ts` and both render
through `src/logger.ts`. One commit each, in order.

## #272 — preserve the native crash identity

`09ea46f fix(#272): keep a killed process out of the CONFIGURATION class`

- `src/preship.ts`: new exported `isAbnormalTerminationExit(code, platform?)`
  — the Windows NTSTATUS error range (`>= 0xC0000000` unsigned, checked on
  every platform) and, on POSIX only, the `128 + signo` band bounded at 192.
  `defaultRunCommand` now carries `signal` out of `execFileSync`, so a POSIX
  signal death stops reading as a child that never spawned.
- New `abnormalTerminationFailure` path: `failures` still names the step,
  `failureKind` is `null` and `terminationKind: "ABNORMAL_EXIT"` is the
  discriminator. The output tail is dropped for that class (the reported
  incident quoted pnpm's `approve-builds` warning box — text the project
  prints on every green install — as the cause).
- Shared vocabulary deliberately **not** widened: no fourth `GateFailureKind`.
  `classifyExecution` already pairs `INFRASTRUCTURE` with `failureKind: null`,
  which is the pairing this reuses.
- Rendering: `sanityGateLabel` emits `FAIL (ABNORMAL TERMINATION) — <steps>:
  <detail>` (run-summary.md + ready-to-merge block), the console "Not ready"
  reason says relaunch, and `src/ship-gate.ts` builds a matching blocker
  reason and puts `terminationKind` on the `run-phase-ended` event
  (`src/run-events.ts`).
- Third ask (name the failing test, not just the step): steps now capture
  stdout+stderr to `<runDir>/sanity-<step>.log` and a red step's `detail`
  cites that path plus a 10-line tail. The child appends as it runs, so the
  output stays live/tailable, and the gate announces each path before the step
  starts (`onStepStart`). Callers passing no `stepLogDir` — every direct test —
  keep the old streaming behaviour byte for byte.
- No retry was added; the issue declined to decide that.

## #238 — record the configured step as skipped

`573d086 fix(#238): record the pre-ship step that never ran`
plus the tail-width follow-up commit.

- `SanityPlan.skipped` / `SanityGateResult.skipped` (both required):
  `{ name, scripts }` per undeclared step. `steps` keeps its exact shape, so
  `base-gates.ts`, `adopt-command.ts`, `resolveSanityCommands` and
  `resolveCandidateQACommands` are untouched.
- Carried on **every** return path, including the `steps.length === 0` early
  return and the cached-PASS path in `ship-gate.ts` (re-resolved from the same
  tree, since the cache persists only `{treeSha, ok}`).
- Renders as `PASS (skipped: lint — no "lint" script)`; a COMMAND failure gets
  ` [skipped: …]`; CONFIGURATION / ABNORMAL TERMINATION do not (nothing ran).
  Also on the `run-phase-ended` event.
- `CONTEXT.md` "Pre-ship sanity gate" updated for both issues.
- The ticket's "reuse the `tests:skipped` shape from #86" was **not** followed:
  `SKIP_GATE_ID = "tests:skipped"` is a gate that fails a candidate for
  disabling tests, not a record of a check that declined to run. The rendering
  follows `GateStatus`'s `SKIPPED` + `gateStatusCell`'s `prerequisiteSkipped`
  annotation instead. No linter and no `lint` script were added.

## Verified

An AFK self-run was live on this host, so only `typecheck` and targeted runs
were used — never `pnpm test`, `test:fast` or any `test:heavy:*`.

| Command | Result |
| --- | --- |
| `pnpm run typecheck` | pass (run after every step; final run clean) |
| `pnpm vitest run src/preship.test.ts` | 22 passed (new file) |
| `pnpm vitest run src/logger.test.ts` | 62 passed |
| `pnpm vitest run src/ship-gate.test.ts` | 36 passed |
| `pnpm vitest run src/base-gates.test.ts src/adopt-command.test.ts src/run-snapshot.test.ts src/acceptance-gate.test.ts src/gate-policy.test.ts` | 148 passed |
| `pnpm vitest run src/orchestrator.test.ts -t "runPreShipSanity"` | 12 passed, 176 skipped |
| `pnpm vitest run src/orchestrator.test.ts -t "is unsuccessful when the pre-ship sanity gate failed"` | 1 passed — the end-to-end path printed the announced log path and cited it in the blocker reason |

## Still owed

- The full `pnpm test` (17–30 min) that CLAUDE.md requires before handoff.
  Not run: an AFK self-run held the host. It needs a quiet machine.
- The four other heavy suites (`wave`, `resume`, `qa`, `clean`) were not run.
  None reads `SanityGateResult`, but only the full suite proves that.
- No real 0xC0000374 crash was reproduced (the issue calls that impractical);
  the classification is pinned at the seam, as the issue suggested.
