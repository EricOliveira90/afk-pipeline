# A refused negotiation artifact is informed once before it is terminal, and every validator that enforces durable lineage must inform the prompt

**Status:** Accepted
**Date:** 2026-09-07

Two failures from the same cause: a deterministic rule the pipeline enforces
against an agent's artifact without ever telling the agent the rule.

Issue #178 (guardian-review-convergence run, slice #170, twice on 2026-09-06).
Contract negotiation escalated with two blocking findings still open in durable
lineage (`state.contractConvergence`). The operator recorded the decision and
reran, as `intervention.json` instructed. A rerun renegotiates from base at
round 1 while lineage survives in run state — that is the tamper guard working.
But no round-1 prompt mentioned the open findings: the planner's round-1 routing
returned an empty finding set, and the evaluator's initial envelope had no
lineage input at all. `ContractRoundLifecycle.evaluatorHistoryNote()` had been
written for exactly this case and had **zero callers**. The evaluator returned
ACCEPT with no findings, `validateContractReviewAgainstLineage` refused the
artifact for omitting F-01 and F-02, and the slice died. Every rerun repeated
the cycle: the enforcement side of durable lineage was wired, the informing side
was not.

Issue #188 defect 1 (PRD 072 run in `rumo-app`, 2026-09-06/07). Three
invocations of the same slice each ended ERROR inside negotiation on a refused
artifact, never the same refusal twice: `severity` written as `MINOR`, a fresh
finding's `revisionCitation.after` not matching the current manifest, and a
`contract-response.json` declaring the wrong round. Each was one field. None of
the agents was ever told what had been wrong, because ADR 0017 makes a malformed
artifact terminal for the invocation and nothing precedes that exit.

## Decision

**1. A refused negotiation artifact earns one repair pass, and the pass carries
the exact validation error.** When `contract-review.json` or
`contract-response.json` fails deterministic validation, the orchestrator
re-dispatches the same role with the validator's message verbatim in the
control-plane slot, then validates again. Budget: one pass per artifact per
round (`src/artifact-repair.ts`). When it is spent, the original terminal exit is
taken with the last defect named exactly as before.

A repair pass is not a round. The negotiation round number, the routed finding
set, the pre-round artifact text and the durable lineage are all unchanged, so a
repair cannot buy the planner another revision, retire a finding, or extend the
cap. Its attempts continue the round's archive numbering rather than restarting
it, so no attempt is lost. Three consequences of "not a round" are load-bearing
in the implementation, because each is a way the pass could quietly spend one:

- The round's other artifacts are **not** deleted before a repair dispatch, and
  the instruction says to leave them alone. The pass asks for one corrected
  file; a planner that obeys writes only that file, so deleting the
  `acceptance-manifest.json` the round already produced would leave none — and
  a missing manifest is routed as an acceptance-manifest gate objection, which
  does spend the round.
- The behavior-ID stability baseline is restored across the pass. A refused
  attempt must not become the baseline the next attempt is measured against.
- Only the refused artifact's **own** validation is repair-eligible. The
  revision-scope validator and the manifest read/write beside it are not the
  agent's response artifact, and they keep the pre-0061 terminal exit.

A refused *acceptance manifest* is deliberately not in scope for the same
reason: that refusal is scope evidence the next planner round owes an answer to
(ADR 0050), and it is already routed as a gate objection.

The budget is per artifact per round **per process**. `repairsUsed` is loop
state, not persisted: a crash mid-round grants the rerun a fresh pass. That is
deliberate — the rerun renegotiates from base at round 1 anyway, so there is no
round for a persisted counter to belong to — but it means "exactly once" holds
within an invocation, not across restarts.

The validators stay exactly as strict. #188's evidence is that the strictness
was right and the exit was premature — the field report's own suggestion.

**2. A rule enforced against durable lineage must be present in the prompt of
every round it is enforced in.** `validateContractReviewAgainstLineage` refuses
a review that drops an open blocker, so both round-1 prompts of a restarted
negotiation carry that lineage: the planner through its carried-findings block,
so the contract it writes can already meet each clear-condition, and the
evaluator through the durable-lineage block, so the review can disposition each
ID. Resolved history stays out of both, because both role manifests declare
`resolved-findings` omitted and the validator only requires the open blockers
back.

This is a general obligation, not a fix to one prompt: a validator that
enforces persisted memory the prompt does not carry is a wedge, and the wedge is
silent until a restart hits it.

