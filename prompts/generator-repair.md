# Objective

Repair every current failure against the locked acceptance manifest inside the
declared file scope, and commit the candidate.

# Write boundary

You may change only these files:

{{FILE_SCOPE}}

{{MIGRATION_RESERVATION}}

If a correct fix requires another path, write
`{{SLICE_DIR}}/escalation.md` and stop. Never edit the locked contract,
acceptance manifest, or review artifacts.

# Stop condition

Stop after the repaired candidate is committed and the required handoff
exists, or after writing a required escalation. Gates, not this prompt or the
handoff, report verification status.

# Scope escalation

If the correct implementation requires a file outside the declared scope,
stop before making that edit. Write `{{SLICE_DIR}}/escalation.md` as exactly
`{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}`.
Use only routed finding IDs when findings were cited. When nothing was cited,
use `PRE-BUILD-SCOPE` alone. Never mix `PRE-BUILD-SCOPE` with a real finding
ID. Then stop; the pipeline routes the request to contract revision.
Also escalate a spec contradiction (including recorded ADRs), load-bearing
silence, or a declared risk class. Decide and record otherwise.

# Repair situation

Fix causes, not only listed examples.

{{REPAIR_SITUATION}}

When the situation includes preserved `stuck.md` evidence, treat that file as
read-only. Never delete, move, rewrite, or edit it.

# Locked contract view

{{CONTRACT_VIEW}}

# Acceptance manifest

{{ACCEPTANCE_MANIFEST}}

# Task

Implement each manifest behavior and preserve the listed existing behavior.
Name at least one test with each behavior ID; the acceptance gate runs per ID,
and an ID with no matching test fails. Verify locally with
`{{TEST_COMMAND}}`. Before committing, run the self-audit below over your own
diff. Commit per behavior with a conventional commit that references the
contract's GitHub issue.

# Self-audit before commit

Read `git diff` for the lines you added and remove each of these. QA reads the
same list in its quality pass; anything left here costs a review round.

- A helper, wrapper, or abstraction with one call site or one implementation.
  Inline it.
- A comment that restates the next line, or a section banner. Delete it.
- A `catch` that logs and continues or returns a default. Propagate, unless
  the contract names that recovery.
- A null or missing-value check on something this function just constructed
  or the type already guarantees. Delete it. Validate at boundaries only.
- `as any`, `as unknown as`, or a non-null `!` added to silence the compiler.
  Fix the type.
- A new parameter, option, or flag read from exactly one place. Hard-code it.
- A `V2`/`New`/`Impl` sibling of an existing function. Change the original.
- Imports and variables left over from an earlier attempt.

If you keep something on this list on purpose (a check at a real trust
boundary, a documented recovery), record the reason under `## Decisions made
during implementation` in the handoff. An undocumented keep reads as slop.
Audit only lines you changed; the write boundary already forbids cleaning
anything else.

# Patterns and harness

{{PATTERNS_AND_HARNESS}}

# Handoff contract

Write `{{SLICE_DIR}}/handoff.md` with exactly these sections and no status
claims:

## What shipped

- `<behavior ID>`: `<file:symbol that implements it>`

## Decisions made during implementation

- `<choice the contract left open and one-line rationale>`

## Gotchas / learnings

- `<fact that slices building on this one should know>`

# Current failure set

{{FAILURE_SET}}
