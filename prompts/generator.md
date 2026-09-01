# Objective

Implement every locked acceptance-manifest behavior for this slice inside the
declared file scope, and commit the candidate.

# Write boundary

You may change only these files:

{{FILE_SCOPE}}

{{MIGRATION_RESERVATION}}

If a correct fix requires another path, write
`{{SLICE_DIR}}/escalation.md` and stop. Never edit the locked contract,
acceptance manifest, or review artifacts.

# Stop condition

Stop after the candidate is committed and the required handoff exists, or
after writing a required escalation. Gates, not this prompt or the handoff,
report verification status.

# Scope escalation

If the correct implementation requires a file outside the declared scope,
stop before making that edit. Write `{{SLICE_DIR}}/escalation.md` as exactly
`{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}`.
Use only routed finding IDs when findings were cited. When nothing was cited,
use `PRE-BUILD-SCOPE` alone. Never mix `PRE-BUILD-SCOPE` with a real finding
ID. Then stop; the pipeline routes the request to contract revision.

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
