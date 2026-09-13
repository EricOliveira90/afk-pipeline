# Mutation survivor report

Parent PRD: #302. Slice issues: #303, #304.

## Problem Statement

Every AFK gate ultimately trusts the test suite the generator itself wrote:
the cheap gates run it, the QA evaluator runs it, the pre-ship sanity gate
runs it. The feedback-integrity gate catches deleted tests, but nothing
catches weak ones — tests that execute the changed code and pass for a
plausible wrong implementation. An AI generator under "make it green"
pressure is precisely the actor that produces such tests (#120: 8 commits
driven "to green" over code that did not compile). The human reviewing the
draft PR has no instrument that says where the run's safety net has holes.

## Solution

Ship mutation testing as a report-only ship-gate step behind a
`--mutation-report` flag, default off. The step runs once per run, on the
merged feature branch, concurrently with the guardian reviews, scoped to the
files the run changed (derived from the existing change-summary builder). The
consuming project declares its mutation command and the path of the
machine-readable file that command writes (the standard mutation-testing
report JSON schema emitted by StrykerJS and peers); AFK parses that schema
and never scrapes tool stdout.

The outcome is structural and two-valued: `MUTATION_REPORTED` (survivors,
possibly zero, listed in run-summary.md and the draft PR body) or
`MUTATION_NOT_RUN` (timeout at a flat 30-minute post-guardian bound, tool
failure, or infrastructure death — stated honestly in both places). Neither
outcome can block the ship, fail a gate, or change any verdict. When the repo
carries a committed mutation baseline artifact, survivors split into
new-in-this-run vs pre-existing; a committed triage-decisions file marks
already-adjudicated survivors as accepted instead of re-raising them.

## User Stories

1. As an AFK operator, I want a survivor list in the draft PR body, so that
   my review attention goes first to the places where the run's code can be
   broken without any test noticing.
2. As an AFK operator, I want the step behind `--mutation-report` defaulting
   to off, so that runs that did not opt in pay zero additional cost.
3. As an AFK operator, I want the step to run once per run at the ship gate,
   concurrent with guardian reviews, so that its wall-clock cost hides inside
   the phase that is already the slow tail.
4. As an AFK operator, I want the mutation scope limited to the files the run
   changed, so that cost scales with the diff rather than the repo.
5. As an AFK operator, I want a launch-time refusal when the flag is set but
   no mutation command is declared, so that misconfiguration costs zero
   tokens.
6. As an AFK operator, I want `MUTATION_NOT_RUN` stated honestly with the
   draft PR still opening, so that the step adds scrutiny but never blocks
   delivery.
7. As an AFK maintainer, I want AFK to parse the standard mutation-testing
   JSON schema rather than stdout, so that any conforming tool works and the
   parser is a pure function over fixtures.
8. As an AFK maintainer, I want the step's processes terminated through the
   normal quiesce path at the bound, so that teardown invariants hold
   (ADR 0020/0035).
9. As an AFK operator, I want survivors split into new vs pre-existing when a
   committed baseline exists, so that I judge the run only on the blind spots
   it introduced.
10. As an AFK operator, I want survivors matching a committed triage decision
    labeled accepted, so that an adjudicated survivor is never re-raised
    every run.
11. As an AFK operator, I want the outcome in run state with run-ID
    provenance and totals in run-summary.md, so that escalate-or-delete
    evidence accumulates without manual bookkeeping.
12. As an AFK maintainer, I want the refusals recorded as killing arguments
    in an ADR, so that future proposals to weaponize the number meet the
    recorded "no".
13. As a babysitter agent, I want the step's status visible in run status
    surfaces, so that a ship gate waiting on mutation is distinguishable from
    a stall.
14. As a triage-session human, I want the decisions-file schema in the ADR,
    so that Stage A sessions produce a corpus with one spelling from day one.
15. As an AFK maintainer, I want the staged trust ladder recorded in the ADR
    as direction, so that the process context survives unbuilt.

## Implementation Decisions

- One flag, `--mutation-report`, default off; the 30-minute post-guardian
  bound is flat and not configurable in this PRD.
- Declared command + declared JSON path; mutation-testing-elements schema;
  flag without declaration refuses launch before any agent dispatch.
- Concurrent start with guardians on the merged feature branch; differential
  scope from the change-summary builder, filtered to mutation-eligible
  source files.
- Overrun terminates through the existing quiesce path; a detached post-exit
  process is refused by design.
- Outcome classification and report assembly are pure functions (parse
  result × step exit × deadline; survivors × optional baseline × optional
  decisions file).
- Outcome entries join run state at the moment they land with run-ID
  provenance, under existing truth-on-exit and stale-record rules.
- An ADR records mechanism, SwarmForge/Martin provenance, decisions-file
  schema, trust-ladder direction, and the five refusals.
- Baseline creation, refresh, and module selection are operator work,
  out-of-band, never an AFK slice.

## Testing Decisions

- Unit seams only; no spawned pipeline scenario; no real mutation tool in any
  test.
- Parser and assembler asserted over fixture JSON (malformed file, empty
  survivors, missing baseline, unattributed and accepted labels) — prior
  art: verdict-rule and manifest-parser unit tests.
- Ship-gate sequencing (concurrent start, bounded wait, quiesced
  termination, never-blocks) at the existing ship-gate unit seam — prior
  art: guardian-round and pre-ship sequencing tests.
- Launch-time refusal at the existing preflight/configuration unit seam.

## Out of Scope

- Any blocking gate, threshold, or verdict change keyed on mutation results.
- Survivor remediation, automated or agent-driven; any AFK slice that kills
  mutants.
- Baseline creation, refresh policy, or module selection.
- Trust-ladder stages B and C; eval-pack graduation cases for triage agents.
- Adding a mutation tool to any consuming repo, including this one.
- Per-slice or per-QA-round mutation; mutation in the generator's
  verification command; tool-specific adapters beyond the standard schema.

## Dependencies and Sequencing

No external dependencies. Slice 1 (#303) lands the complete external
contract (flag, refusal, step, outcomes, report in run-summary.md and the
draft PR body, ADR); slice 2 (#304) upgrades the report's signal
(attribution and accepted-decision labels) and is blocked only by #303.
Source decision: `.kiro/specs/mutation-survivor-report/intent.md`. Spec of
record: GH issue #302.
