# Wave session s2 — `afk stop` sentinel (plan §3 item 3)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 3: a stop command that always works.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s2-stop -b wave/afk-stop-sentinel main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 3
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 3 (both debaters proposed this independently)
- `C:\Code\afk-v2-run\docs\specs\afk-v2-recovery-plan.md` — Run 3 evidence, the stop-delivery item: `AttachConsole` + `CTRL_C_EVENT` reported success twice while the orchestrator kept running; the delivery that worked left no cancellation record
- `C:\Code\afk\docs\adr\0040-cancellation-record-written-when-the-signal-fires.md` and `0003-cancellation-via-abortsignal.md`
- `src\orchestrator.ts` in your worktree — the scheduler loop and the existing abort path
- `AGENTS.md` in your worktree — test discipline

## Task

1. The orchestrator polls a run-namespaced sentinel file once per scheduler
   tick (one `existsSync`-class check). When the sentinel exists, trigger the
   same `AbortSignal` path a signal stop uses, so ADR 0040's CANCELLED
   records fire exactly as they do today for Ctrl-Break.
2. Add the writer side: an `afk stop <slug>` subcommand (or `--stop` flag,
   match existing CLI conventions) that writes the sentinel and reports
   whether the run acknowledged it.
3. Namespace the sentinel by run ID so a stale sentinel from a crashed stop
   cannot abort the next launch; clear any stale sentinel for the own run at
   launch. (The broader preflight sweep is session s4's job — do not build
   preflight here.)
4. Tests per the assertion-placement rule in AGENTS.md: prefer a unit test on
   the sentinel-detection decision; if a spawned scenario is unavoidable, add
   an `it` to an existing cancellation fixture rather than a new scenario.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests. Never stop or signal it.
- Tests: `pnpm test:fast` plus the heavy suites your change touches
  (cancellation paths likely live in `test:heavy:orchestrator` — check the
  file headers). Do NOT run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the sentinel path convention, and what
you verified.
