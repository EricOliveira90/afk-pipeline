# PRD: The guardian review converges

**GH issue:** TBD (parent). Every slice issue is TBD — see `issues.md`.
**Parent design:** none. This PRD is about the review gate itself, not a
`docs/specs/afk-v2-plan.md` item.
**Amends:** `docs/adr/0015-guardian-review-failure-classes-and-overrides.md`
**Written:** 2026-08-31, after PRD `afk-v2-routing-adjudication` spent eight
post-implementation guardian rounds without converging.

## Problem Statement

The post-implementation guardian gate has no mechanism that makes it end. It
re-reads the whole feature branch every round, keeps no record of what it
already accepted, has a rubric under which almost any code can be blocked, and
gives the architect a veto no operator and no round count can clear. Those four
properties compose into positive feedback: each round's fix is new error-handling
code, error handling is the highest-yield blocking class, and the next round
reads it fresh with the previous round's accepted findings forgotten.

`afk-v2-routing-adjudication` is the demonstration. It has twelve committed
guardian-review artifact pairs under
`.kiro/specs/afk-v2-routing-adjudication/`; the last eight are the current run's
rounds 1–8 (round 1 at `076540c`, round 6 at `d80fc61`, round 8 at `274f859`).
Every one of the eight returned `FIX-BEFORE-SHIP` from the architect. The PM
returned `ACCEPT-WITH-NOTES` with all four selected slices "Delivered" in rounds
6, 7 and 8, and `FIX-BEFORE-SHIP` in 3, 4 and 5.

Blocking findings per architect round, in order: **3, 3, 2, 2, 3, 1, 1, 2**. A
convergent process runs out of findings. This one went back up.

### Mechanism 1 — the review resamples the entire diff every round

`prompts/architect-review.md` "Required reading" scopes the read to "The diff of
the feature branch against the base branch" — 107 files, +19,398 lines — and
nothing in the prompt, the state file, or the review artifact tells round N
what rounds 1..N-1 examined and accepted. `renderPrompt("architect-review", …)`
in `src/ship-gate.ts:519` passes exactly two variables: `SPECS_DIR` and
`RELEVANT_FILES`. There is no scope variable and no ledger variable.

