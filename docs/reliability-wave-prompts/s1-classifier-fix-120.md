# Wave session s1 — classifier fix, narrow form (plan §3 item 1, defect #120)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is plan §3 item 1 — the highest-priority item.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s1-classifier -b wave/classifier-fix main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3 item 1
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — item 1 rationale and the rejected alternative
- `gh issue view 120 --repo EricOliveira90/afk-pipeline`
- `src\gate-runner.ts` in your worktree — the `prepare` step and the INFRASTRUCTURE vs FAIL/CONFIGURATION classification; the one-marker whitelist is near line 202 (`LOCKFILE_DRIFT_MARKER`), with warning comments near lines 197–200 and 244–248
- `C:\Code\afk\docs\adr\0036-tool-call-cap-opt-in.md` (the retry anti-pattern) and `0025-agent-failure-causes.md`
- `AGENTS.md` in your worktree — test discipline and the assertion-placement rule

## Task

1. Change the `prepare`-failure classification in `src\gate-runner.ts`: a
   non-zero exit from a package lifecycle script (e.g. `prepare` running
   `tsc`) is candidate-owned (FAIL/CONFIGURATION), keyed on exit code — not
   on message text. Keep the existing `ERR_PNPM_OUTDATED_LOCKFILE` behavior.
   Everything that fails before lifecycle scripts run (fetch, network,
   registry) stays INFRASTRUCTURE.
2. Do NOT implement the full inversion (candidate-owned unless a known
   environment signature). The debate rejected it: it converts transient
   network faults into burned generator rounds.
3. Write one ADR in `docs\adr\` (next free number): the rule is "when
   classification is uncertain, choose the branch that cannot loop", applied
   in this narrow form. Note that wrong-blame costs at most one recoverable
   round; wrong-INFRASTRUCTURE burned both retries and killed a slice
   (measured: a one-line TS2820 consumed a ~100-minute round).
4. Add tests at the unit level per the assertion-placement rule in AGENTS.md.
   Do not add a new spawned pipeline scenario.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: run `pnpm test:fast` plus the heavy suites your change touches
  (likely none beyond fast for gate-runner units). Do NOT run the full
  `pnpm test` — the shared wave merge gate runs it once for all sessions.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the ADR number, and what you verified.
