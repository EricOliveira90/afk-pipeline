# Track 3 session — ticket lint tool (afk-v2 plan §3 item 6)

You build the pre-AFK ticket lint for the AFK pipeline, by hand, in your own
worktree, then run it against the PRD 2–6 tickets and fix what it flags. This
is plan §3 item 6 — it is one half of the gate to PRD 2 ("wave merged +
tickets linted"), so it must be complete before PRD 2 enters AFK.

## Setup

Create a fresh worktree from main of the pipeline repo:

```
git -C C:\Code\afk worktree add ..\track3-ticket-lint -b tool/ticket-lint main
```

Work only inside that worktree.

## Read first

- `docs\specs\afk-v2-plan.md` in your worktree — §3 item 6 (the narrowed
  check set and what gates vs warns) and §2 (the PRD → slice-issue table:
  PRD 2 #80 #81 #82 #89 #94, PRD 3 #83 #90 #95 #99, PRD 4 #84 #85 #91 #96
  #86, PRD 5 #87 #92 #97, PRD 6 #88 #93 #98)
- `docs\specs\afk-v2-plan-debate.md` in your worktree — item 6: the four
  checks, why check 1 is an authoring-checklist item and not a lint, why the
  mandatory rejection-cases ticket field was cut, and the waive-with-reason
  design
- Two tickets that lost rounds to lintable defects, for grounding:
  `gh issue view 77 --repo EricOliveira90/afk-pipeline` and
  `gh issue view 78 --repo EricOliveira90/afk-pipeline`
- `AGENTS.md` in your worktree — test discipline and where a new assertion
  belongs
- `scripts\check-suite-budgets.mjs` in your worktree — the repo's precedent
  for a small deterministic check script with importable decision functions
  and unit tests (`src\check-suite-budgets.test.ts`)

## Task

1. Build the lint as a small deterministic tool (a script in `scripts\` with
   its decision functions unit-tested, following the check-suite-budgets
   precedent). Scope is exactly the debate's narrowed set:
   - Check 2 — an acceptance criterion names a state/field/artifact absent
     from the referenced schemas → **gates**, unless waived with a recorded
     reason.
   - Check 3 — a recording obligation without a named channel → **gates**,
     same waiver rule.
   - Check 4 — summarised field lists → **warns** (lexicon lint), never
     gates.
   - Check 1 (compound predicates) — do NOT build it; it is an authoring
     checklist item. Record it as such in the tool's usage text.
2. Waivers are recorded text in a committed file, one entry per waived
   finding with the reason — a waiver that lives only in someone's head is
   the rubber stamp the plan warns about.
3. Run the tool against all PRD 2–6 slice tickets listed above. Fix what it
   flags by editing the issues (`gh issue edit`), recording each edit
   (issue, before, after) in your handoff; waive with reasons what is
   deliberately kept.
4. Keep the tool's schema knowledge honest and minimal: if the smallest
   design needs a declared list of known states/fields/artifact names rather
   than parsing the source, do that and say so. If you write an ADR, it is
   **ADR 0049** — 0044–0048 are reserved for the wave-3 sessions.
5. Tests per the assertion-placement rule in AGENTS.md: unit-test the check
   decisions against fixture ticket text; no spawned scenarios — this tool
   never touches the pipeline runtime.

## Constraints

- A live AFK run may be executing in `C:\Code\afk-v2-run`. Never touch that
  checkout, its `.afk\` directory, or its tests.
- This session may run in parallel with wave-3 sessions s3/s5/s6/s7/s9. The
  tool must not modify any pipeline source under `src\` beyond its own test
  file, so there is nothing to conflict with.
- Tests: `pnpm test:fast` only — no heavy suite is touched. Do NOT run the
  full `pnpm test`.
- Commit on your branch. Do not merge or push to main.

## Handoff

Report: branch name, files changed, the finding counts per check per PRD,
every issue edit made (issue, before, after), every waiver recorded with its
reason, and what you verified.
