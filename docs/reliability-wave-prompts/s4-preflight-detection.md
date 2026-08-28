# Wave session s4 — launch preflight, detection only (plan §3 item 7)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 7: check the machine before a run starts.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s4-preflight -b wave/preflight-detection main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 7
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 7, and §2 for the two auto-kill variants that were CUT and must not be built
- `C:\Code\afk-v2-run\docs\specs\afk-v2-recovery-plan.md` — Run 3 evidence (a leaked directory handle blocked a worktree refresh for an entire run) and Runs 4–6 evidence (run 6 died with 200 KB free; 467 empty directory shells looked like a space leak but held 0.02 GB)
- `C:\Code\afk\docs\adr\0035-worktree-teardown-quiesces-processes.md` — why teardown cannot cover a hard-killed run
- `AGENTS.md` in your worktree — test discipline

## Task

Add a launch preflight that runs before dispatch. **Detection + report +
fail-fast only.**

1. Fail fast (refuse the launch) on hard conditions: free disk below a
   configurable floor; leftover registered worktrees from a previous run.
2. Report, with a named PID list, live processes or handles holding paths
   inside the namespace this run will use. The receiver is the operator who
   just typed the launch command; they kill by hand.
3. Sweep empty directory shells inside the run's own namespace at start.
4. Do NOT build any auto-kill. Both debated forms were cut: the scan-based
   kill (cwd guard under- and over-matches) and the record-based kill (the
   spawn record does not exist for the crash classes that produce leaks;
   ADR 0020's own text — `taskkill /T` cannot enumerate children of a dead
   root — plus the PID-reuse caveat make it worse than doing nothing). If a
   future incident re-opens this, it re-opens through the debate doc's
   trigger, not here.
5. Tests per the assertion-placement rule in AGENTS.md: unit-test each check
   against fake inputs; no new spawned scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests. Never kill any process.
- Tests: `pnpm test:fast` plus the heavy suites your change touches. Do NOT
  run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the configured disk floor default, and
what you verified.
