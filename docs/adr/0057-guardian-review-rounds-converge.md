# Guardian review rounds converge

Status: Accepted — approved by the operator on 2026-09-06; the design's
implementation slices (#170–#174) are cleared to start.

## Context

The post-implementation guardian gate (`src/ship-gate.ts`, ADR 0033) has no
mechanism that makes it end. Each round re-reads the entire feature diff,
remembers nothing about earlier rounds, applies a rubric under which almost
any code can block, and has no round count. ADR 0015 makes this explicit in
two places: unfavorable outcomes are never cached (`PersistedReviewResult` is
typed `"SHIP" | "ACCEPT-WITH-NOTES"`; `sanitizeReviewResult` drops the rest),
and the override cannot clear the gate when the disagreement repeats round
after round unattended.

Two runs measured the cost. `afk-v2-routing-adjudication` spent eight
architect rounds, blocking-finding counts 3, 3, 2, 2, 3, 1, 1, 2 — a series
that does not deplete — including a round-8 blocker on code that was not in
the reviewed diff at all (it shipped to `main` in `32df84b`, nine days
earlier). `afk-v2-context-envelopes` spent seven rounds (fix commits
`0060ac6`, `29f6946`, `1bbf2d5`, `27a88a8`, `2098604`, `37c5fef`, `2e3726e`)
before reaching double ACCEPT-WITH-NOTES; rounds 6 and 7 each blocked on a
single new finding discovered by resampling, not by the fix regressing.

The implementation side of the pipeline already converges by construction.
`src/qa-convergence.ts` keys findings by stable ID plus content fingerprint,
carries each finding's `clearCondition`, folds every round into a durable
lineage with dispositions (OPEN, RESOLVED, REPEATED, REOPENED, REGRESSED),
refuses reviews that silently omit open findings, caps rounds, and grants at
most one policied extension (`decideQAFinalRepair`). `src/non-progress.ts`
detects equivalent repetition across rounds. None of that machinery watches
the guardian gate. The PRD on `spec/guardian-review-convergence`
(`.kiro/specs/afk-guardian-review-convergence/`) documents the four
mechanisms in detail; this ADR records the decisions.

## Decision

Five decisions, mirroring the QA convergence machinery.

**1. Every round is recorded.** `PersistedReviewPhase` gains a per-round
ledger: the SHA reviewed, each guardian's verdict, and each finding's stable
identity, title, class, clear condition, and disposition — written for every
round, unfavorable ones included. The finding entry mirrors
`QAFindingLineageEntry`; identity resolution mirrors `matchingPriorEntry`
(stable ID first, content fingerprint second, so a renamed repeat still
collides). This amends ADR 0015's never-cache-unfavorable rule precisely:
the favorable-verdict *cache* that skips a re-review on unchanged HEAD stays
favorable-only; the *ledger* records everything. A malformed or missing
ledger degrades to a full round-1 review, never blocks resumption — the same
tolerance `sanitizeReviewPhase` already applies to the verdict cache.

*Amendment, 2026-09-06 (issue #181).* Identity resolution is one-to-one
within a round: one prior entry's stable identity goes to at most one of that
round's findings. Two findings can reach one prior entry, because the entry is
matched through both its `stableId` and its `currentId` and the guardian
prompt numbers findings fresh each round. When they do, that entry's
`stableId` goes to the claimant whose normalized class plus clear-condition
fingerprint also matches. When neither fingerprint matches, it goes to the
claimant whose ID equals the prior `stableId`. Every other claimant receives a
new stable identity and keeps its guardian-provided ID as `currentId`.
`stableId` stays unique within a guardian record, so it remains a single
lineage and cross-round matching stays order-independent.

This relaxes "stable ID first" for the collision case only, and it must: two
claimants make "a known ID match always retains the prior stable identity"
unsatisfiable. The three alternatives all cost more. Repeated stable IDs stop
`stableId` naming one lineage and make the next round's match depend on row
order. Folding one claimant away drops a reported finding. Refusing the block
as `UNPARSEABLE` discards the whole round's findings for a review that parsed
correctly, and under decision 4 a run can then reach the round cap with no
persisted blockers to file. Decision 2 removes most of the cause: the round-2+
prompt shows prior stable IDs and asks the guardian to reuse them.

**2. Round 1 reviews the branch; later rounds verify the fix.** Round 1 reads
`main...HEAD` exactly as today — it is the only round that should. From round
2 on, the guardian receives the fix diff (`<last-reviewed-sha>..HEAD`), the
open findings with their clear conditions ("verify each of these against the
fix"), and the resolved history as an explicit do-not-re-raise block. The
round's job is to disposition prior findings, not to resample 19k lines. The
ledger's absence is the round-1 signal; no new flag.

**3. Blocking authority narrows after round 1.** In round 1 the full rubric
applies, tightened by a reachability floor: a blocking finding must name a
trigger reachable in normal operation and be attributable to the reviewed
diff — an infrastructure-fault-only trigger, a crash window the next run
repairs, or pre-existing `main` behavior is a note. From round 2 on, a *new*
finding reports but does not block unless it is integrity or data-loss class
introduced by the fix diff itself; it becomes a tracked ticket either way.
A prior finding whose clear condition the fix fails still blocks — that is
the one thing a verification round is for.

**4. The gate has a clock.** After a bounded number of unfavorable rounds
(default 3, matching ADR 0014's implementation cap; configurable), the run
stops fixing: unresolved blocking findings are filed as issues, the draft PR
opens with them recorded in the body, and the run reports success with the
recorded acknowledgement — extending ADR 0015's override carve-out to the
cap exit. The PR is a draft; a human still merges. Notes that ship unfixed
are filed exactly once across rounds, keyed by the ledger identity, so a
note is neither lost nor re-raised as fresh.

*Amendment, 2026-09-06 (operator decision; slice #173 escalated for want of
it).* Two things decision 4 left unspecified.

*What counts as an unfavorable round.* A ledger round counts as unfavorable
when either guardian returns `FIX-BEFORE-SHIP`. The round counts once, even
when both guardians return `FIX-BEFORE-SHIP`. The operational outcomes in the
`ReviewOutcome` union (`src/run-state.ts`) — `UNPARSEABLE`, `NEVER_RAN` and
`DIED_MID_RUN` — do not count toward the cap and cannot trigger a cap exit. A
round whose only unfavorable signal is operational leaves the count where it
was. This settles a narrower phrasing in the PRD
(`.kiro/specs/afk-guardian-review-convergence/prd.md`, "unfavorable architect
rounds") in favor of this ADR's bare "unfavorable rounds": either guardian's
block counts. The PRD phrasing is superseded, not to be re-litigated.

*Filing failure blocks the cap exit.* Filing the unresolved blocking findings
as issues is mandatory for a cap exit, not best-effort. Filing is retryable.
If filing still fails after retries, the run does not take the cap exit — the
recorded-acknowledgement exit signal is only available once the findings are
durably filed, so a cap exit can never report success on findings that exist
nowhere but the ledger.

**5. `--open-pr-on-override` stays the attended exit valve.** The 2026-08-31
amendment to ADR 0015 already made it symmetric (either single blocking
guardian can be overridden when the other is favorable); this ADR keeps that
and adds nothing to it. Cap exit and override exit share the same recording
plumbing: PR-body section, journal note, run-summary line.

## Consequences

- The gate terminates: at most the cap's worth of unfavorable rounds, each
  after round 1 scoped to the fix, with every disagreement recorded and
  filed rather than looped on.
- Accepted decisions stay accepted. A round-5 reviewer cannot silently
  re-litigate what round 2 resolved; the anti-amnesia check
  (`validateQAReviewAgainstLineage`'s analogue) makes omission of an open
  finding an error, and the do-not-re-raise block makes re-raising visible.
- A cap can ship a real defect. The exposure is bounded by what the cap
  does: files the findings, records them in a draft PR body, and leaves the
  merge to a human. The status quo's exposure — eight rounds and still no
  PR — is unbounded in the other direction.
- Reviewer effort drops where it was most wasted: PRD 2's rounds 2–8 each
  re-read a 107-file diff to produce one to three findings, and seven of
  eight missed a defect present since round 1. Verification rounds read the
  fix.
- `prompts/architect-review.md` and `prompts/pm-review.md` gain template
  variables (round scope, open findings, resolved history) and the rubric
  edits in decision 3. `agents/*.md` personas are untouched — nothing in
  `src/` reads them for the self-run gate.
- The convergence machinery gains a third lifecycle alongside contract and
  QA: a guardian-round lifecycle in the `convergence-coordinator.ts` style,
  reusing the lineage fold, the non-progress signature check, and the
  intervention writer rather than duplicating them.
- Amends ADR 0015 (ledger vs. cache split; cap exit joins the override in
  the exit-signal carve-out). Cites ADR 0014 (cap precedent) and ADR 0048
  (findings carry their remedy; here, their clear condition and class).
  ADR 0033's module boundary is unchanged: the policy lands inside the ship
  gate and the convergence modules it already composes.
