# Contract review — round 3

Slice: `01-required-input-budget` (GH #273)

Both findings routed into this round are closed. The revision put the two
behaviors that existed only in contract prose into the gate-bearing artifact,
which is exactly what the round asked for, and it did so without loosening
anything the earlier rounds had settled.

## F-04 — B-10 is now a manifest behavior

The acceptance manifest carries a `B-10` entry. Reading it against the
contract's B-10:

- The **given** carries the honest starting state rather than assuming the
  path exists: `run.log` receives no `logger.phase` entry for a refused
  assembly, and the summary table renders a slice's `error` only for
  `AWAITING-ADJUDICATION`. That is the same absence the explorer evidence
  reported, so the behavior is written as an addition, not as a repair of
  something already there.
- The **when** names both new exported functions and the seam each runs at:
  `renderPromptPreparationRefusal(sliceTag, message)` through `logger.phase`
  (with `RunJournal.phase` identified as the thing that appends to `run.log`)
  before the error is rethrown unchanged, and
  `promptPreparationRefusalSection(slices)` included by `Logger.writeSummary`
  for every `ERROR` slice whose error carries the `CONFIGURATION: ` prefix.
- The **then** demands the whole retained refusal text in both artifacts —
  every total and per-artifact referenced weight, nothing omitted, truncated,
  or summarized — and holds the thrown type, the message, and the terminal
  outcome fixed, which keeps B-10 consistent with P-04 rather than in tension
  with it.
- `observableResult` names `src/logger.test.ts` and both functions under test;
  `preservation` is false and `gateIds` are `typecheck`, `tests`,
  `acceptance:behaviors`, matching B-01 through B-09. The
  `acceptance:behaviors` gate now has a `B-10` id to select, so AC7's
  `run.log` / `run-summary.md` half is enforced: an implementation that skips
  the two functions fails a gate. Both files were already in `fileScope`, so
  nothing had to be widened.

The call-site correction in contract.md is also right. There are exactly two
`assembleGeneratorEnvelope` call sites in `src/orchestrator.ts`: `:5838`,
which takes a `mode` variable and therefore covers the initial round and an
ordinary repair round, and `:8041`, the merge-resolution round's
`dispatchGenerator`. The prior "`:5838` initial, `:8041` repair" labelling
would have sent an implementer looking for a separate repair seam; the revised
wording matches the file.

## F-05 — P-05 is now a manifest behavior

The manifest carries a `P-05` entry with `preservation: true`:

- The **given** is a run directory whose journaled `prompt-assembly` events
  carry only the pre-slice field set, and it enumerates the five fields that
  are absent, so there is no ambiguity about which fixture state is being
  replayed.
- The **then** states the unchanged resume decision and the unchanged
  run-summary prompt-bytes aggregation, with the absent referenced weight read
  as absent rather than as zero, citing the read rule at
  `src/logger.ts:465-466` that B-06 preserves.
- `observableResult` names both declared journal-replay seams,
  `src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts`, and
  says the evidence reuses an existing scenario's fixture rather than adding a
  spawned scenario. That is consistent with the slice's non-goal against a new
  spawned scenario and with the repository's assertion ordering.
- `gateIds` are `typecheck`, `tests`, `acceptance:behaviors`.

Two consequences worth naming. The two `fileScope` paths
`src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts` now have
a manifest behavior that says what they must assert, which is the condition
F-02 originally described. And B-06's rewritten entry states the
optional-on-read rule in its own `then` while pointing at P-05 for the read,
so the delegation chain the finding traced now ends at a gate-bound entry
instead of at prose. Making the new fields required, or aggregating an absent
referenced weight as zero, now fails something.

## Nothing new to raise

The revision touched three regions: B-10's call-site labelling in contract.md,
B-06's rewritten given/when/then and `observableResult` in the manifest, and
the inserted B-10 and P-05 entries. Judged on gate aptness, scenario honesty,
evidence-backed scope, blocking unknowns, single-session feasibility, and the
declared non-goals, none of them opens a gap.

B-06's rewrite trades its earlier inline line citations for prose, but it
keeps every substantive obligation — the five recorded values, per-artifact
entries, `assembledByteSize` retaining inline-only meaning, the optional-on-read
rule — and its `observableResult` still homes the evidence in
`src/context-envelope.test.ts` for the event shape plus
`src/orchestrator-runs.test.ts` for the journaled event. Both paths are already
in `fileScope`. The contract's own B-06 still carries the line references, so
nothing was lost from the pair as a whole.

The contract pair is accepted as it stands.
