# Wave session s9 — contract-amendment gap (defect #112, as filed)

You implement one reliability-wave item for the AFK pipeline, by hand, in your
own worktree. This is open defect #112, carried into the wave as filed — the
plan debate did not reshape it.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\wave-s9-amendment -b wave/contract-amendment-112 main
```

Work only inside that worktree.

## Read first

- `gh issue view 112 --repo EricOliveira90/afk-pipeline` — the defect and any
  design discussion on it. The issue is the specification for this session;
  follow it.
- Summary for orientation: QA can raise boundary findings that are
  satisfiable only by reverting work the contract itself demanded — the
  contract cannot be amended mid-slice, so the slice wedges.
- `C:\Code\afk-v2-run\docs\specs\afk-v2-plan.md` — §1 defect table (the
  defect class: "the pipeline records or classifies something that misleads
  the next actor")
- `src\contract-review.ts` and `src\orchestrator.ts` (negotiate loop) in
  your worktree
- `C:\Code\afk\docs\adr\0008-orchestrator-owns-contract-status.md` and
  `0015-guardian-review-failure-classes-and-overrides.md`
- `AGENTS.md` in your worktree — test discipline

## Task

1. Implement the fix as specified in #112. If the issue leaves a design
   choice open, pick the smallest mechanism consistent with ADR 0008
   (the orchestrator owns contract status) and record the choice in your
   handoff notes.
2. If the issue's scope turns out to require negotiation-loop changes larger
   than one session, stop and report instead of building — this wave is for
   bounded fixes.
3. Tests per the assertion-placement rule in AGENTS.md: prefer unit tests on
   the contract/verdict rules; avoid new spawned scenarios.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- Tests: `pnpm test:fast` plus the heavy suites your change touches. Do NOT
  run the full `pnpm test`; the wave merge gate owns it.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, any design choice you made beyond the
issue text, and what you verified.
