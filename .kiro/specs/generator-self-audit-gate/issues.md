# Generator self-audit gate - Slice Index

**Parent PRD:** #298 (spec of record). Slice issues are #299–#301, one per
externally observable behavior cluster. Titles are deliberately short: slice
artifact directories and branch names derive from `slugify(title)` and long
titles have hit Windows' 260-char path limit before (see the guardian
convergence PRD's launch notes).

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #299 | Audit invocation | AFK | — | US-1, US-2, US-3, US-5, US-11, US-12, US-13, US-15 |
| 02 | #300 | Changed-tree gates | AFK | #299 | US-4, US-6 |
| 03 | #301 | Audit accounting | AFK | #299 | US-7, US-8, US-9, US-10, US-14 |

US-16 (prose supersession) is carried by slice 01's envelope text plus the
out-of-scope note: full prose retirement waits for the default-on decision.

## Expected wave structure

- **Wave 1:** #299 (audit invocation) alone.
- **Wave 2:** #300 (changed-tree gates) and #301 (audit accounting), both
  blocked by #299. Both touch the orchestrator's audit sequencing seam that
  #299 introduces; if their declared file scopes overlap, the lane partitioner
  will serialize them into one lane. Expected, not a problem.

## Why the cut falls here

- **01 first and alone.** Every later behavior consumes the same things that
  do not exist today: the `--self-audit` flag, the audit envelope manifest,
  the dispatch point between candidate gates and QA, and the verdict
  classifier. 01 lands the classifier complete (all three outcomes) so 02 and
  03 wire paths instead of amending a schema — the same reason the guardian
  convergence PRD landed its ledger schema whole in its slice 01.
- **02 is separate from 03** because they fail differently. 02 is pipeline
  sequencing (what happens to a changed tree before QA) — a correctness rule
  about not trusting an audit "fix". 03 is honesty accounting (failure
  taxonomy, resume-spent, run-summary totals) — the evidence loop that decides
  the feature's future. A rollback of one should not roll back the other.
- **The default-on decision is not a slice.** It is out of scope by intent:
  it needs recorded `AUDIT_CHANGED`-rate evidence from opted-in runs, which
  cannot exist before this PRD ships and runs.
- **No slice adds a spawned pipeline scenario.** See the PRD's Testing
  Decisions and AGENTS.md's "where a new assertion goes".
