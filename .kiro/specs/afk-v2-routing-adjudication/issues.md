# AFK v2 Routing and Adjudication - Slice Index

**Parent PRD:** #70 - see `prd.md` in this directory.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #80 | Scope escalation routes to contract revision | AFK | - | US-1, US-2, US-13 |
| 02 | #81 | Impasse parks the slice, the run continues | AFK | - | US-3, US-6, US-10, US-15, US-16 |
| 03 | #89 | A human decision resumes the parked slice | AFK | #81 | US-4, US-7, US-8, US-9 |
| 04 | #82 | Stuck diagnosis assembled by code | AFK | - | US-11, US-12 |
| 05 | #94 | Babysit courier (manual follow-up after #89) | HITL | #89 | US-5, US-14 (deferred) |

## Moved out of this PRD

Slice 06 (#129, `afk adopt`) and its user story US-17 were excised on
2026-08-31 and now live in `.kiro/specs/afk-v2-run-state-lock-and-adoption/`.
The operator split them out after `afk adopt` carried a blocking guardian
finding in three consecutive gate rounds; the last one (architect A1) requires
a cross-process lock shared by every run-state writer, which is a
persistence-layer change and not a routing-and-adjudication one. This PRD no
longer claims that slice, and the `adopt` code is not in its branch.
