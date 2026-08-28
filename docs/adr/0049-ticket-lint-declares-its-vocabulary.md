# ADR 0049 — The ticket lint declares its vocabulary instead of parsing it

Date: 2026-08-28
Status: Accepted
Plan item: `docs/specs/afk-v2-plan.md` §3 item 6 (pre-AFK tool, gates PRD 2)

## Context

Two PRD 1 slices lost generator rounds to defects that were sitting in plain
sight in their tickets:

- **#78** had to spend a paragraph saying "there is no fifth `HELD` state",
  because an earlier draft's criteria implied one. A criterion that names a
  state no schema has cannot be satisfied; it can only be negotiated about.
- **#77** shipped the criterion "Every review attempt is archived; later
  attempts never overwrite earlier ones." Archived *where* was left open, the
  answer moved on restart, and #123 was filed for it.

The plan debate narrowed a four-check proposal down to three implementable
checks (§3 item 6). What it did not settle is where the lint gets its idea of
which states, fields and artifacts exist — and that is the whole design, so
this ADR settles it.

## Decision

**The lint's schema knowledge is a hand-maintained declared list
(`ticket-lint-vocabulary.json`), not something parsed out of `src/`.** A name
in an acceptance criterion is acceptable when it is either in that list or
introduced somewhere in the ticket's own prose.

The reason is not convenience. The schemas that a PRD 2–6 ticket references
are mostly the schemas that ticket is *asking someone to build*. There is no
`escalation.md` to parse until #80 merges, no `awaiting-adjudication` phase
until #81 does. A parser over today's source would report every forward
reference as unknown — it would be loudest exactly where the lint is supposed
to be useful, and authors would learn to stop reading it.

So the check the tool actually makes is narrower than "absent from the
referenced schemas" and it is stated honestly in the usage text: **a name a
reader cannot look up anywhere**. Three checks, in the plan's numbering:

| Check | What it decides | Verdict |
|---|---|---|
| 2a | A criterion names an identifier that is in neither the declared list nor the ticket's prose. | Gates |
| 2b | A criterion names something recorded as *not existing* (`held`, the retired `GAPS:` marker, the cut `rejection-cases` field). | Gates in a criterion, warns in prose |
| 3 | A criterion imposes a recording obligation and names no channel for it. | Gates |
| 4 | Summarised field lists ("etc.", "such as", "and so on"). | Warns, never gates |

Check 2b is the arm that earns its keep on this corpus. Once a decision like
"there is no fifth state" is written down anywhere, the lint enforces it
instead of the next author rediscovering it; each entry carries its own note
and a pointer to where the decision was recorded, so the failure message
teaches rather than just refuses.

A **channel is a destination, not a payload.** "Recorded in the review
artifact" does not name a channel; `qa-review.json` and
`.afk/artifacts/<run-slug>/slice-<n>/` do. This is the #123 lesson encoded:
naming the thing you record is not naming where it lands.

**Check 1 (compound predicates that can half-pass) is not built.** Detecting
"X and Y and Z" in free prose is natural-language parsing wearing a lint
costume, and the structural rescue — a mandatory ticket field — was cut in
the debate as a forever-tax on every future author. It is an
**authoring-checklist item**: when writing a ticket, split a criterion that
can half-pass into one criterion per observable fact. The usage text says so,
and a unit test asserts the tool never emits a check-1 finding, so nobody
rebuilds a cut item by accident.

**Waivers are recorded text** in `ticket-lint-waivers.json`, one entry per
waived finding, each with a reason. Two properties keep waive-with-reason
from decaying into the rubber stamp the plan warns about:

- A waiver with a blank reason **fails the lint** and fails the unit suite.
- A waiver carries a `match` substring that must still appear in the flagged
  text. Rewrite the criterion and the waiver stops applying, so the finding
  comes back and the reason gets re-read against the new words.

Unused waivers are reported as notes, so the file cannot quietly rot.

## Consequences

Accepted costs, in the order they will be noticed:

- **The vocabulary file needs maintaining.** Adding a name to it is a claim
  that the name exists in the pipeline today. The file says so, because the
  cheap way to silence any finding is to declare the name — and a vocabulary
  padded to keep the lint quiet is worse than no lint.
- **Check 3 has a known false-positive class**: a recording word used as a
  noun ("the *record* distinguishes impasse from non-convergence") or inside
  a fixture description ("fake mutation tool *reports* a survivor"). Three of
  the twenty PRD 2–6 tickets needed a waiver for exactly this. The alternative
  — narrowing the trigger until only obligations match — is NL parsing again.
  Waivers are the priced answer.
- **A criterion that requires removing something absent trips 2b.** #77's "no
  `GAPS:` marker parsing remains" is a correct criterion about an absent name.
  Waivable; not worth a syntax rule.
- **The lint is not part of `pnpm test`.** It reads issues over the network
  and gates a ticket, not a tree. Its *decisions* are in the suite as unit
  tests (`src/lint-tickets.test.ts`); the run is `pnpm lint:tickets <issue>...`
  before a PRD enters AFK.

Measured on the run this ADR ships with: 20 PRD 2–6 slice tickets, 19 gating
findings (1 × check 2b, 18 × check 3), 2 warnings. 16 criteria were edited,
3 findings waived with reasons. Run against the two grounding tickets, the
lint reproduces both historical defects — #78's `held` and #77's
archived-nowhere criterion.

## Alternatives rejected

- **Parse the schemas from `src/`.** Cannot describe the future the tickets
  are written about (above). Re-open when a PRD's tickets reference only
  schemas that already exist — then the declared list becomes the exception
  list rather than the source.
- **A mandatory ticket-format field** (a declared vocabulary per ticket, or
  the cut `rejection-cases` field). Taxes every future author to serve a lint;
  killed in the debate on Reversibility grounds and not re-proposed here.
- **Gate check 4.** A lexicon gate teaches authors to phrase around the
  lexicon, which is the defect with extra steps.
