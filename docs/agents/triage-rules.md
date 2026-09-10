# Triage Rules (repo-specific)

Additional rules the `/triage` skill applies in this repo, on top of its
own instructions. They extend existing steps; they do not change the
state machine.

## 1. Vision citation — required for `ready-for-agent` / `ready-for-human`

`docs/PRODUCT.md` is the vision file and the scope filter. During the
**Recommend** step:

- A recommendation of `ready-for-agent` or `ready-for-human` must cite
  which part of the vision the issue serves: a named PRD or §3 item in
  `docs/specs/afk-v2-plan.md`, a fired re-open trigger (plan §6 /
  `.out-of-scope/`), or a specific PRODUCT.md success criterion or
  principle.
- No citation found → recommend `wontfix` (rejected enhancement, record
  in `.out-of-scope/` with a re-open trigger) or `needs-info`. The
  default is no; the burden of proof is on the proposal.
- An issue justified by hypothetical external users fails: adoption by
  others is out of scope until v2 is complete (PRODUCT.md).
- If triage concludes the *vision itself* is wrong, escalate that as its
  own decision to the maintainer; the issue that prompted it waits.

## 2. Stale-but-valid issues — refresh before `ready-for-agent`

The skill's redundancy check already catches "already implemented".
This rule covers the other half: the issue is still worth doing, but
prior development made its description inaccurate (renamed files, moved
behavior, changed mechanisms, done-criteria referencing things that no
longer exist).

- During **Gather context**, check the issue's claims against current
  `main`, not against the state of the repo when the issue was filed.
- If the need is valid but the body is stale, update the issue body
  (or post a correcting comment) against current `main` **before**
  moving it to `ready-for-agent`. An agent brief written from a stale
  body is a defect.
- Prefix any rewritten body or comment with the standard triage
  disclaimer.

## 3. Batch triage — end with a parallelism note

When triaging multiple issues in one session, end with a short
parallelism note over the issues that came out `ready-for-agent`:

- Which of them have disjoint expected file hints and no dependency
  edge between them, and can therefore be ticketed into concurrent
  tracks (per plan §3c policy 5, concurrent AFK runs need separate
  clones, reserved migration prefixes, low file-hint overlap, and
  linted tickets).
- Which ones overlap and should serialize, and on what (named files or
  shared resources).

One paragraph is enough. Minor anticipated conflicts are acceptable —
they can be resolved later (e.g. with the `resolving-merge-conflicts`
skill); flag them rather than forcing serialization.


## 4. Design-stamina lane (refactor / test-health / gate-reliability)

An item whose whole value is keeping the codebase malleable or the
evidence trustworthy (refactors, flaky tests, misleading names, gate
reliability) is exempt from the §1 roadmap citation — it is judged on
design-stamina grounds instead (see the research doc §C.5: this work is
what keeps YAGNI viable). The fence:

- It must name **observed friction**: a measured cost, a recorded
  incident, or a pain that recurred at least twice. "This would be
  cleaner" is not friction; no friction named → wontfix with a re-open
  trigger.
- Its default vehicle is **fold into the next slice that edits this
  area**; a standalone slice needs the friction to justify its own
  round cost.
- Test-health and gate-reliability items also cite PRODUCT.md
  principle 6 directly: a flaky or misleading gate corrupts evidence.

Decision recorded 2026-09-08 (option 2 of the first batch's escalation);
supersedes the strict-citation-only reading of §1.

## 5. Opening moves — read the worktrees, not only the checklist

Run this before triaging anything, and again before recommending that
work be *started*:

```bash
git worktree list
git branch -vv          # look for branches with no [origin/...] upstream
```

For every worktree that is not the primary one and every branch with no
upstream, in that worktree:

```bash
git cherry -v main HEAD   # + = commit not on main; - = already landed
git status -sb            # dirty tree, and upstream sync state
```

A `+` line or a dirty tree means finished or in-progress work exists that
no remote, no PR and no checklist knows about. That work is the triage
outcome: **verify and merge it**, not "ready to start".

**Why this is a rule.** On 2026-09-09 a triage pass reported #143, #144
and #206 as not started while all three sat fully implemented in
`C:\tmp` worktrees — clean trees, one commit each, unpushed, no PR. The
pass had read `docs/specs/wave-2026-09-08-triage.md`'s unchecked boxes
and stopped there. A second pass the same day repeated it. The
postmortem line is the rule: *both read the checklist instead of the
worktrees.*

This also cuts the other way, so run the check before agreeing that a
worktree is leftover: `C:\tmp\afk-149`'s issue was closed and its patch
had landed on main (`268b5a9`), which only `git cherry` proved —
while `C:\tmp\afk-guardian-review-convergence` checked clean the same
way (tip an ancestor of main, zero ahead, in sync with origin). Both
were safe to remove; neither was safe to *assume* removable.

Two consequences for the write-up:

- A stale checklist is a finding. Say so, and fix the box.
- "Already implemented" here does not mean the skill's
  already-implemented `wontfix` — the code exists but has not shipped.
  Keep the issue open and record the merge path.

Recorded 2026-09-09, from that pass's own miss.
