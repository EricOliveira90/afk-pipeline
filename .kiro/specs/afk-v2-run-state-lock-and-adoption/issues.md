# Run-state lock and adoption - Slice Index

**Parent PRD:** TBD - see `prd.md` in this directory.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | TBD | Every run-state writer holds a cross-process lock | AFK | - | US-1, US-2 |
| 02 | #129 | afk adopt - verified manual adoption of a finished slice | AFK | 01 | US-3, US-4 |

## Before this runs

Two things are deliberately unfilled and an AFK launch will refuse until they
are:

- **Slice 01 has no GH issue and the PRD has no parent issue.** Creating them is
  an outward-facing action the excision was not authorized to take. File them,
  then replace both `TBD`s.
- **The dependency order is load-bearing.** Slice 02 is blocked by slice 01, not
  by a `#`-numbered issue, because 01 has no number yet. Fix the `Blocked by`
  cell to the real issue number when it exists — the DAG parser keys on issue
  numbers.

## Provenance

Slice 02 is PRD 2's slice 06, moved here on 2026-08-31 with its full artifact
set: negotiated contract, contract review and response, acceptance manifest,
two rounds of feedback, three QA reports and the handoff. It reached PASS(merged)
inside PRD 2's run and then blocked that PRD's guardian gate three rounds
running. Its implementation is not in the tree — read `prd.md` for why, and for
where in git history to recover it.

Slice 01 is new work with no prior art. It is the fix architect finding A1
requires, quoted verbatim in `prd.md`.
