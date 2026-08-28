# Wave session s7 — clear stale records on dispatch (plan §3 item 11, wave half; defect #111)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is the wave half of plan §3 item 11: a previous run's
error text must not survive into this one.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s7-clear -b wave/clear-on-dispatch main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 11; note the scope split below
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 11
- `gh issue view 111 --repo EricOliveira90/afk-pipeline`
- `src\run-state.ts` (state persistence, `isSliceComplete` near line 416) and `src\resume.ts` (`decideResume`) in your worktree
- `AGENTS.md` in your worktree — test discipline

## Task

1. When a slice is dispatched, clear its stale records from previous
   attempts: persisted error text, failure phase leftovers — anything a
   reader could mistake for this run's result. Grounding: after run 6's
   crash, `#79`'s persisted `error` named a typecheck failure from two runs
   earlier, already fixed; an operator reading state was pointed at the
   wrong defect.
2. Reader-side rule: where state readers compare or display records from
   different runs, report the mismatch — never silently tolerate it.
3. Scope split — do NOT add the run-ID schema field here. That half of
   item 11 lands with PRD 1 assembly, and building it in two places creates
   a merge conflict with that work.
4. Tests per the assertion-placement rule in AGENTS.md: unit-test
   dispatch-time clearing against a state fixture with stale fields; avoid
   new spawned scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast` plus the heavy suites your change touches
  (resume behavior lives in `test:heavy:resume-integration` — check the file
  headers). Do NOT run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, which fields dispatch now clears, and
what you verified.
