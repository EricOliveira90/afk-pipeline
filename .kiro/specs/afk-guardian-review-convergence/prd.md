# PRD: The guardian review converges

**GH issue:** TBD (parent). Every slice issue is TBD — see `issues.md`.
**Parent design:** none. This PRD is about the review gate itself, not a
`docs/specs/afk-v2-plan.md` item.
**Amends:** `docs/adr/0015-guardian-review-failure-classes-and-overrides.md`
**Written:** 2026-08-31, after PRD `afk-v2-routing-adjudication` spent nine
post-implementation guardian rounds without converging.

## Status after the hand fixes

This PRD is **deferred until after PRD 3 produces one measured guardian run**.
Do not create its issues or launch it through AFK before that review.

Landed by hand on `integration/pre-prd3`:

- issue #149: a planner-authored `LOCKED` status cannot replace evaluator
  `ACCEPT`;
- architect findings now state impact, recovery, and diff attribution;
- `--open-pr-on-override` can override exactly one blocking guardian when the
  other guardian is favorable; two blocking guardians still close the gate.

Deferred: the round ledger, later-round review scoping, an automatic round cap,
and note filing. The original delta-only rule and successful unattended cap
below are not approved designs. Before PRD 3, use an operator policy instead:
after three blocked guardian invocations, stop re-entry and request a human
decision without changing the blocked result to success.

## Problem Statement

The post-implementation guardian gate has no mechanism that makes it end. It
re-reads the whole feature branch every round, keeps no record of what it
already accepted, has a rubric under which almost any code can be blocked, and
gives the architect a veto no operator and no round count can clear. Those four
properties compose into positive feedback: each round's fix is new error-handling
code, error handling is the highest-yield blocking class, and the next round
reads it fresh with the previous round's accepted findings forgotten.

`afk-v2-routing-adjudication` is the demonstration. It has thirteen commits
that update both guardian artifacts, plus PM-only rerun `516e6c2`. The last
nine complete pairs are the current run's rounds 1–9 (round 1 at `076540c`,
round 6 at `d80fc61`, round 8 at `274f859`, round 9 at `2000b34`). Every one
returned `FIX-BEFORE-SHIP` from the architect. The PM returned
`ACCEPT-WITH-NOTES` in rounds 1, 2, 6, 7 and 8, and `FIX-BEFORE-SHIP` in rounds
3, 4, 5 and 9.

Blocking findings per architect round, in order:
**3, 3, 2, 2, 3, 1, 1, 2, 2**. The series alone does not distinguish latent
defects, incomplete fixes, and regressions introduced by fixes.

### Mechanism 1 — repeated full-diff review costs time

The architect prompt requires the whole feature diff and keeps no prior-round
finding ledger. This proves repeated reading cost. It does not prove that
stochastic resampling caused the late findings.

Round 8's A2 inherited its bad ordering from `main`, but the branch modified
the same lock call while preserving that ordering. The revised attribution rule
allows a blocker when the diff introduces the defect or materially changes its
faulty control flow or authority boundary. Mere reachability is not enough.

### Rejected mechanism — trigger category decides severity

The original diagnosis treated infrastructure faults and self-repairing crash
windows as notes by definition. That rule is unsafe for an unattended pipeline:
crashes, retries, stale artifacts, and archive collisions are operating
conditions. Severity depends on whether another actor can consume invalid
durable authority before recovery completes.

The revised rubric requires a concrete failure path and judges its impact and
recovery. It does not demote a finding solely because its trigger is a
filesystem failure or crash.

### Landed mechanism 3 — the architect was unappealable

ADR 0015 and `buildPrCreationPlan` originally allowed only a PM override. The
symmetric override now opens a draft PR when exactly one guardian blocks and
the other is favorable. Two blocking guardians still close the gate.

This change supplies an operator escape valve. It does not create an automatic
review loop or automatic success after a round count.

### Mechanism 4 — the review cache cannot remember a block

`PersistedReviewPhase` (`src/run-state.ts:85-89`) holds `sanity`, `architect`
and `pm`. `PersistedReviewResult` is `{ headSha, verdict }` where `verdict` is
constrained to `"SHIP" | "ACCEPT-WITH-NOTES"`, and `sanitizeReviewResult`
(`:93-104`) drops anything else. ADR 0015 says this out loud: "Unfavorable and
infrastructure outcomes are never cached."

So the one structure that could have carried a ledger is defined to discard
exactly the rounds a ledger is for. The write site is fine — `saveReviewPhase`
at `src/ship-gate.ts:775` runs on every round regardless of verdict — but there
is no field for a finding, no field for the SHA an unfavorable round examined,
and no round counter. Reconstructing PRD 2's nine-round run required `git log` over the
guardian artifact history. The pipeline itself
knows nothing about round 7 when it runs round 8.

### Contributing factor — the citable corpus is written by the branch under review

