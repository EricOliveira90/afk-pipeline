# AFK v2 Acceptance and Scope Gates - Slice Index

**Parent PRD:** #72 - see `prd.md` in this directory for the settled
decisions D1-D21 and the file-scope map.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #84 | File-scope gate | AFK | — | US-1, US-3, US-5, US-6, US-22, US-24 |
| 02 | #85 | Behavior coverage gate | AFK | #84 | US-1, US-2, US-3 |
| 03 | #91 | Candidate evaluator isolation | AFK | #84, #85 | US-4, US-7, US-8, US-10, US-11, US-12, US-18, US-19, US-20 |
| 04 | #96 | Final evaluation and reuse | AFK | #91 | US-13, US-14, US-18 |
| 05 | #86 | Test cost split and caching | AFK | #84 | US-16, US-17, US-21, US-22, US-24 |
| 06 | #132 | Merge resolution round | AFK | #85 | US-23 |
| 07 | #193 | Feedback integrity and gate-scope revisions | AFK | #84 | US-5, US-6, US-22, US-24 |

Stories 9 (probe-as-evidence transport) and 15 (final-evaluator code
attribution) are deferred by the plan; D14 in `prd.md` records how far
slice 03 goes without the transport.

Titles are deliberately short. Branch and artifact directory names derive
from `slugify(title)`, and the guardian-convergence run died on Windows'
260-char path limit with longer ones. The full behavior statements live in
the GH issue titles and bodies, which the pipeline reads.

## Expected wave structure — and why it is serial

- **Wave 1:** #84 alone.
- **Wave 2:** #85, #86 and #193, all blocked by #84.
- **Wave 3:** #91 (blocked by #84 and #85) and #132 (blocked by #85).
- **Wave 4:** #96, blocked by #91.

Every slice's contract must declare `src/orchestrator.ts`. That shared
declaration is what unions a wave's slices into **one lane**
(`partitionLanes` step 1, `src/lanes.ts`); across waves the DAG already
serialises. Contract negotiation runs in parallel inside a wave; generation
and merges are serial for the whole PRD. Plan for that.

The mechanism is the declaration, not `afk.config.json`. Its
`orchestrator-core` resource key is declared but **nothing reads
`afk.config.json` yet** — slice 01 adds the first reader, for `gatePolicy`
only — and `laneResourceGroups` recognises exactly one resource,
`migrations` (ADR 0027), which this PRD reserves none of. A slice whose
planner omits `src/orchestrator.ts` therefore gets its own lane and races
its siblings on every shared module below. Treat the declaration as a hard
requirement on each slice's manifest.

The one lane is what makes the shared files safe. A lane-mate's
worktree is created from the feature tip after its predecessor merged, so
the overlapping edits stack rather than conflict:

- `src/gate-policy.ts` — 01 creates it, 02 adds `acceptance`, 05 adds `cost`.
- `src/gate-runner.ts` — 02 adds the `acceptance` stage, 05 adds caching
  and the `environmentSensitive` attribute.
- `src/change-summary.ts` — 03 creates it, 04 adds the baseline-to-final
  variant.
- `src/run-state.ts` — one persisted record each from 01, 03, 04, 05, 06.
- `src/run-events.ts` — one event family each from 01, 03, 04, 05, 06.
- `src/logger.ts` — each slice's own `run-summary.md` section (01, 03, 04,
  05, 06).
- `src/context-envelope.ts` — 03 and 04 add manifest entries, 06 adds the
  repair envelope's conflict data block.
- `prompts/generator-repair.md` — 01 adds `GATE-SCOPE`, 06 adds D15's data
  block.
- `ARCHITECTURE.md` — each slice adds only its own module rows.
- `src/candidate-gate-phase.ts` — 05 sequences it, 03 reads it, 06 re-runs
  it on a resolved tree.

The full matrix is the file-scope map in `prd.md`. Do not launch PRD 4
concurrently with another PRD: plan §3c policy 5's file-overlap condition
fails against anything touching the orchestrator or the gate modules.

## Why the cut falls here

- **01 first, and everything else behind it.** Slice 01 creates
  `src/gate-policy.ts`, and 02 and 05 each add a key to it (D1). The
  tickets previously called both independent; three slices racing to
  create one module is the contract impasse that cost the
  guardian-convergence run a slice dispatch. 01 also stands alone: the
  scope gate plus the feedback-integrity guard is the closing of #183 and
  is worth shipping even if nothing after it lands.
- **02 is separate from 01** because it is a different seam and a
  different failure. 01 compares paths; 02 runs a command per behavior ID
  and counts matches (D8). Neither reads the other's evidence.
- **03 after 01 and 02** because the candidate evaluator's entry condition
  is "base, acceptance and scope gates all green" — it cannot be proved
  without both gates existing, and a red gate must consume no evaluator
  round (D19).
- **04 after 03** because exact-tree reuse compares the final checkpoint
  against 03's `approved-baseline.json` (D10, D20), and 04's final change
  summary extends the module 03 creates (D11).
- **05 separate from 01** even though both serve plan item 17: 01 owns
  deleted tests and protected paths, 05 owns project-declared skip
  detection (plan §3d item 17 places them that way), and 05 additionally
  carries the cost policy, the cache and the derived verification command,
  which have nothing to do with tamper detection. 05 consumes 01's waiver
  record rather than inventing a second waiver format.
- **06 after 02** because a resolved tree must re-pass the slice's
  behavior bindings, which is 02's gate. It is deliberately not merged
  into any other slice: it runs only on a real textual conflict, and a
  rollback of the resolution round must not roll back a gate.
- **No slice adds a spawned pipeline scenario** without a comment saying
  why no existing fixture reaches the state. See `prd.md`'s Testing
  decisions and AGENTS.md.

## Launch checklist

- `pnpm lint:tickets 84 85 86 91 96 132 193` — exits 0 with zero warnings,
  re-run 2026-09-08 on `integration/pre-prd4`. It prints three "waiver matched nothing" notes for
  #92, #93 and #95 — stale waivers from earlier PRDs. They are not these
  tickets' and they do not gate.
- `Blocked by` uses issue numbers, the DAG parser's key
  (`src/issues-parser.ts`), not slice numbers. The four waves above were
  re-derived from that parser against this table.
- ADR 0060 is merged and is cited by #84; #183 is closed against it.
- `afk.json` here selects all seven slices. No slice adds a migration, so
  no prefix is reserved and `migrationPrefixes` stays empty.
- `afk.json` also carries one pre-recorded D5 waiver, for
  `afk.config.json`. Slices 02 and 05 add keys to the `gatePolicy` object
  slice 01 declares protected, so the contract requires the very edit the
  integrity gate refuses. It is inert during a single launch — the
  orchestrator process does not adopt slice 01's gate mid-run, and
  `parseAfkManifest` does not yet parse the key at all (D5 makes extending it
  slice 01's job) — and load-bearing the moment a babysitter relaunches on a
  rebuilt binary, which is why it is recorded now rather than discovered at a
  park. Its `riskClass` is the literal `gate-policy`, the string D5 pins for
  #84 to declare.
- **Precondition 3 was waived in writing on 2026-09-07** and its evidence
  re-earned for the Claude backend on 2026-09-08; see `prd.md`'s Launch
  preconditions. #135 stays OPEN.
- Preconditions 4 and 6 are the operator's to confirm at launch: no
  concurrent run, and the explicit verification command. Preconditions 1, 2
  and 5 were verified on `integration/pre-prd4`.
