# AFK v2 ladder - runbook

> **STATUS (2026-09-02).** PRD 1 is complete: PR #125 merged, #69 closed.
> Live sequencing — the reliability wave, the parallel tracks, and the
> AFK-vs-manual split — now lives in `docs/specs/afk-v2-plan.md` §4–§5;
> where this document's sequence and the plan disagree, the plan wins.
> The launch mechanics and per-PRD procedures below remain valid.

The operational procedure covers PRDs 1–7. Each run uses the AFK version
that the prior merged work produced. Design record:
`docs/specs/afk-v2-agent-roles.md`. The main plan owns issue and slice scope.

State at time of writing: PRD 0 merged; gauntlet slice 01 merged
(gate runner in main); PRD 1 prepped at `C:\Code\afk-v2-run`
(branch `run/v2-evidence-backbone-host`); bugs #101 and #102 filed.

## Phase 0 - before the PRD 1 launch

1. Fix #101 (ship gate's uninstalled review worktree) in a fresh
   session - the prompt is written. Human reviews and merges its PR.
   Without this fix every run ends in a manual PR with guardians
   skipped.
2. Diagnose #102 (Windows worktree-teardown race). Fix now if small;
   otherwise defer to the PRD 1 -> PRD 2 gap and accept some
   flakiness in the PRD 1 run.
3. Refresh the prep chain after those merges: merge `origin/main` into
   `prep/afk-v2-evidence-backbone`, push, fast-forward
   `C:\Code\afk-v2-run`, run `pnpm install`, `pnpm build`,
   `pnpm test:fast`.
4. Update the babysit prompt's verified commit to the new host HEAD.
5. Optional but useful before PRD 4: profile the suite once
   (`pnpm vitest run --reporter=verbose`), keep the per-file timing
   list - it feeds the `test:related`/`test:full` split (#86).

## Phase N - one PRD run (repeat for PRDs 1–7)

Launch:

1. Check active AFK runs. Default to one run. Use a concurrent run only
   when `afk-v2-plan.md` §3c policy 5's four conditions all hold.
2. Fresh agent session; paste that PRD's babysit prompt. The babysitter
   launches from the host worktree, monitors, retries, and stops at a
   draft PR. It never merges.
3. During the run, the human handles what the babysitter brings:
   STUCK decisions (granted resume against write-a-prompt) and - from
   PRD 2 onward - impasse adjudications.

Land:

4. Human verification on the draft PR: full `pnpm test` green, review
   the diff, check the run-summary. Merge.
5. Bookkeeping: close the parent PRD issue and any slice issues the
   run left open, each with a comment naming the merge. File every bug
   the run exposed. Delete the run's host worktree and prep branch.

Reconcile (the between-PRD work):

6. Update the design record (`docs/specs/afk-v2-agent-roles.md`) and
   `CONTEXT.md` glossary where implementation taught something or new
   domain terms landed (manifest, finding states, escalation,
   adjudication, checkpoints, evaluator roles).
7. Re-read the NEXT PRD's spec issue and tickets against the now-real
   codebase. The previous PRD changed assumptions; edit the GH tickets
   where they drifted. Do not re-plan untouched PRDs further out.
8. Prepare the next run: prep branch off the new `origin/main`; commit
   `.kiro/specs/<next-slug>/prd.md` + `issues.md` (slice table from the
   tickets, edges as "Blocked by"); push; fresh host worktree;
   install + build + test:fast; write the babysit prompt (slices,
   edges, protected parent issue, verified commit). Legacy mode stays
   correct for this repo: no afk.json, no migration pool.

## Ladder-specific notes per gap

- After PRD 1: negotiation now runs on manifests, canonical verdicts,
  and the lock gate. Sanity-check that the PRD 0 planner/evaluator
  prompt edits still match the new artifact expectations - PRD 3
  replaces them wholesale later, but PRD 2's run uses them.
- After PRD 2: install the relocated babysit skill globally and use
  the updated `$babysit-afk` (courier duties) for every later run.
  Expect impasse pings - answer them; a parked slice waits on you.
  Fix #102 here at the latest.
- After PRD 3: prompts are fully assembled envelopes; the PRD 0
  interim edits are dead. Check provider-independent assembly and
  stub-provider parity. The live cross-provider matrix stays deferred.
- Before PRD 4: apply the measured structured guardian policy in the
  guardian-convergence follow-up. Complete #135's provider-specific
  environment inventory and filtering. Do not add an OS sandbox,
  network allowlist, or role-specific environment policy.
- Before PRD 4: gate runner (slice 01, merged) and profiling data from
  Phase 0 step 5 should be in hand.
- After PRD 4: runs get cheaper and safer through the full M6 policy,
  scope and coverage gates, the candidate evaluator, and the feedback
  integrity gate. PRD 5 and PRD 7 may start in parallel under the main
  plan's concurrency policy.
- Before PRD 5: decide whether to configure real quality gates for
  this repository's own self-runs (complexity/duplication/mutation
  tools for TypeScript) or run PRD 5's machinery on its test fakes
  only. Enabling real gates on this repo is the ROI experiment, not a
  requirement.
- After PRD 5: read the per-stage time and round evidence; decide
  whether cleaner/hardener stay enabled per project.
- After PRD 7: use its versioned eval format for PRD 6 item 19.
- After PRD 6: full v2 flow live. Final pass: amend the parent spec's
  section 6 role table (explorer evidence in generator/candidate
  evaluator/contract evaluator includes - recorded in the design doc),
  update README, close roadmap leftovers, and retire this runbook into
  the design record.

## Standing rules for every phase

- Default to one live AFK run per machine. Use concurrency only when
  `afk-v2-plan.md` §3c policy 5's four conditions all hold.
- The human merges; agents open drafts.
- Never touch another run's worktrees, branches, or state files.
- Full `pnpm test` exactly once per verification, never in a loop.
- Every run's evidence (round counts, prompt sizes once PRD 3 lands,
  stage timings once PRD 5 lands) feeds the next PRD's ticket edits.