**Decisive evidence.** Round 8's finding A2 blocks on `negotiateAttempt` in
`src/orchestrator.ts` calling `artifacts.lockContract()` before
`lockRefusedByGate()`. That ordering is not in the feature branch's diff at all.
It arrived on `main` in commit `32df84b` ("feat(wave): detect migration prefix
collisions at contract-lock", 2026-08-22) and is present on `main` today at
`src/orchestrator.ts:2284` and `:2291` — nine days and eight rounds before the
round that blocked on it. A review scoped to "the diff against the base branch"
should not have been able to reach it, seven rounds reading the same diff did
not raise it, and the eighth blocked ship on it.

That is the resampling signature in its clearest form: the finding stream is
governed by which region of a 19k-line diff the sampler happened to walk, not by
what the previous round left unfixed.

### Mechanism 2 — the rubric has no reachability floor

`prompts/architect-review.md` principle 2 reads, verbatim: "FIX-BEFORE-SHIP is
for coupling, broken abstractions, missing error handling, security gaps."
"Missing error handling" is an unqualified blocking class. Nothing in the prompt
asks whether the missing handling is reachable.

Round 8 blocks on two findings that concede their own unreachability:

- **A1** — "An archive collision or filesystem write failure can therefore leave
  the generator's unauthorized lock bytes on disk." The trigger is a filesystem
  write failing mid-sequence.
- **A2** — "A process stop between those calls leaves an authoritative `LOCKED`
  contract whose migration/run-specific gate never passed. **A later run can
  repair it**, but until then disk asserts the exact invariant ADR 0055 says
  must not be written."

Both are faithful readings of the rubric as written. Under principle 2 there is
no verdict available to a reviewer who finds a self-repairing two-statement crash
window other than the one it returned.

### Mechanism 3 — the architect is unappealable

`buildPrCreationPlan` in `src/ship-gate.ts:269-318`:

```ts
const overridden =
  args.openPrOnOverride && architectOk && !pmOk && args.pm === "FIX-BEFORE-SHIP";
const open = (architectOk && pmOk) || overridden;
```

`architectOk` is a conjunct of both terms. `--open-pr-on-override` cannot clear
an architect block; ADR 0015 states the asymmetry deliberately ("only when the
architect verdict is favorable"). There is also no round counter anywhere in
`src/ship-gate.ts` — the only occurrence of "round" in the file is a comment.
The gate has an unappealable veto and no clock.

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
and no round counter. Reconstructing PRD 2's eight rounds for this document
required `git log` over twelve commits of a docs artifact. The pipeline itself
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

### Round 9 — PLACEHOLDER

> **TBD (round 9).** A ninth round of `afk-v2-routing-adjudication` was running
> in parallel with the writing of this PRD and is not reflected above. Fill in
> its architect verdict, its blocking-finding count, and whether any finding
> re-raises one from rounds 1–8. A round-9 outcome of `FIX-BEFORE-SHIP` with a
> non-zero finding count strengthens every claim here; a `SHIP` does not
> invalidate them (nine rounds to converge on four slices is the same defect at
> a smaller magnitude), but it should be recorded honestly next to them.

## Solution

Four changes, each attacking one mechanism, plus one that makes the notes the
other three produce durable.

- **A persisted round ledger.** `PersistedReviewPhase` gains a per-round record:
  the SHA reviewed, the verdict, and each finding's identity, title and
  disposition, written for **every** round including unfavorable ones. This is
  the storage every other change reads.
- **Delta-scoped architect review.** After round 1, the architect is told to
  review `<last-reviewed-sha>..HEAD` and is handed the prior rounds' findings as
  an explicit "already reviewed, do not re-raise" block. Round 1 is unchanged —
  it is the only round that should read the whole branch.
- **A reachability floor in the rubric.** A blocking finding must name a trigger
  reachable in normal operation. A finding whose only trigger is an infrastructure
  fault, or a crash window whose damage the next run repairs, is a note.
- **An escape valve: a round cap, plus a symmetric override.** After a bounded
  number of unfavorable architect rounds, unresolved findings are filed as
  issues and the draft PR opens with them recorded. `--open-pr-on-override` is
  extended to cover an architect-only block so an attended run does not have to
  burn rounds to reach the cap.
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
4. As a maintainer, I want a blocking finding to name a trigger reachable in
   normal operation, so that an infrastructure fault or a self-repairing crash
   window becomes a note rather than a ship blocker.
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

- **The round cap is the primary escape valve; the symmetric override is the
  secondary one.** A flag needs an operator at the console, and AFK's premise is
  unattended running — the eight rounds under discussion all ran unattended and
  no flag was there to be passed. A cap ends the loop without a human. The
  override is still worth building because it is a one-line change to an existing
  branch in `buildPrCreationPlan` and it removes the asymmetry ADR 0015
  introduced; making it symmetric costs almost nothing next to leaving a
  documented one-sided veto in place. Both live in one slice because they share
  the same PR-body, override-note and exit-signal plumbing.
- **The cap default is 3**, matching ADR 0014's three-round implementation cap
  and ADR 0015's "three-round implementation cap … unchanged". A gate that
  cannot converge in three architect rounds is not going to converge in eight;
  the evidence is that its finding rate does not fall. It is configurable, and
  the flag name is the implementer's call.
- **A capped run is successful, like an override.** ADR 0015's 2026-08-22
  amendment already carves out the override from the unsuccessful-exit rule on
  the grounds that the recorded note is the operator's acknowledgement. A
  cap-cleared PR carries the same recorded acknowledgement plus filed issues, so
  it takes the same treatment. This must be stated in the amendment, not left to
  inference.
- **Delta scoping starts at round 2.** Round 1 reads `main...HEAD` exactly as
  today. The ledger's absence *is* the signal that this is round 1, so no extra
  flag is needed.
- **The ledger keys findings by a stable identity the reviewer supplies**, not by
  title text — round titles are prose and change wording between rounds ("A1.
  Accepted-pair recovery can be skipped" vs. an earlier phrasing of the same
  defect). What that identity looks like is a design question for the ADR; the
  requirement is that the same defect raised twice collides.
- **A finding must be attributable to the diff under review.** Delta scoping
  enforces this mechanically for rounds 2+, but round 1 reads the whole branch
  and round 8's A2 shows a reviewer reaching code that is not in it at all. The
  rubric therefore also states it in prose: a blocking finding must be
  introduced or changed by the diff under review, and pre-existing `main`
  behaviour is a note with an issue, not a ship blocker.
- **The reachability floor narrows one clause, not the class.** Principle 2's
  coupling, broken-abstraction and security-gap classes are untouched, and
  "missing error handling" stays blocking when the missing handling is reachable
  in normal operation — a malformed agent response, an absent file, a
  non-zero-exiting command. What moves to notes is the class whose trigger is an
  infrastructure fault (a filesystem write failing mid-sequence, an archive
  collision) or a crash window whose damage a later run repairs. ADR 0048 is the
  precedent: a finding that names its remedy is already the house style, and a
  finding that must name its trigger is the same discipline applied to severity.
- **`agents/architect-review.md` is not in scope and must not be edited.** It is
  a vendored Rumo Fisio consumer persona — it names `docs/ARCHITECTURE.md`,
  `docs/CONVENTIONS.md`, `clinic_id`/RLS and `safeAction`, none of which exist in
  this repo — and nothing in `src/` reads it. The file that drives the self-run
  gate is `prompts/architect-review.md`. Changing the persona would look like
  progress and change nothing.
- **This needs an ADR.** The convergence decision — delta scope, a reachability
  floor, a bounded round count, and a durable findings ledger — is exactly the
  kind of expensive-to-reverse gate policy the ADR corpus exists for, and it
  contradicts two explicit sentences of ADR 0015. Proposed number **0056**;
  `0050`–`0055` are taken on PRD 2's unmerged branch `feat-codex/afk-v2-routing-adjudication`
  and `0029` is already duplicated on `main`, so the implementer must re-derive
  the next free number across all branches rather than trusting this one. It
  **amends ADR 0015** (three sentences: the never-cache-unfavorable rule, the
  architect-favorable precondition on the override, and the exit-signal carve-out)
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
- **Prove the negative for the reachability floor.** A rubric change is only
  verifiable through an agent, so the durable assertion is the mechanical half:
  a finding record that carries no reachable trigger must not be able to reach a
  blocking disposition in the ledger. Do not write a test that asks a live
  reviewer to behave.
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
- **`agents/*.md`.** See Implementation Decisions.
- **Fixing the self-referential citation problem** (the contributing factor
  above). A rule about citing ADRs the branch itself authored is a real gap, but
  it is a rubric question tangled with how this repo writes ADRs during a PRD,
  and bundling it would widen the blast radius of a change whose whole purpose is
  to make the gate terminate. File it.
- **Any change to the pre-ship sanity gate**, the QA evaluator, or the
  implementation-round cap. The loop under discussion is entirely post-merge.

## Further Notes

The delta-scoping slice is worth shipping even if every finding in all eight
rounds turns out to be a genuine blocker the architect was right about. Reading
19,398 lines eight times, and demonstrably missing a round-1 defect in seven of
them, is waste on its own terms; scoping the read to what changed is cheaper and
more accurate at the same time. That is the slice to build first if only one
gets built.

The escape-valve slice is the one that carries risk in the other direction: a
cap can ship a real defect. That risk is bounded by what the cap actually does —
it files the findings and records them in the PR body of a **draft** PR that
still requires a human to merge. The status quo's risk is unbounded in the other
direction, and eight rounds is the measurement.