Principle 3 requires every finding to cite "a specific section in
ARCHITECTURE.md, CONVENTIONS.md, or an ADR." Neither `docs/ARCHITECTURE.md` nor
`docs/CONVENTIONS.md` exists in this repo, so the ADR corpus is the only citable
authority — and PRD 2 authored six of them (`0050`–`0055`) on its own branch.
Round 8's A1 cites "ADR 0055, Decision - Seam 1 section 3"; A2 cites "ADR 0055
section 5". Those sections were written by the slices being reviewed, and
earlier rounds' fixes amended them (ADR 0055 §11's "impossible" claim was
already softened to "narrowed, not closed" by a prior round). The branch is
graded against a rubric it is concurrently editing, so each fix that sharpens an
ADR also sharpens the standard the next round applies to the rest of the diff.

This is not a cause on its own and this PRD does not fix it. It is recorded
because it explains why the finding supply does not deplete even where the code
stops changing.

### Round 9

Round 9 (`2000b34`) returned architect `FIX-BEFORE-SHIP` with two findings.
A1 repeated round 8's still-unfixed accepted-pair recovery defect. A2 combined
a pre-existing non-`ACCEPT` planner-lock bypass with a new gate-refusal
regression from round 8's fix. The PM independently blocked on that authority
bypass. Issue #149 and its regression test fix the non-`ACCEPT` path.

## Original solution proposal — partially rejected and deferred

The status section above controls. This section records the original proposal
for later redesign; it is not ready for AFK implementation.

Four changes attack separate mechanisms. A fifth change makes non-blocking
findings durable.

- **A persisted round ledger.** `PersistedReviewPhase` gains a per-round record:
  the SHA reviewed, the verdict, and each finding's identity, title and
  disposition, written for **every** round including unfavorable ones. This is
  the storage every other change reads.
- **Delta-scoped architect review.** After round 1, the architect is told to
  review `<last-reviewed-sha>..HEAD` and is handed the prior rounds' findings as
  an explicit "already reviewed, do not re-raise" block. Round 1 is unchanged —
  it is the only round that should read the whole branch.
- **Impact and recovery evidence in the rubric.** This landed by hand. A
  blocking finding states a concrete failure path, its impact, and whether
  built-in recovery completes before another actor can consume invalid state.
- **An escape valve: a round cap, plus a symmetric override.** The symmetric
  override landed by hand. The automatic cap is deferred. The original proposal
  would open a draft PR after a bounded number of unfavorable rounds; that
  automatic-success rule is not approved.
- **Durable non-blocking findings.** Every note that ships unfixed is filed,
  once, with a stable identity, so it is neither re-raised as new nor forgotten.

## User Stories

1. As a maintainer, I want every guardian round's SHA, verdict and findings
   persisted in the run state, so that the pipeline — and an operator reading a
   run summary — can see the round-over-round history without reconstructing it
   from git.
2. As a maintainer, I want the architect's second and later rounds scoped to the
   commits added since the last reviewed SHA, so that a fix round is reviewed in
   minutes against what changed instead of resampling 19k lines.
3. As a maintainer, I want the architect handed the findings earlier rounds
   already accepted, so that an accepted decision stays accepted and the round's
   attention goes to the fix.
4. As a maintainer, I want a blocking finding to state its concrete failure
   path, impact, recovery, and diff attribution, so that severity follows the
   shipped risk rather than the trigger category.
5. As a run operator, I want an unattended run to stop after a bounded number of
   unfavorable architect rounds, file the unresolved findings as issues, and open
   the draft PR with them recorded, so that a non-converging gate ends in a
   reviewable PR instead of an unbounded loop.
6. As a run operator present at the console, I want to override an architect-only
   block the same way I can already override a PM-only one, so that the escape
   valve does not require waiting out the cap.
7. As a maintainer, I want every non-blocking note that ships unfixed filed
   exactly once with a stable identity, so that a note is neither lost nor
   re-raised as a fresh finding next round.

## Implementation Decisions

- **Original cap proposal (not approved): the round cap is the primary escape
  valve; the symmetric override is the
  secondary one.** A flag needs an operator at the console, and AFK's premise is
  unattended running — the nine rounds under discussion all ran unattended and
  no flag was there to be passed. A cap ends the loop without a human. The
  override is still worth building because it is a one-line change to an existing
  branch in `buildPrCreationPlan` and it removes the asymmetry ADR 0015
  introduced; making it symmetric costs almost nothing next to leaving a
  documented one-sided veto in place. Both live in one slice because they share
  the same PR-body, override-note and exit-signal plumbing.
- **Original cap default (not approved): 3**, matching ADR 0014's three-round implementation cap
  and ADR 0015's "three-round implementation cap … unchanged". A gate that
  cannot converge in three architect rounds is not going to converge in eight;
  the evidence is that its finding rate does not fall. It is configurable, and
  the flag name is the implementer's call.
