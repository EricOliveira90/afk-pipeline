# PRD 8 ticket breakdown - Slice Index

**Parent PRD:** #271 (spec of record). One slice, #273. The title is
deliberately short: slice artifact directories and branch names derive from
`slugify(title)` and long titles have hit Windows' 260-char path limit before
(see the guardian convergence PRD's launch notes).

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #273 | Required-input budget | AFK | — | 1–7 (all) |

The ticket's `#269`/`#270` dependency is external and already satisfied
(#269 closed, PR #270 merged: the locked contract pair travels by worktree
reference). It is deliberately **not** encoded in the Blocked by column —
that column is for in-run slice ordering, and an out-of-run issue there
would hold the slice back forever.

## Expected wave structure

- **Wave 1:** #273 alone. Nothing else in the run.

## 1. #273 — PRD8-S1: Enforce the generator required-input budget

### Parent

#271 (PRD 8: Generator required-input budget). This slice follows #269/#270:
the locked contract pair remains transported by worktree reference, but those
required reads no longer count as zero context.

### What to build

Replace the generator's 65,536-byte inline-only assertion with one 98,304-byte
required-input assertion for initial and repair rounds. The total is the
assembled inline prompt plus each distinct materialized artifact the generator
is explicitly required to read in full.

Count the exact UTF-8 artifact content, fail closed when a required artifact is
missing or unreadable, and never count one logical artifact twice. Reserve the
referenced weight before calculating repair-evidence room. Keep project
overrides stricter-only.

Extend prompt-assembly evidence and configuration failures with the inline
weight, referenced weight, required-input total, allowed total, and
per-artifact referenced weights. Preserve the existing by-reference transport
and all required contract, manifest, finding, and repair content. Record the
decision in an ADR that narrows the inline-only interpretation of the earlier
by-reference decisions.

### Acceptance criteria

- [ ] A generator initial round passes when inline prompt bytes plus distinct
  required referenced artifact bytes equal 98,304 and refuses dispatch when
  the total is 98,305.
- [ ] A generator repair round enforces the same total and calculates variable
  repair-evidence room only after reserving fixed inline and required
  referenced bytes.
- [ ] The contract and acceptance manifest carried by worktree reference each
  contribute their exact UTF-8 byte size to the generator total.
- [ ] A required referenced artifact that is missing or unreadable fails
  prompt preparation as `CONFIGURATION` and does not contribute zero bytes.
- [ ] One logical artifact contributes at most once, including when duplicate
  evidence metadata or inline content refers to it.
- [ ] The prompt-assembly run event records inline, referenced, required-input,
  and allowed byte totals plus each required referenced artifact's identifier
  and byte weight.
- [ ] The prompt-preparation `CONFIGURATION` error in `run.log` and
  `run-summary.md` reports those same totals and per-artifact weights; it does
  not silently omit, truncate, or summarize required content.
- [ ] A project override below 98,304 becomes the effective limit; an override
  above 98,304 does not raise the limit.
- [ ] Planner, explorer, evaluator, cleaner, hardener, remediator, and guardian
  budget behavior remains unchanged.
- [ ] Unit tests cover initial and repair rounds, exact-boundary and
  one-byte-over behavior, missing artifacts, de-duplication, diagnostics,
  stricter overrides, and repair-room subtraction without adding a spawned
  pipeline scenario.
- [ ] An ADR defines required-input bytes as a lower bound on mandatory
  starting context, retains by-reference transport, and states that AFK does
  not predict provider tokenization or later agent-chosen reads.

### Blocked by

#269, delivered by #270. Do not implement against the old generator envelope.

## Why one ticket

Accounting, repair-room subtraction, evidence, diagnostics, and the ADR form
one externally observable budget rule. Splitting them would create an
intermediate state where AFK either enforces a total it cannot explain or
reports a total it does not enforce.
