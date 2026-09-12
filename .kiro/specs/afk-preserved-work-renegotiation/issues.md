# Preserve-work contract renegotiation - Slice Index

**Parent PRD:** #276. Settled behavior and interface:
`.kiro/specs/afk-preserved-work-renegotiation/prd.md`.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #277 | Preserve-work renegotiation | AFK | — | US-1, US-2, US-3, US-4 |
| 02 | #278 | Additive split-scope extension | AFK | #277 | US-5, US-6 |

## Expected wave structure

- **Wave 1:** #277.
- **Wave 2:** #278, after #277 establishes the only recovery transition and
  its durable lineage record.

## Why the cut falls here

- #277 is complete without a re-slice: an operator can refresh planning and
  replace a stale lock while keeping the existing worktree and commits.
- #278 extends that same action to admit newly split slices. It depends on
  #277's command, transaction and lineage instead of creating a second scope
  mutation path.
- Both slices prefer pure state/decision tests and additions to existing
  spawned fixtures, following `AGENTS.md`.

## Launch checklist

- `pnpm lint:tickets 277 278` passed 2026-09-12 with 0 gating findings,
  0 waivers and 0 warnings.
- The native GitHub dependency records #278 as blocked by #277.
- No AFK manifest is created and no AFK run is launched by this authoring
  change.
