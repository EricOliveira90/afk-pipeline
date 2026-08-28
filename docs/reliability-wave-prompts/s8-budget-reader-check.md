# Wave session s8 — reader-side budget check (plan §3, riding item)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is the ~10-line reader-side check on the suite-budget
ratchet. Smallest session in the wave — under an hour.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s8-budget -b wave/budget-reader-check main
```

Work only inside that worktree.

## Read first

- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §3, the "reader-side budget check" riding item
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan-debate.md` — §3 table entry, and the C1 resolution: the run-3 babysitter error happened WITH labels present, because no reader checked them; during the debate itself, two checkouts held diverging copies (`fast: 90` vs a recorded raise to 170) and no label inside a block can say which file governs
- `scripts\check-suite-budgets.mjs` and `suite-budgets.json` in your worktree
- `AGENTS.md` in your worktree — test discipline

## Task

1. In `scripts\check-suite-budgets.mjs`: refuse to compare a measurement
   block whose branch label does not match the current branch. Warn on tree
   divergence. Warn/refuse only — this must never become a blocking gate.
2. Establish the labeling convention the check reads: measurement blocks in
   `suite-budgets.json` carry the branch name in the block name (extend the
   existing dated block-name convention). Relabel the existing blocks.
3. Keep it small. The debate cut the keyed measurement store; this check is
   the enforcement without the build. If you find yourself writing a schema,
   stop.
4. Tests: a unit test on the compare/refuse decision is enough.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast`. Do NOT run the full `pnpm test`; the wave merge
  gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, the new block-name convention, and what you verified.
