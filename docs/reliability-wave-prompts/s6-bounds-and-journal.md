# Wave session s6 — bounds visibility + stage-duration journal event (plan §3 item 14)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 14 plus its riding journal event.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s6-bounds -b wave/bounds-visibility main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 14 and the "stage-duration journal event" riding item
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 14, and §2 for the watchdog PING that was CUT and must not be built
- `src\resume.ts` in your worktree — `MAX_RESUME_ATTEMPTS` (the invisible cliff; during #79's recovery the difference between "one attempt left" and "none" changed the recommendation and required reading the state file)
- `src\run-events.ts` and `C:\Code\afk\docs\adr\0031-run-journal.md`
- `AGENTS.md` in your worktree — test discipline

## Task

1. At every slice dispatch, report in `run.log` and `afk status`: remaining
   resume attempts, remaining rounds, remaining infrastructure retries. One
   log line per dispatch.
2. Add the stage-duration journal event: per invocation, record the stage's
   duration against its recorded history as a run-journal event
   (ADR 0031 machinery). Data only.
3. Do NOT build any alert, ping, threshold, or notification on top of the
   event. The watchdog ping was cut in the debate: an advisory ping into an
   unattended run has no receiver who can act. The event's consumers are the
   morning babysitter and PRD 5 story 17's ROI evidence. A watchdog re-opens
   only when the journal shows a bimodal doomed-vs-large distribution — via
   the debate doc's trigger, not here.
4. Tests per the assertion-placement rule in AGENTS.md: unit-test the
   reported numbers against fake state; avoid new spawned scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast` plus the heavy suites your change touches. Do NOT
  run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, a sample of the new dispatch log line,
and what you verified.
