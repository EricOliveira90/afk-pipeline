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

When the situation includes a `# Merge conflict to resolve` block, a merge of
the feature branch into your slice branch is already in progress in your
worktree, and that block carries its conflict hunks plus the diffs of the
sibling work that has already merged. Resolve every conflicted path so both
sides' intent survives, then commit the in-progress merge — do not abort it,
do not reset, and do not start a new branch. Keep the resolution to the
conflicted paths: this is not a round for rescoping, redesigning, or reverting
a sibling's work, and the same write boundary and scope escalation above still
apply. A conflict marker left anywhere in the tree fails the round even if the
tests pass.

# Locked contract view

{{CONTRACT_VIEW}}

# Acceptance manifest

{{ACCEPTANCE_MANIFEST}}

# Task

Implement each manifest behavior and preserve the listed existing behavior.
Name at least one test with each behavior ID; the acceptance gate runs per ID,
and an ID with no matching test fails. Verify locally with
`{{TEST_COMMAND}}`. Commit per behavior with a conventional commit that
references the contract's GitHub issue.

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
