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
