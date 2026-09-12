# PRD 9 preserve-work contract renegotiation - Slice Index

**Parent PRD:** #276 (PRD 9). Settled behavior and interface:
`.kiro/specs/afk-preserved-work-renegotiation/prd.md`.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #277 | Crash-recoverable preserve-work renegotiation | AFK | — | Recovery admission, rollback and completion |
| 02 | #278 | Atomic additive split-scope extension | AFK | #277 | Scope validation, holding and completion commit |

## Expected wave structure

- **Wave 1:** #277.
- **Wave 2:** #278, after #277 establishes the only recovery transition and
  its durable lineage record.

## Why the cut falls here

- #277 establishes the single-target write-ahead state machine, immutable
  snapshot, crash reconciliation and fail-closed rollback semantics.
- #278 carries an atomic set of additions inside that same pending attempt and
  commits it only with successful recovery completion. It creates no second
  scope-mutation path.
- Both slices prefer pure state/decision tests and additions to existing
  spawned fixtures, following `AGENTS.md`.

## Launch checklist

- `pnpm lint:tickets 277 278` passed 2026-09-12 with 0 gating findings,
  0 waivers and 0 warnings.
- The native GitHub dependency records #278 as blocked by #277.
- No AFK manifest is created and no AFK run is launched by this authoring
  change.
