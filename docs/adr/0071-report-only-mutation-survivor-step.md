# Report-only mutation survivor step at the ship gate

**Status:** Accepted
**Date:** 2026-09-15

## Context

Every AFK gate ultimately trusts the test suite the generator itself wrote.
The feedback-integrity gate catches deleted tests; nothing catches weak ones.
A green suite proves that the assertions the generator chose pass, not that
they would notice a wrong implementation — #120's generator drove eight
commits "to green" over code that did not compile.

Mutation testing is the deterministic detector for that gap: a tool breaks
the code in small, systematic ways and re-runs the tests; a mutant the tests
do not kill is a proven blind spot. The provenance for treating it as a core
constraint is Robert C. Martin's SwarmForge, which keeps mutation testing
even while retracting heavier harness choreography. The provenance for
refusing to act on the result automatically is Martin's own remediation
guidance, argued publicly with Tim Ottinger in 2026: triage survivors, do not
kill them all. Killing every survivor forces brittle change-detector tests —
scars — and "mutant killed" is a criterion gameable by exactly the slop it
exists to detect.

Wall-clock and rate thresholds teach agents to game the number (ADR 0063,
slice #78). So the question this ADR answers is not "how do we enforce
mutation coverage" but "how do we put a survivor list in front of a human
without giving any agent a number to optimize."

## Decision

One flag, `--mutation-report`, default off. The consuming project declares
the mutation command and the path of the machine-readable report that command
writes; AFK parses the standard mutation-testing-elements report schema
(emitted by StrykerJS and peers) and never scrapes tool stdout. With the flag
set and nothing declared, the launch is refused before any agent is
dispatched — AFK will not guess a mutation command, and a run that reported
nothing would look like a run with no survivors.

The step runs once per run, in the ship-gate phase, on the merged feature
branch, concurrently with the guardian reviews, over the files the run
changed (the same change-summary builder the pipeline already uses, filtered
to mutation-eligible source files). After the guardians rejoin, the gate
waits at most a flat 30 minutes; a step that has not produced its report by
then is terminated through the normal quiesce path on the review worktree. A
detached post-exit process is refused by design — it would violate the
teardown quiescence invariants (ADR 0020, ADR 0035). The bound is a module
constant, not an option field: a configurable bound is a number to tune, and
tuning it is how the report becomes a gate by accident.

Outcomes are structural and two-valued. `MUTATION_REPORTED` means the report
parsed and its survivors — possibly zero — are listed in `run-summary.md` and
in the draft PR body. `MUTATION_NOT_RUN` names why instead: the bound was
reached, the command failed, or the report was unreadable or malformed. Both
outcomes are persisted in run state with the run's own run id as provenance,
and both open the draft PR.

### Decisions file schema

Triage is recorded, not inferred. A committed decisions file marks survivors
already adjudicated so the report labels them as accepted instead of
re-raising them every run. Each entry carries the mutant identity, the
consequence if the mutant were real, the containment that makes it
acceptable, a verdict of KILL or ACCEPT, and one line of reasoning. The
reasoning field is the point: an accepted survivor with no argument is
indistinguishable from an ignored one.

The file's version regime matches the manifest's — `version: 1`, refused when
absent or different, validated by the same `parseAfkManifest` discipline that
governs `afk.json`: a member is either declared and well-formed or the launch
is refused, never silently defaulted.

### Trust ladder

Triage authority moves in measured stages, and only the first exists as
mechanism: (A) a human decides every entry; (B) an agent proposes entries and
a human ratifies them; (C) per-category autonomy, granted only where the
agent's proposals match the recorded human corpus, measured with the
agent-eval harness. Stages B and C are direction recorded here, not code
shipped here. The writer of a killing test must never be its accepter.

### Refusals

These are the arguments this ADR settles, so that a later slice reopening one
has to argue against a record rather than fill a silence:

- **no blocking mutation gate** — the survivor list can never fail a gate,
  change a guardian or QA verdict, or hold back a merge.
- **no kill-rate or score threshold** — no percentage anywhere, in any gate,
  summary, or prompt. A rate is the number agents learn to game.
- **no generator-loop mutation** — mutation never runs inside the generator's
  verification command, per slice, or per QA round.
- **no hardener role** — the survivor list is the ROI evidence for whether
  such a role is worth building, not a reason to build it now.
- **no automated survivor-killing** — no AFK slice kills mutants, because
  "mutant killed" is gameable and remediation cost is the known failure mode.

## Consequences

A reviewer at the draft PR gets a deterministic answer to a question no gate
asked, and the recorded evidence — do the survivors point at real defects? —
decides whether this feature earns escalation or deletion. That is the same
governance the self-audit gate runs under (ADR 0063).

The costs are accepted deliberately. A run can spend up to 30 minutes of
ship-gate wall clock on output nothing depends on. A repo that declares
nothing gets nothing, and declaring the command is the repo's decision, not
AFK's. `MUTATION_NOT_RUN` will be common at first, and that is honest output
rather than a failure. Baseline attribution and decisions-file marking are
described here as the mechanism's shape; they land as their own slices, and
until they do every survivor is unattributed.
