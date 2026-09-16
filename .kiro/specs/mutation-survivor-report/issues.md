# Mutation survivor report - Slice Index

**Parent PRD:** #302 (spec of record). Slice issues are #303–#304. Titles are
deliberately short: slice artifact directories and branch names derive from
`slugify(title)` and long titles have hit Windows' 260-char path limit before
(see the guardian convergence PRD's launch notes).

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #303 | Mutation report step | AFK | — | US-1..US-8, US-11, US-12, US-13, US-14, US-15 |
| 02 | #304 | Survivor attribution | AFK | #303 | US-9, US-10 |

## Expected wave structure

- **Wave 1:** #303 (mutation report step) alone.
- **Wave 2:** #304 (survivor attribution), blocked by #303. It extends the
  report assembler #303 introduces.

## Why the cut falls here

- **01 first and alone.** It lands the complete external contract: with the
  flag set, a run either carries a survivor list in run-summary.md and the
  draft PR body or an honest `MUTATION_NOT_RUN` statement. Everything 02
  needs — the parser, the assembler, the outcome classification, the ADR
  with the decisions-file schema — exists after 01. A run with only 01 is
  already demoable and already useful to the draft-PR reviewer.
- **02 is separate** because it is signal quality, not contract: labels
  (new / pre-existing / unattributed / accepted) on an existing list. It
  fails differently from 01 — a labeling bug degrades attribution, never
  the step's honesty — and a rollback of attribution must not roll back the
  report. It also depends on artifacts (committed baseline, decisions file)
  whose creation is operator work that may land later; 01 must not wait on
  that.
- **The baseline campaign and Stage A triage sessions are not slices.** They
  are operator work by intent (see the PRD's Out of Scope); the pipeline
  must never generate the tests that judge its own tests' strength.
- **No slice adds a spawned pipeline scenario.** See the PRD's Testing
  Decisions and AGENTS.md's "where a new assertion goes".
