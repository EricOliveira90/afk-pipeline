# A from-base restart never destroys unmerged commits

Extends ADR 0018 (per-slice state) and applies ADR 0023's clean-failed
refusal semantics to the restart path. The resume decision itself
(spec #33) and the `--resume-stuck` opt-in (#49) keep their shape.

## Failure mode

Relaunch of the PRD 1 run (`--only-failed`, host `adbbbd6`): slice #75
held 11 unmerged commits, a LOCKED `contract.md` carrying an operator
amendment, and run state `attempts: 2`. `decideResume` hit
`MAX_RESUME_ATTEMPTS` and converted the resume into a from-base restart.
`restartFromBase` force-reset the branch to base and recreated the
worktree.

That destroyed:

- the branch's 11 commits — recovered only because the operator tagged
  the dangling tip within seconds;
- every untracked slice artifact under the worktree: `contract.md`,
  `context.md`, `feedback-r1/r2.md`, `qa-report*.md`. None were
  archived, because archiving ran only on ESCALATE/STUCK and this slice
  was ERROR. The contract was unrecoverable.

The codebase already named this failure. `decideResume`'s
`--resume-stuck` branch is documented as deliberately exempt from the
attempt cap, because honouring it there "would silently restart from
base — destroying the very commits and diagnosis the operator asked to
keep." The plain resume path did precisely that one branch later. And
`clean-failed` (ADR 0023) refuses to delete a branch with commits ahead
of the feature branch, while the restart path applied no such check.

## Decision 1 — the invariant

**The pipeline never force-resets a slice branch that still holds
unmerged commits unless the operator named the slice in
`--force-restart`.**

"Unmerged" means the same thing it means in `clean-failed`: commits ahead
of the feature branch. A branch already at base has nothing to lose, so
it restarts silently exactly as before — that is the ordinary case (death
before the first commit, a lane-successor refresh).

`ResumePlan` gains a `refuse` action carrying the reason the restart
*would* have used plus the commit count, and `restartOrRefuse` is the one
function that applies the rule. Every guard that previously restarted a
branch with commits now routes through it:

| Guard | At base | With commits |
| --- | --- | --- |
| `--force-restart` | restart | restart (deliberate) |
| slice branch missing | restart | n/a |
| worktree missing or unregistered | restart | **refuse** |
| `stuck.md` present, no `--resume-stuck` | restart | **refuse** |
| no commits beyond base | restart | n/a |
| resume attempt cap reached | n/a | **refuse** |
| base-refresh merge conflict | n/a | **refuse** |

The cap's purpose survives intact: it still refuses to *resume* a tree
that has died repeatedly. It simply no longer expresses that by
destroying the tree. The counter is not reset on a refusal either — no
fresh tree was created, so no fresh resume budget is earned, and the next
run refuses again rather than granting another resume.

A refused slice ends the run as ERROR with a `restart-refused` cause,
reported verbatim as the slice's outcome reason. The message names the
branch, the commit count, and the flags that resolve it —
`--force-restart` to discard, plus `--resume-stuck` when there is a
preserved diagnosis to keep. Nothing is mutated before the throw, so the
branch tip, the worktree, and its untracked artifacts survive
byte-identical for inspection.

### Why the base-refresh conflict changed too

The resume path's refresh merge previously fell back to a from-base
restart on conflict, reasoning that no agent should be asked to resolve a
merge it has no context for. That reasoning is sound; the fallback was
not. A conflict means the slice's commits genuinely diverge from the
feature branch — the case where they are *most* worth keeping — and
`mergeBranchIntoWorktree` aborts cleanly, so there is a preserved tree to
refuse with. The slice now refuses: no agent is asked to resolve the
merge, and no work is destroyed to avoid asking.

## Decision 2 — every restart archives first

A slice's spec artifacts (`contract.md`, `context.md`, `feedback-r*.md`,
`qa-report*.md`, `uat-report*.md`, `handoff.md`, `stuck.md`) are
untracked files inside the slice worktree. Recreating the worktree
deletes the only copy. `restartFromBase` therefore copies them to
`.afk/artifacts/<run-slug>/slice-<NN>/pre-restart-<n>/` before touching
git — the same archive root the ESCALATE/STUCK preserve path writes to,
reusing the same file-name list so the two cannot drift apart.

The `pre-restart-<n>` index is the next free one on disk, so a second
restart cannot overwrite the first one's copies and neither can clobber
an ESCALATE/STUCK archive sitting alongside them. No clock is involved,
so the path is reproducible.

Archiving is best-effort: a failure warns to the run log and the restart
proceeds. The operator asked for the restart (or the branch has nothing
to lose), and a half-copied archive must not strand the run.

## What this does not change

- `--force-restart` still discards everything it names, on purpose. It
  is the one place a destroy is authorised, and it now leaves an archive
  behind.
- A `stuck.md` is still terminal by default. Terminal means "do not
  resume", not "destroy": with commits on the branch the operator is
  asked to choose between `--resume-stuck` and `--force-restart`.
- `MAX_RESUME_ATTEMPTS` is still 2, and `--resume-stuck` is still exempt
  from it.
- Restart still resets the attempt counter to 0. A fresh tree earns a
  fresh budget (#36).

## Amendment (2026-08-28) — the archive also moves `reviews/` aside (#123)

Decision 2 copied the slice's spec artifacts and left
`.afk/artifacts/<run-slug>/slice-<NN>/reviews/` — the contract-review and
QA/UAT evidence archives — where it was. Nothing else ever cleared that
directory either: `clean-failed` and the pre-restart archive both leave it
alone, and `pipelineRunSlug` has no per-launch discriminator, so every
launch of the same PRD and provider shares it.

Since #79 the QA evidence writes fail closed on a collision
(`errorOnExist` for the raw artifact, `wx` for the record and the
validation file). A slice whose previous life reached QA therefore
restarted into a deterministic collision at `r1-a1`, burning its
infrastructure retries and possibly ending the run ERROR before the *next*
re-launch — which has commits ahead, takes the resume path, and skips past
the occupied rounds — could self-heal.

So the pre-restart archive now **moves** `reviews/` into the same
`pre-restart-<n>` directory it copies the spec artifacts into. Moving, not
copying: a copy leaves the round-1 names occupied, which is the whole
problem. The directory travels whole, so a life's records and the raw
artifacts they reference stay side by side and only their path prefix
changes.

Two entry points call it, both being the start of a slice life at round 1
with no resume state:

- the from-base restart (`restartFromBase`), and
- a launch that finds no branch and no worktree — the `fresh` decision.
  `clean-failed` and manual branch deletion leave `.afk/artifacts` alone,
  so "fresh" in git is not fresh on disk. The move is logged; an ordinary
  first run, with nothing to move, stays silent.

The resume paths deliberately do **not** call it: `loadQAReviewResumeState`
reads exactly the evidence this moves, and the global three-round cap
(ADR 0014) is computed from it. A restart already grants a fresh round
budget, so relocating a restarted slice's prior evidence changes no
round arithmetic.