- **Original success rule (not approved): a capped run is successful, like an
  override.** ADR 0015's 2026-08-22
  amendment already carves out the override from the unsuccessful-exit rule on
  the grounds that the recorded note is the operator's acknowledgement. A
  cap-cleared PR carries the same recorded acknowledgement plus filed issues, so
  it takes the same treatment. This must be stated in the amendment, not left to
  inference.
- **Original delta-only rule (not approved): scoping starts at round 2.** Round 1 reads `main...HEAD` exactly as
  today. The ledger's absence *is* the signal that this is round 1, so no extra
  flag is needed.
- **The ledger keys findings by a stable identity the reviewer supplies**, not by
  title text — round titles are prose and change wording between rounds ("A1.
  Accepted-pair recovery can be skipped" vs. an earlier phrasing of the same
  defect). What that identity looks like is a design question for the ADR; the
  requirement is that the same defect raised twice collides.
- **A finding must be attributable to the diff under review.** Delta scoping
  enforces this mechanically for rounds 2+, but round 1 reads the whole branch
  and round 8's A2 shows why attribution needs judgment: `main` introduced the
  bad ordering, while the branch changed the same authority boundary and
  preserved it. The rubric therefore also states in prose that the diff must
  introduce the defect or materially change its faulty control flow or
  authority boundary. Unchanged base behavior is a note, not a ship blocker.
- **Impact and recovery replace the proposed reachability floor.** Trigger
  category and frequency do not decide severity. A blocker must show that its
  failure path causes durable or user-visible harm before recovery restores a
  safe state.
- **The stale `agents/architect-review.md` persona was removed by hand.** It was
  a vendored Rumo Fisio consumer persona that named `clinic_id`, RLS, and
  `safeAction`; nothing in `src/` read it. The file that drives this repo's
  self-run gate remains `prompts/architect-review.md`.
- **This needs an ADR.** Any future convergence decision — review scope, impact
  evidence, a bounded round count, and a durable findings ledger — is expensive
  to reverse and needs an ADR. `0056` is the next free number across current
  repository history as of 2026-08-31; re-check it when deferred work starts.
  The symmetric override already amends ADR 0015 in place. Future work amends
  ADR 0015 where it changes the never-cache-unfavorable rule or exit signal,
  and cites ADR 0014 (round-cap precedent) and ADR 0048 (findings name their
  remedy) as precedent without amending them. ADR 0033 (ship-gate extraction) is
  the module boundary the change lands inside and is unaffected. Nothing is
  superseded.

## Testing Decisions

- Per AGENTS.md's "where a new assertion goes" ladder, **none of this needs a new
  spawned pipeline scenario.** The ledger's shape and the sanitizer's tolerance
  of an unfavorable round are unit tests on `src/run-state.ts`. The scope and
  ledger interpolation is a unit test on the rendered prompt string. The cap and
  the symmetric override are unit tests on `buildPrCreationPlan` and on the
  round-count decision — that function is already pure and already unit-tested.
- The one case worth an `it` on an existing spawned scenario is re-entry: a
  second review round on an unchanged-but-for-the-fix branch must read the ledger
  the first round wrote. If a `ship-gate` scenario already spawns two rounds,
  hang the assertion there rather than adding a spawn.
- **Do not invent a mechanical test for rubric judgment.** Tests cover the
  symmetric override and issue #149. A later structured finding schema needs
  its own disposition tests only after that schema is approved.
- **Prove a note is filed exactly once across rounds**, not once per round. The
  `archivedScopeEscalations` note rode two consecutive rounds unaddressed; the
  regression to guard is duplicate filing when the same note reappears.
- A malformed or partial ledger must degrade to a full-scope round-1 review,
  never block resumption — the same rule
  `sanitizeReviewPhase` already follows for the verdict cache.

## Out of Scope

- **Re-reviewing or unblocking `afk-v2-routing-adjudication`.** That PRD's fate
  is a separate operator decision. This PRD changes the gate; whether PRD 2 is
  re-run under the new gate, capped, or shipped by override is not decided here.
- **The PM rubric.** `prompts/pm-review.md` already has ADR 0015's scope
  awareness and is not the blocking side of the loop. Only slice 05 (durable
  notes) touches the PM path, and only its notes, not its verdict rules.
- **Other `agents/*.md` files.** The stale architect persona removal does not
  authorize changes to another consumer persona.
- **Fixing the self-referential citation problem** (the contributing factor
  above). A rule about citing ADRs the branch itself authored is a real gap, but
  it is a rubric question tangled with how this repo writes ADRs during a PRD,
  and bundling it would widen the blast radius of a change whose whole purpose is
  to make the gate terminate. File it.
- **Any change to the pre-ship sanity gate**, the QA evaluator, or the
  implementation-round cap. The loop under discussion is entirely post-merge.

## Further Notes

Use PRD 3 as the next measurement. Record each guardian invocation's reviewed
SHA, verdict, findings, fix commit, and elapsed time. After three blocked
invocations, stop re-entry and request a human decision; do not convert the
blocked result to success. Revisit this deferred PRD with that evidence before
PRD 4 starts.
