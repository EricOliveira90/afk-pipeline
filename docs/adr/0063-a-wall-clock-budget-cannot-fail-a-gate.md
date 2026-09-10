# A wall-clock budget cannot fail a gate

**Status:** Accepted
**Date:** 2026-09-09

`suite-budgets.json` is a ratchet on test-suite cost: every scenario that spawns
a pipeline costs seconds of wall clock on every run from then on, and the suite
grew from minutes to twenty of them one reasonable-looking test at a time.
`scripts/check-suite-budgets.mjs` compares each `test:*` suite's recorded wall
clock against a number and exits non-zero when one is over.

That check was wired into `pnpm test` — which is also the command AFK's own
deterministic `tests` gate runs, and the command `resolveSanityPlan` gives the
pre-ship sanity gate and the QA evaluator (ADR 0012). So a suite with zero
failing assertions could turn a gate red, and a red gate spends a generator
round.

It did. `suite-budgets.json` records both cases. Slice #78 took a **blocking
Major finding** for a `fast` suite measured at 130.5s against a 110s budget with
every test passing; the recorded diagnosis is that "during an AFK run the
resident agents ARE the environment". Run 3's babysitter raised a budget for a
slowdown that was not there. Neither was a test regression, and neither remedy
improved the code.

The reason it cannot work is structural. A budget measures the *host*, not the
tree. An agent inside a run has no move that makes the machine faster, so the
only remedy available to it is to raise the number — the exact outcome the
ratchet exists to prevent. The check needs a reader who can decide, and no
reader inside an unattended run can.

## Decision

**`pnpm test` runs the suites and nothing else.** It is the command a
deterministic gate, the pre-ship sanity gate and the QA evaluator run. Its exit
code answers one question: did an assertion fail?

**The ratchet lives in `pnpm test:ratchet`** — `pnpm test` followed by
`pnpm test:budgets`. That is what a human runs after adding a spawned scenario,
and what CI runs if this repository gains CI. It stays fatal there, and the
rules for raising a number are unchanged: record the measurement in the commit
message and add a labelled `_measured…@<branch>` block.

**A budget overage is never a finding against a slice.** A guardian or QA
evaluator that sees suite timings has no authority to block on them. If the
timings matter, they are an operator measurement on a branch of their own.

## Consequences

- Nothing runs `test:budgets` automatically today, because this repository has
  no CI workflow and no husky hook. The ratchet is now a discipline documented
  in `AGENTS.md` and `CLAUDE.md` rather than an enforced gate. That is a real
  loss of enforcement, accepted: an enforcement point that fires at a reader who
  cannot act is worse than a documented one that fires at a reader who can.
- The already-recorded `_measured…` blocks stay in `suite-budgets.json`. They
  are the cost history of the suite and the evidence for every raise, and they
  are still the thing a raise must cite.
- This does not change how the gate classifies a *watchdog kill*. A gate command
  killed for producing no output is still `FAIL` / `COMMAND`
  (`src/gate-runner.ts`, `classifyExecution`), which is a separate question
  about `INFRASTRUCTURE` classification and a separate decision.
