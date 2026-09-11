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
Then stop; the pipeline routes the request to contract revision.

`findingIds` is always required, and which identity belongs in it is decided by
what this invocation was handed:

- **Findings were cited to you** — unresolved QA findings, base-gate failures,
  a stuck diagnosis, or contract-review findings. Cite the IDs whose correct
  fix needs the undeclared paths, and only those: `["QA-03"]`,
  `["F-01","F-02"]`.
- **Nothing was cited to you** — a first attempt with no findings to fix, so
  you discovered before building that the locked file scope is too narrow. Use
  the reserved pre-build identity, alone:
  `{"version":1,"findingIds":["PRE-BUILD-SCOPE"],"paths":["src/file.ts"],"reason":"..."}`.
- **A failing orchestrator-run gate told you** — a deterministic gate the
  pipeline itself ran reports that behavior the locked contract already decided
  needs a path the file scope does not declare. Use the reserved gate identity,
  alone, in a version 2 document that cites the gate:
  `{"version":2,"findingIds":["GATE-SCOPE"],"paths":["src/file.ts"],"reason":"why the failing gate requires the paths","gateEvidence":{"gateId":"scope","evidenceArtifactId":"gate-evidence/candidate-r1-a1.json"}}`.
  `gateEvidence` is required with `GATE-SCOPE` and legal only with it: a scope
  widening justified by nothing is refused, and so is a cited-finding
  escalation that cites a gate instead of its finding.

Never mix these three identities — not with each other, and not with a real
finding ID. An escalation is a cited-finding fix, a pre-build discovery, or a
gate-evidenced revision; a document claiming two of them describes no single
event and is refused. `version` is 2 only for the `gateEvidence` document.

A scope revision fixes a boundary drawn too narrow. It is not a way to decide
something the contract did not decide. If what you discovered changes behavior,
a public interface, a data format, security posture, or the acceptance
criteria, escalate for a human decision instead of asking for a wider scope.

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
