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
| 06 | #335 | Recovery completion and replay | AFK | #334 | Completion commit, replay and attempt reporting |

## Expected wave structure

- **Wave 1:** #277 — admission.
- **Wave 2:** #332 — attempt execution.
- **Wave 3:** #333 — verified rollback and the fail-closed hold.
- **Wave 4:** #334 — launch-time reconciliation.
- **Wave 5:** #335 — completion, replay and reporting.
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
planner's re-cut on 2026-09-14; the two governing artifacts are
`.afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01/feedback-r1.md`
(finding F-01, the size refusal) and
`.afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01/planner-escalation.md`
(the re-cut request, option 1). The cut now follows the recovery lineage's own
state machine, one transition per slice:

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
  pre-dispatch fingerprint reread, replay idempotence, and the run-event plus
  run-snapshot fold that makes attempt state visible.
- **#278** carries an atomic set of scope additions inside that same attempt
  and commits it in #335's completion write. It creates no second
  scope-mutation path, which is why it now depends on #335 rather than on #277.

Because verified rollback (#333) and launch-time reconciliation (#334) ship
after admission, #277 also ships a refusal at all three entry points: a live
run cannot create an unresolved attempt it has no way to end. #335 removes that
refusal, so the transition becomes usable exactly when the protocol is whole.
Every slice before it is proven through exported seams and existing
resume/negotiation fixtures.

Slice titles are deliberately short. They are slugified into slice directory
and branch names, and the old 44-character slice 01 title put a round-2 review
artifact 258 characters deep — two characters inside the Windows path limit
that killed the run in #324.

## Launch checklist

- `pnpm lint:tickets 277 278 332 333 334 335` passed 2026-09-14 with 0 gating
  findings, 0 waivers and 0 warnings.
- The native GitHub dependency edges match the Blocked by column: #332←#277,
  #333←#332, #334←#333, #335←#334, #278←#335. The former #278←#277 edge is
  removed.
- Slices 03–06 are new identities, so a rerun cannot pick them up under the
  scope of record persisted by the 2026-09-14 run (a persisted scope may be
  narrowed, never grown). Start the re-cut run from a fresh run-state file and
  pass no `--slices`, or those four slices stay permanently out of scope.
- No AFK manifest is created and no AFK run is launched by this authoring
  change.