The obligation binds the *set*, not only the round. Both sides now read one
exported state set (`ACTIVE_CONTRACT_FINDING_STATES`, `src/contract-review.ts`),
because the validator treats `CONTESTED` as unresolved and an informing block
that filtered to `OPEN` alone would have reproduced #178 one state value away —
including printing "no durable finding lineage" about a slice whose only carried
blocker was CONTESTED.

The evaluator carries the lineage block on revision rounds as well as the first,
which does duplicate the open set against `PRIOR_OPEN_FINDINGS` on an ordinary
round 2. That is the intended trade: `PRIOR_OPEN_FINDINGS` is the previous
*review's* open findings, so it is the lineage block that closes the same
CONTESTED gap on later rounds, and a round 1 reached with a pending gate
objection takes the revision envelope with no previous review at all. The cost
is envelope bytes on the one prompt #188 defect 2 reports already overflowing
64 KiB with no override; the fix for that is the budget setter (#161), not
dropping an informing block.

## Consequences

- A one-field schema slip in a negotiation artifact costs one dispatch instead
  of a slice. `contract-review.json` and `contract-response.json` refusals are
  no longer terminal on first sight, and the run journal records each pass as a
  `negotiation-artifact-repair` warning with the defect.
- The exit is unchanged in kind. There is still no default verdict, no extra
  round, and no reconstructed artifact; ADR 0017's rule now applies to the
  second refusal rather than the first.
- A restart after a recorded design decision converges instead of wedging. The
  operator instruction for a contract-phase intervention says so explicitly: it
  no longer promises a "resume from candidate tree" that no code consumes
  (#178's secondary finding), and names the rerun and the lineage that carries
  the findings into it.
- Durable contract lineage moves into the provider-qualified run-state file,
  the one every other read and write of a run's state already uses. On a codex
  or claude run it had been keyed on the bare PRD slug, so `afk clean-failed`,
  the resume counters and an operator editing "the" state file all operated on a
  different file than the tamper guard's memory.
- **The move is a key change, not a schema change, and it ships no migration.**
  No persisted version or shape differs, so a state file written by either build
  is readable by the other; what differs is only which file holds
  `contractConvergence` on a non-kiro run. A build on either side of the move
  therefore reads an *empty* lineage from the other's file without complaining,
  in both directions. Nothing is adopted automatically, deliberately: on a
  non-kiro run the bare-slug file may be a live kiro run's state for the same
  PRD, or an orphan an older build fabricated with the wrong `featureBranch`, so
  a blind fallback would import another run's tamper-guard memory — a worse
  failure than the one it fixes, because a lineage this build cannot see is
  recoverable by hand (#178 records the surgery) while a lineage it wrongly
  adopts refuses contracts over findings that were never this slice's. Instead
  `findOrphanedContractLineage` names both paths in one
  `orphaned-contract-lineage` warning before the first round, so the one silent
  case is in the journal.
- The remaining convergence stores — QA convergence state, non-progress history
  and exact-stage resume — still key on the bare PRD slug. That is not fixed
  here: this ADR's scope is negotiation, and relocating QA state changes which
  file a QA run reads. It is a known follow-up, and the split is now narrower
  than it was rather than wider.
- Both role context manifests gain an input-order slot for classes they already
  accepted (`open-contract-findings` for the initial planner envelope,
  `prior-open-contract-findings` and `control-plane-situation` for the initial
  evaluator envelope). No context class is new, so the manifest versions are
  unchanged — the deterministic-gauntlet rule that an undeclared class needs a
  version change is not triggered. The cost of leaving them at version 1 is
  named here rather than discovered later: `contextManifestVersion` in run
  evidence can no longer date an envelope across this change, so a future
  #178-shaped diagnosis has to read the build rather than the evidence.
- The remaining split this does *not* close: `recordRound` now writes lineage to
  `.afk/state/<run-slug>.json` and non-progress history to
  `.afk/state/<prd-slug>.json` in the same call. An operator recovering a
  wedged slice edits the provider-qualified file for findings and the bare-slug
  file for the non-progress observation count.
- Cites ADR 0017 (a malformed artifact reaches no verdict), ADR 0050 and
  ADR 0052 (the manifest-refusal and generator-discovery doors, which this ADR
  does not touch), and ADR 0057 decision 2, whose guardian prompt already shows
  prior stable IDs and asks for reuse — decision 2 above is the contract-phase
  twin of that rule.
