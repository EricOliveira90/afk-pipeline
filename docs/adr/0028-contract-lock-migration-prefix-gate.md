# Migration prefix collisions are caught at contract-lock

The contract names the migration file. That happens seconds after the
planner drafts it, and the pipeline has everything it needs at that
moment to know whether the filename can ever be merged.

## Failure mode

In the PRD 076 session a slice negotiated its contract naming
`supabase/migrations/NNN_x.sql`, explored, generated, passed QA, and
committed seven commits. Only then, at the merge mutex, did the pipeline
notice that the feature branch already carried prefix `NNN` under a
different filename. It recorded `CONFLICT` and discarded the slice.

Nothing was wrong with the work. Four hours of generation were spent
proving a filename wrong, and the fact that made it wrong was legible at
contract-lock.

## Decision

`runWave` inspects each contract the moment it reaches LOCKED. Any
declared path recognised as a migration whose numeric prefix already
exists on the feature branch under a different filename refuses the lock.
The contract goes back to `NEGOTIATING` and the planner gets another round
with an objection naming the colliding prefix and the next free prefix on
the current tip.

The refusal costs one contract round and no generation. Exhausting the
rounds on an objection the planner will not take escalates through the
existing unresolvable-contract path — no new outcome, no new terminal
state. A gate refusal earns no round-cap extension: the extension exists
for a planner closing measurable evaluator gaps, and renumbering a file is
a mechanical correction the planner already had its rounds to make.

Same prefix *and* same filename is not a collision — that is the slice
re-touching a migration it already owns, and the existing pure helper
`findMigrationPrefixCollisions` already draws that line. This gate reuses
it rather than restating it.

## Why the gate is a callback, not a step in the wave loop

The natural-looking place is the block where `runWave` reads each locked
contract's "Files expected to change" list to partition lanes. The check
belongs to the wave, and that is where the wave learns what the contract
declares — but running it *there* would put the retry loop in the wrong
module. Contract rounds are counted inside `runSliceNegotiate`, and the
wave cannot see how many are left. A wave-side loop would either
re-negotiate from a full budget each time (so "consumes a round" would be
a lie, and a stubborn planner would loop) or duplicate the round
accounting, the escalation path, and the artifact preservation that
`runSliceNegotiate` already owns.

So the wave supplies the check as `SliceContext.onContractLocked` and
`runSliceNegotiate` consults it at the point where it would otherwise
break out of the round loop. The wave owns the policy; the negotiation
owns the budget. Consequences:

- A refusal is spent, announced, and escalated by exactly the machinery an
  evaluator REVISE uses.
- The gate also covers the **lane-successor re-negotiation**, which
  re-negotiates against a refreshed tip and is precisely where a
  post-ADR-0025 collision would surface. A check placed only in the
  pre-lane block would have missed it.
- A contract left LOCKED on disk by an earlier run is gated too. Its lock
  was never tested against *this* run's feature-branch tip, so the gate
  runs before negotiation is skipped.

Taking a lock back needs `artifacts.reopenContract`, the counterpart to
`lockContract`. Status stays orchestrator-owned (ADR 0008), and the file
must not keep claiming LOCKED while the planner revises it — the generator
enforces its own Status invariant, so a stale LOCKED would carry a
contract the pipeline had already rejected into generation.

## What this does not replace

**The merge-mutex check is unchanged.** Checking the feature-branch tip
and merging must be atomic or a sibling lane can merge a colliding prefix
in between, which is why that check lives inside the merge mutex and stays
there. It remains the authority. This gate is a cheap early filter against
the tip as it stands — it catches the contract, not the generator that
went off-contract.

**Sibling collisions within a wave need no gate.** Migration-bearing
slices share a lane (ADR 0027), so a successor re-negotiates only after
its predecessor has merged and therefore sees the real tip. This gate is
deliberately scoped to the feature-branch tip alone.

## Recognition, and one inconsistency it exposes

The gate asks `migrationPathsIn` (`src/lanes.ts`) what counts as a
migration, so it agrees with lane partitioning by construction and honours
`PipelineConfig.migrationPathPattern` (ADR 0027). Reading the tip therefore
needs a layout-agnostic listing, `git.listFilesOnRef`, rather than
`listMigrationFiles` — which is hardcoded to `supabase/migrations/` and is
consequently blind to the `db/migrations/…` layouts the lane grouping
already recognises.

That leaves the gate slightly *stricter* than the merge-mutex check for a
project with a configured pattern. Accepted: the gate is an early filter,
being stricter than the authority costs a contract round at worst, and
widening the merge-mutex check is a change to the last line of defence
that this change deliberately leaves alone.

The normalisation the recognition rule applies cuts the other way in one
corner: it lowercases, so `003_Users.sql` and `003_users.sql` read as the
same filename to the gate — not a collision — while the merge-mutex check
compares raw basenames and would flag them. Also accepted, and in the
safe direction: the gate misses, the authority catches. Diverging from the
partitioner's normalisation to fix it would buy a case-sensitive-
filesystem edge case at the price of two rules for what a migration path
is, which is the thing `migrationPathsIn` exists to prevent.

`nextFreeMigrationPrefix` computes the prefix the objection offers: one
past the highest prefix in use, rendered at the widest existing width so a
padded scheme stays padded and a timestamp scheme stays a timestamp. Past
the end rather than into the first gap — a migration runner applies files
in prefix order, so filling a gap would insert a schema change before ones
already applied downstream.

## Observability

A refusal logs a phase line and emits a `warn` event with the reason
`contract-lock-refused` carrying the slice and the objection, so
`afk status --json` consumers see what the console shows. The objection
also joins the cap-decision record preserved in `stuck.md` when the rounds
run out, so an escalated slice says why.

## Considered alternatives

- **Put the check in the wave's lane-partitioning block, with a
  wave-level retry loop.** Rejected: see above — the round budget lives
  in `runSliceNegotiate`, and it would miss the lane-successor
  re-negotiation.
- **Move the check into the evaluator's prompt.** The evaluator judges the
  contract against the slice, not against the feature branch's git state,
  and asking an agent to be right about a mechanical fact the pipeline can
  compute is a worse trade in both directions.
- **Widen the merge-mutex check to the configured pattern and rely on it
  alone.** Does not address the cost being fixed here: the merge-mutex
  check is correct and correctly placed, it is just four hours late.
- **Renumber the migration automatically.** Rewriting a filename and its
  references is a semantic change to someone's schema history. Out of
  scope in the parent spec, and handing the planner the free prefix gets
  the same outcome inside the rounds it already has.

  > **Amended by ADR 0034:** for runs with an `afk.json` manifest, the
  > planner is handed an exact pipeline-owned *claim* rather than the
  > next free prefix, and renumbering guidance is removed from the
  > generator prompts — agents never calculate prefixes. This gate and
  > the merge-mutex check are unchanged and remain the path for
  > manifest-less runs.

## Extends

Extends ADR 0027 (which named this check as worthwhile and tracked
separately) and ADR 0008 (the orchestrator owns contract Status, in both
directions now). The merge mutex, the lane rules, and every outcome phase
are unchanged.
