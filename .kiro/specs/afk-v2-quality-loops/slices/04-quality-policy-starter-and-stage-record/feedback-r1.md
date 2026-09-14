# Contract feedback — round 1

## What already holds

This contract is close. The scope lock is a clean cut along #87's separable
tail: two records nothing in the cleaner's round loop reads, with the cleaner
stage itself, the per-slice rows, `readQualityStageOutcomes`, the
`quality-stage-attempt` family and the draft-PR section all named as #97's
work. `RUN_STATE_VERSION`, `GATE_EVIDENCE_VERSION` and
`EVENTS_SCHEMA_VERSION` are pinned in the non-goals, and enabling the cleaner
for this repository is explicitly excluded, which matches the acceptance
criterion that the root `afk.config.json` is not edited.

Three of the explorer's four open unknowns are resolved by recorded decision
rather than left for the generator to guess, and each decision cites the
shipped code that forces it:

- the README placement question is answered with a concrete anchor
  (`## Quality policy starter` immediately before `## Setting up guardian
  reviews`, beside the existing `### Templates` block);
- the gate-id question is answered by namespacing, on the ground that the
  reserved bare `lint`/`tests`/`typecheck` ids would collide and the clean-gate
  parser refuses a collision — the issue names the checks, the parser names the
  id rule, and the contract says so;
- the "does an unconditional section have precedent" question is dissolved
  rather than answered: the `## Quality Stages` section is present exactly when
  the event is present, so it follows the existing `## Final Evaluation Reuse`
  filter idiom and a historical stream with no event still renders a
  byte-identical summary. P-04 then pins every other section, the table, the
  totals row and both write sites.

Gate choices are apt. `typecheck` carries the additive `RunEventPayload`
member (a union widening is exactly what `tsc --noEmit` observes), `tests`
carries the file-content and rendering assertions, and the unexecutable `lint`
gate is claimed by no behavior. `expectedCostMs` is correctly declared advisory
budgeting metadata with no pass/fail wiring, which is the ADR 0063 rule rather
than a restatement of it. The event-count obligation is the right shape: one
event for a single-slice run and one for a wave of N, never N and never per
slice, proved by an `it` on an existing spawned scenario's shared
`events.jsonl` rather than by a new spawn — the assertion ladder used as
intended. Nothing here changes a parser's accepted input language: the
template is authored input to the existing parser, and the renamed-key fixture
copy pins that the shipped file's shape is the parser's rather than prose.

## What has to change before this can lock

**The `enabled: true` case has nowhere to live.** B-07 requires two fixtures —
one with no `gatePolicy.clean` and one whose `afk.config.json` declares `clean`
with named gates — but the enabled half is the only spawned bullet in the test
plan that names neither a scenario nor a file. The two bullets around it are
explicit ("an `it` on the existing shared result", "an `it` on the existing
spawned scenario"); this one is not. Meanwhile `fileScope` is ten source and
test modules with no fixture repo or fixture `afk.config.json` in it, and P-01
plus the non-goals rule out using this repository's own config to supply the
enabled case. That leaves the generator with no good move: writing a fixture
config lands an out-of-scope path, and not writing one means the `enabled: true`
branch — the only branch where the new behavior is visibly on — is never
exercised.

Resolve it either way, but resolve it by name. If a spawned scenario's fixture
already declares `gatePolicy.clean`, cite that fixture's path in B-07 and the
test plan. If the fixture has to be created or edited, add the owning fixture
area to `fileScope` with explicit authorization to write it; and if the
enabled case needs its own spawn rather than riding an existing one, say so
with the ladder justification the repo asks for and add `pnpm test:ratchet` to
the definition of done alongside the two heavy suites already listed.

## Smaller things worth tightening

- B-01 asks `gatePolicyPaths` to name "the threshold-bearing files the
  `feedback-integrity` `gate-policy` rule relies on", but the explorer could
  not locate any `feedback-integrity` symbol, and the stated observation only
  checks that `protectedPaths` is present and parses. A targeted grep during
  the slice will find it, so this is not a lock blocker — but either list the
  paths or say the set is discovered and state what the test asserts about it.
- B-02's `then` ends with "expectedCostMs wired to no pass/fail condition",
  which the observable result does not observe. It is true by construction
  because the slice adds no reader of that field; either say that or move the
  clause to the non-goals.
- B-04's `then` includes the placement relative to `## Setting up guardian
  reviews`, but the observation checks only heading, path and the
  clean-enables-the-cleaner statement. Assert the ordering or keep placement as
  a recorded decision outside the gated obligation.

## One thing to sanity-check while implementing

The hoist of the single `loadGatePolicy` snapshot from its current site up to
just after the `run-started` emission spans a couple of hundred lines of
`runPipeline` setup. The contract is right that it must stay one call feeding
every present reader, and right that a malformed-policy refusal should still
land after the first `run.log` line — just confirm nothing between the two
positions is a prerequisite of the call, so P-05 holds by construction rather
than by luck.
