# Mutation survivor report

## Intent

Give the human at the draft PR a deterministic answer to the one question no
existing gate asks: would this run's tests actually notice if the code they
cover were wrong?

Every AFK gate ultimately trusts the test suite the generator itself wrote.
The feedback-integrity gate catches deleted tests; nothing catches weak ones.
Mutation testing is the deterministic detector for that gap: a tool breaks
the code in small, systematic ways (a mutant) and re-runs the tests; a mutant
the tests do not kill is a proven blind spot. This PRD ships mutation as a
report-only ship-gate step — a survivor list attached to the run summary and
the draft PR body — never as a blocking gate.

The posture follows the same governance as the self-audit gate and ADR 0063:
new machinery defaults off, the output reports and never gates, and the
recorded evidence (do survivors point at real defects?) decides whether the
feature earns escalation or deletion. Provenance: Robert C. Martin's
SwarmForge keeps mutation testing as a core constraint even while retracting
heavier harness choreography, and his own remediation guidance — triage
survivors, do not kill them all — is why this PRD refuses a blocking gate and
a kill-rate threshold outright.

## Evidence

- The generator's own tests are the trust root of the whole verification
  chain (cheap gates, QA evaluator, pre-ship suite all run them). #120's
  generator drove 8 commits "to green" over code that did not compile —
  agents optimize the letter of a gate; a green suite proves little about
  assertion strength.
- The feedback-integrity gate detects deleted tests and protected-path edits;
  no mechanism detects tests that pass for a plausible wrong implementation.
- PRD 5's cleaner/hardener roles are deferred pending ROI evidence. A
  report-only survivor list is the ROI instrument for that decision without
  building the role.
- Mutation remediation cost is the known failure mode (public discussion
  between R. C. Martin and T. Ottinger, 2026): killing every survivor forces
  brittle change-detector tests — "scars." A "mutant killed" criterion is
  gameable by exactly the slop it exists to detect, which is why remediation
  stays out of this PRD.
- Wall-clock and rate thresholds teach agents to game the number (ADR 0063,
  slice #78 incident). A kill-rate gate would repeat that mistake.

## Decision

1. One flag: `--mutation-report`, default off. No per-slice configuration, no
   rate threshold, no second knob.
2. The consuming project declares its mutation command and the path of the
   machine-readable report that command writes. The report must conform to
   the standard mutation-testing report JSON schema (the
   mutation-testing-elements schema emitted by StrykerJS and peers). AFK
   parses that schema; it never scrapes tool stdout.
3. With `--mutation-report` set and no declared mutation command, the launch
   is refused as a configuration error before any agent is dispatched (fail
   closed, zero tokens).
4. The mutation step runs once per run, in the ship-gate phase, on the merged
   feature branch, concurrently with the guardian reviews. It never runs per
   slice, per QA round, or inside the generator's verification command.
5. Differential scope: the mutation command is invoked for the files the run
   changed, derived from the same change-summary builder the pipeline already
   uses (one builder over base and tip), filtered to mutation-eligible source
   files.
6. Bounded wait: after guardian reviews complete, the ship gate waits at most
   30 minutes (flat, not configurable in this PRD) for the mutation step. A
   step that has not produced its report by then is terminated through the
   normal quiesce path. A detached post-exit process is refused by design —
   it would violate the teardown quiescence invariants (ADR 0020/0035).
7. Outcomes are structural, two-valued:
   - `MUTATION_REPORTED` — the report parsed; survivors (possibly zero) are
     listed in run-summary.md and in the draft PR body.
   - `MUTATION_NOT_RUN` — refusal-free honesty for timeout, tool failure, or
     infrastructure death; the run summary and PR body say so and why.
   Neither outcome can block the ship, fail a gate, or change any verdict.
8. Attribution: when the repo contains a committed mutation baseline artifact
   (the tool's incremental file), the report splits survivors into
   new-in-this-run and pre-existing. Without a baseline, survivors are
   labeled unattributed. Creating and refreshing the baseline is operator
   work, out-of-band, module by module — never an AFK slice.
9. Triage decisions: a committed decisions file (schema recorded in the ADR:
   mutant identity, consequence, containment, KILL or ACCEPT, one-line
   reasoning) marks survivors already adjudicated. The report labels matching
   survivors as accepted instead of re-raising them. The staged trust ladder
   for triage (human decides → agent proposes/human ratifies → per-category
   autonomy measured against the recorded corpus via the agent-eval harness)
   is process, recorded in the ADR as direction, not built here.
10. Recorded refusals, as killing arguments in the ADR: no blocking mutation
    gate; no kill-rate or score threshold anywhere; no mutation in the
    generator's verification command; no hardener role; no automated
    survivor-killing (the "mutant killed" criterion is gameable and the
    writer of a killing test must never be its accepter).

## Scope

- The `--mutation-report` flag and its launch-time configuration check.
- The declared mutation command / report-path contract and the schema parser.
- Ship-gate sequencing: concurrent start with guardians, bounded wait,
  quiesced termination, outcome classification.
- Report assembly into run-summary.md and the draft PR body, with baseline
  attribution and accepted-decision marking.
- Run-state recording of the outcome with run-ID provenance.
- An ADR recording the mechanism, the SwarmForge/Martin provenance, the
  decisions-file schema, the trust-ladder direction, and the refusals.

## Out of scope

- Any blocking gate, threshold, or verdict change keyed on mutation results.
- Survivor remediation, automated or agent-driven, and any AFK slice that
  kills mutants.
- Baseline creation, refresh policy, or module selection (operator work).
- The triage trust ladder's stages B and C, and eval-pack graduation cases.
- Adding a mutation tool to any consuming repo, including this one (the
  feature reads a declared command; declaring it is the repo's decision).
- Per-slice or per-QA-round mutation, and provider/tool-specific adapters
  beyond the standard report schema.

## Verification seam

Unit seams only; no spawned pipeline scenario and no real mutation tool in
tests. The schema parser and the report assembler (survivor list + optional
baseline + optional decisions file → report sections and outcome) are pure
functions asserted over fixture JSON, including malformed-report,
missing-baseline, and accepted-survivor cases. Ship-gate sequencing (start
with guardians, bounded wait, `MUTATION_NOT_RUN` on timeout, never-blocks) is
asserted at the existing ship-gate unit seam. The launch-time configuration
refusal is asserted at the existing preflight/configuration unit seam.
