# Wave session s3 — crash records (plan §3 item 4, defect #121)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 4: every exit path writes its record.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s3-crash -b wave/crash-records main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk\docs\specs\afk-v2-plan.md` — §3 item 4
- `C:\Code\afk\docs\specs\afk-v2-plan-debate.md` — item 4 and the accepted ENOSPC limitation
- `gh issue view 121 --repo EricOliveira90/afk-pipeline`
- `C:\Code\afk\docs\adr\0040-cancellation-record-written-when-the-signal-fires.md` — the #114 fix this extends; it hangs off the `AbortSignal`, which is why run 6's crash bypassed it
- `C:\Code\afk\docs\adr\0043-stop-delivered-as-a-file-the-run-polls.md` and `src\cancellation.ts` in your worktree — wave session s2 (merged 2026-08-28, PR #127) added `CancellationHandle.requestStop(source)` and the stop-sentinel path through the same bookkeeping your crash records must share; do not build a parallel path
- `src\run-events.ts` and the state-persistence path in `src\run-state.ts` in your worktree
- `AGENTS.md` in your worktree — test discipline

If you write an ADR, it is **ADR 0044** — the number is reserved for this
session; 0041–0043 are taken by wave 2 and other sessions of this wave have
their own reservations.

## Task

1. Route `uncaughtException`, `unhandledRejection`, and fatal stream errors
   through the same cancellation bookkeeping ADR 0040 uses, with a distinct
   cause: `CRASHED`, carrying the error text. Then re-throw / exit non-zero —
   do not swallow the crash.
2. The record write is best-effort by design: under ENOSPC the write itself
   may fail. Accept that. Do NOT build reserved-space machinery — the debate
   rejected it. The backstop is clear-on-dispatch (session s7's item).
3. Grounding to preserve in the record: run 6's ENOSPC crash left `#79`'s
   state naming a typecheck failure from two runs earlier, already fixed. A
   record naming a stale failure is worse than no record.
4. Tests per the assertion-placement rule in AGENTS.md: unit-test the
   handler-to-record mapping; avoid new spawned scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast` plus the heavy suites your change touches. Do NOT
  run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the new cause value, and what you
verified.
