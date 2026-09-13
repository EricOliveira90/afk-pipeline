# The lock gate substitutes the prefix it reserved, rather than asking for it

**Status:** Accepted
**Date:** 2026-09-12

ADR 0034 made the migration prefix a pipeline-allocated resource: agents
never calculate one. A planner drafting a contract before AFK has allocated
anything is therefore told to write a placeholder —
`RESERVED_PREFIX_<name>.sql`, from `migrationReservationBlock`
(`src/orchestrator.ts`) — and told that AFK will assign the real prefix
afterwards.

The gate that reads the result is the gate that allocates. `claimContractMigrations`
(`src/migration-claims.ts`) reads the manifest's `migrationCount`, claims that
many prefixes from the reserved pool, and validates the declared paths against
the claim in the same call. `migrationPrefixOf` finds no numeric prefix on a
placeholder basename, so the gate objects:

> Declare exactly 1 new migration path(s) in acceptance-manifest.json, using
> the assigned prefix 144.

## Failure mode

Every migration-bearing slice spent one contract negotiation round doing
nothing but substituting a number into a filename. The objection was routed to
the next planner round (`recordGateObjection`), `migrationReservationBlock` then
read the fresh claim and said *"This slice owns exactly: 144"*, and the planner
rewrote the identical contract with one filename changed.

The first draft was refused by construction, for obeying the instruction AFK
had given it. And when the evaluator's `ACCEPT` landed on the last permitted
round there was no round left to spend on the rename, so the slice died holding
a contract whose only defect was a number the planner had been forbidden to
know. Surfaced by a rumo-app run (`prd/084`), which the fix unblocks (#267).

## Decision

**When the lock gate's only objection is that the declared migration paths are
placeholders in the claimed count, the gate performs the substitution and
re-validates.** `substituteClaimedMigrationPrefixes` rewrites the placeholder
basenames in `contract.md` and `acceptance-manifest.json` with the claimed
prefixes, in claim order, and `claimContractMigrations` then asks the unchanged
validator again. Deterministic, no dispatch, no round — ADR 0061's repair pass
without the agent call, and for the same reason: a rule the pipeline enforces
mechanically should be satisfied mechanically when there is exactly one way to
satisfy it.

The contract locks in the round the evaluator accepted it in.

**The gate is narrow, and everything else is unchanged.** It fires only when
the manifest's `migrationCount` equals the claim length, every declared
migration path is a `RESERVED_PREFIX_` placeholder, and each substituted
basename lands on the claimed prefix. Anything else keeps its objection and its
round:

- A **count** that disagrees with the claim is a decision the planner made
  about how many migrations the slice needs.
- A prefix the planner **calculated for itself** is the violation ADR 0034
  exists to catch, and the objection *is* the correction.
- A **mixed** declaration — one real prefix, one placeholder — leaves the claim
  order ambiguous, so it is refused rather than guessed at.

The placeholder instruction stays in `migrationReservationBlock` (with one
added sentence saying AFK performs the substitution, so the planner is not
merely obeying an unexplained rule). The claim allocation, the count check, the
post-generation prefix check, the merge-mutex authority and the manifest-less
collision path are all untouched.

## Why this is not the automatic renumbering ADR 0028 rejected

ADR 0028 rejected "renumber the migration automatically" because *"rewriting a
filename and its references is a semantic change to someone's schema
history."* That reasoning holds and is not being reversed. It is about a
**real** prefix: a number that already means something — a position in an
applied migration order, possibly referenced elsewhere — being changed by the
pipeline on the planner's behalf.

A placeholder is the opposite. It is a hole the pipeline itself asked for,
carrying no history and no meaning, whose one legal filling is a value only the
pipeline knows. Filling it is not a decision; refusing to fill it is a round
spent transcribing.

## Observability

The locked pair differs from what the planner wrote, so the substitution is
journalled: a phase line and a `warn` event with the reason
`migration-prefix-substituted`, carrying the slice and every
`<placeholder> -> <claimed>` pair. An operator reading the run can see which
paths AFK rewrote and that no round was spent — the alternative, a silent
mutation of an agent's artifact, is the thing that makes a run
unreconstructable later.

## Consequences

- A migration-bearing slice keeps a full round budget for the contract's actual
  quality. The round the placeholder used to burn was invisible in the round
  accounting, so a slice with two real evaluator findings and a three-round cap
  had two rounds, not three.
- The `contract-lock-refused` warning no longer fires for the placeholder case.
  It still fires for a collision, a calculated prefix and a count mismatch, so
  its meaning narrows to *the planner made a choice the gate refuses* — which
  is what an operator grepping for it wants.
- The write order is contract first, manifest last. The manifest is what the
  gate re-reads and what the lock attests to, so a crash between the two writes
  leaves the placeholder in the machine file and the gate objects on the next
  pass exactly as it did before this ADR. The recoverable direction.
- Idempotent by construction: on a second call the paths already carry their
  prefixes, so the first validation passes and nothing is written. A resumed run
  and a re-gated stale lock (ADR 0028) both take that path.
- `src/wave-migrations.test.ts`'s reserved-pool scenario pinned the burned
  round — its fixture's generator recovered the path from the *planner's*
  second draft. It now reads the locked manifest, which is where a substituted
  lock and an unsubstituted one differ, and asserts one planner invocation, no
  `contract-lock-refused`, and the journalled substitution.

## Cites

ADR 0034 (the pipeline owns claims; agents never calculate a prefix — this ADR
is that principle applied to the pipeline's own gate), ADR 0028 (the gate, its
callback shape and its rejected alternative), ADR 0061 (a mechanical defect is
answered mechanically before it is terminal), ADR 0008 (the orchestrator owns
contract status: the substitution happens before anything writes `LOCKED`).
