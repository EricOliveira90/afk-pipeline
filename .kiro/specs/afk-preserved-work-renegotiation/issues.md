# PRD 9 preserve-work contract renegotiation - Slice Index

**Parent PRD:** #276 (PRD 9). Settled behavior and interface:
`.kiro/specs/afk-preserved-work-renegotiation/prd.md`.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #277 | Preserve-work recovery admission | AFK | — | Recovery admission and write-ahead lineage |
| 02 | #278 | Atomic additive split-scope extension | AFK | #335 | Scope validation, holding and completion commit |
| 03 | #332 | Recovery attempt execution | AFK | #277 | Attempt execution and negotiation rerun |
| 04 | #333 | Recovery rollback hold | AFK | #332 | Verified rollback and the fail-closed hold |
| 05 | #334 | Recovery launch reconciliation | AFK | #333 | Crash reconciliation before ordinary resume |
| 06 | #335 | Recovery completion and replay | AFK | #334 | Completion commit and replay idempotence |

Deferred successor, deliberately not a slice of this run: **#336** (recovery
reporting and launch wiring) — see "The second cut" below.

## Expected wave structure

- **Wave 1:** #277 — admission.
- **Wave 2:** #332 — attempt execution.
- **Wave 3:** #333 — verified rollback and the fail-closed hold.
- **Wave 4:** #334 — launch-time reconciliation.
- **Wave 5:** #335 — completion and replay.
- **Wave 6:** #278 — the additive scope extension, which commits only with a
  successful recovery completion.

The chain is strictly serial by construction: each successor writes the next
state of the same lineage record, so there is no pair of slices that can be
dispatched in one wave without one of them guessing the other's shape.

## Why the cut falls here

The first cut put admission, rollback and completion in slice 01. Two contract
negotiations refused that boundary as bigger than one generator session
(23 selectable behaviors across 22 files), and the second escalated the
contradiction between the refusal and this document. The maintainer adopted the
planner's re-cut on 2026-09-14. The governing artifacts are committed beside
this file in `escalations/slice-01-2026-09-14/`: `feedback-r1.md` (finding F-01,
the size refusal), `planner-escalation.md` (the re-cut request, whose option 1
is the one taken) and `run-1-outcome.md` (the first run's approved keep-list).
They are copies, because the run directories they came from live under the
gitignored `.afk/`. The cut now follows the recovery lineage's own state
machine, one transition per slice:

- **#277** ships the admission half: the flags, canonical identity, the scope
  fingerprint encoder, read-only eligibility, the immutable accepted-pair
  snapshot, the write-ahead `PENDING` event under the ADR 0056 run-state lock,
  and the persisted append-only lineage shape with its transition validator.
- **#332** runs the attempt the `PENDING` event admitted: live negotiation
  files into immutable attempt history, the two focused clears, and the
  explorer plus planner/evaluator rerun.
- **#333** ends an admitted attempt that failed: verified restore then
  `ROLLED_BACK`, or `ROLLBACK_FAILED` and a fail-closed dispatch hold. It owns
  the single restore-and-verify routine.
- **#334** ends an attempt whose process died, at one pre-resume orchestrator
  call site, by calling that same routine.
- **#335** ends a successful attempt: the completion compare-and-swap, the
  pre-dispatch fingerprint reread, and replay idempotence.
- **#278** carries an atomic set of scope additions inside that same attempt
  and commits it in #335's completion write. It creates no second
  scope-mutation path, which is why it now depends on #335 rather than on #277.

Because verified rollback (#333) and launch-time reconciliation (#334) ship
after admission, #277 also ships a refusal at all three entry points: a live
run cannot create an unresolved attempt it has no way to end. That refusal now
stays in force through the whole of this run and is removed in **#336**, so the
transition becomes reachable from the command line exactly when the protocol is
whole. Every slice in this run is proven through exported seams and existing
resume/negotiation fixtures, never by a live recovery launch.

## The second cut (2026-09-14, slice 06)

The re-cut run escalated slice 06 (#335) at the same 2/2 contract-round cap, for
the same reason one level down. Round 2 narrowed `contract.md` to completion and
replay — three additive exported seams, one optional persisted field, six paths,
an empty "Changes to existing behavior" section — and its Non-goals handed the
reporting surface and the launch wiring to a named follow-up slice. But
`acceptance-manifest.json` was not narrowed with it: it still carried B-06
through B-09 as gated behaviors, still required deleting the `--renegotiate-stale`
refusal that the same pair's P-04 required be preserved, and still named nine
files its own `fileScope` excluded. The round-2 feedback's verdict: *"So the pair
is not narrowed; it is inconsistent."* F-03 was the scope reduction itself, F-02
was B-09 asserting one LOCKED seam where the pair records two, and F-06 was
B-09's unbounded observable about refusal strings anywhere in the repository.

The maintainer applied the standing decision again: keep the core, move the
surplus to a successor under #276. #335 is now completion and replay; **#336**
takes the additive `RunEventPayload` variant, the run-snapshot fold, the
`afk status` surface, the removal of #277's entry-point refusal and the
end-to-end wiring of `--renegotiate-stale` / `--recovery-reason`. The advisory
F-04 question — the `foldEvents` invocation shape the explorer left UNKNOWN in
both rounds — is carried into #336 as its contract's opening question rather than
guessed a third time. The full reasoning is recorded in the decision comment on
#335.

**#336 is not slice 07 of this run, and that is deliberate.** The 2026-09-14 run
persisted a scope of record of slices 01–06. A persisted scope may be narrowed
but never grown, so adding a seventh slice would require starting from a fresh
run-state file — discarding the PASS records for #277, #332, #333 and #334 and
re-running six hours of already-merged work. #336 is therefore a follow-up ticket
under #276, run separately. #278's blocking edge stays `#278 ← #335`: it commits
inside the completion write, and #336 does not sit between them.

Slice titles are deliberately short. They are slugified into slice directory
and branch names, and the old 44-character slice 01 title put a round-2 review
artifact 258 characters deep — two characters inside the Windows path limit
that killed the run in #324.

## Launch checklist

- `pnpm lint:tickets 277 278 332 333 334 335` passed 2026-09-14 with 0 gating
  findings, 0 waivers and 0 warnings. Re-run after the second cut with `336`
  appended.
- The native GitHub dependency edges match the Blocked by column: #332←#277,
  #333←#332, #334←#333, #335←#334, #278←#335, and #336←#335 for the deferred
  successor. The former #278←#277 edge is removed.
- Slices 03–06 are new identities, so a rerun cannot pick them up under the
  scope of record persisted by the 2026-09-14 run (a persisted scope may be
  narrowed, never grown). Start the re-cut run from a fresh run-state file and
  pass no `--slices`, or those four slices stay permanently out of scope.
- **After the second cut, do the opposite:** keep the current run-state file.
  It records #277, #332, #333 and #334 as PASS; a fresh one would re-run them.
  That is why #336 is a deferred successor rather than slice 07 — the same
  narrow-never-grow rule that forced a fresh state file for the first re-cut
  forbids growing this run's scope now.
- No AFK manifest is created and no AFK run is launched by this authoring
  change.
