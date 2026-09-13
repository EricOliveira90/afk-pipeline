# Generator self-audit gate

Parent PRD: #298. Slice issues: #299, #300, #301.

## Problem Statement

Nothing in the pipeline forces the generator to look at its own finished
candidate a second time before AFK spends a QA evaluator round on it. The
declare-done moment is where agents are least reliable — PRD 1 needed human
hands on 3 of 5 slices, and #120's generator drove 8 commits "to green" over
code that did not compile — yet AFK's only self-review pressure is the
"# Self-audit before commit" prose in the generator prompt templates. Prose is
skippable and unmeasured: no run record can say whether it has ever prevented
a defect. That violates AFK's own enforcement rule — deterministic gates are
the enforcement channel; prompts carry only obligations no gate can enforce —
for an obligation a gate can enforce.

## Solution

Port SwarmForge's two-call audit gate (github.com/unclebob/swarm-forge,
`swarm_handoff.sh`) into the orchestrator as an opt-in, bounded, self-measuring
audit pass. After a candidate passes its required cheap gates and before QA
dispatch, the orchestrator re-dispatches the slice's generator once with an
audit envelope: re-read the locked contract, trace every done-criterion to
code and to test evidence, examine boundaries and failure cases; commit fixes
if the audit finds a gap, otherwise change nothing. The verdict is structural,
never agent-certified: the orchestrator compares exact git tree objects before
and after the invocation.

- Identical tree → `AUDIT_UNCHANGED`; proceed to QA.
- Different tree → `AUDIT_CHANGED`; re-run required cheap gates on the audited
  tree, then proceed to QA.
- Audit invocation dies → `AUDIT_NOT_RUN`; proceed to QA. The gate can add
  scrutiny; it can never block a run by its own failure.

Exactly one audit invocation per QA submission — no audit-of-the-audit, no
generator-round consumption. Outcomes are recorded per candidate and totalled
in the run summary; the `AUDIT_CHANGED` rate is the evidence that later
decides default-on vs deletion. The feature ships behind `--self-audit`,
default off.

## User Stories

1. As an AFK operator, I want the generator's candidate audited before QA
   dispatch, so that obvious contract gaps are caught by the cheap actor
   instead of burning a QA evaluator round.
2. As an AFK operator, I want the audit behind a `--self-audit` flag
   defaulting to off, so that new machinery does not add minutes to the happy
   path of runs that did not opt in.
3. As an AFK operator, I want the audit verdict derived from exact git tree
   comparison, so that no agent can certify its own diligence.
4. As an AFK operator, I want a changed audited tree to re-run the slice's
   required cheap gates before QA, so that an audit "fix" cannot smuggle a
   broken tree past the gates the original candidate passed.
5. As an AFK operator, I want exactly one audit invocation per QA submission,
   so that the gate is bounded by construction and cannot loop.
6. As an AFK operator, I want the audit invocation excluded from the
   generator's round budget, so that opting into more scrutiny never costs a
   slice its repair rounds.
7. As an AFK operator, I want a dead audit invocation recorded as
   `AUDIT_NOT_RUN` with the candidate proceeding to QA, so that the gate's own
   infrastructure failures never block a run.
8. As an AFK operator, I want audit outcomes recorded per candidate in run
   state with run-ID provenance, so that resume treats a completed audit as
   spent and never re-dispatches it.
9. As an AFK operator, I want per-run audit totals and the changed-rate in the
   run summary, so that the default-on decision can be taken on recorded
   evidence rather than argument.
10. As an AFK maintainer, I want the audit rate to report and never gate, so
    that a pressured agent or operator is never taught to game the number.
11. As a generator agent, I want the audit envelope to carry the locked
    contract pair, my handoff artifact, and the candidate's change summary
    under the standard inline budget with stricter-only overrides, so that the
    audit challenge is answerable from cited inputs.
12. As a generator agent, I want the audit envelope to state that an unchanged
    resubmission is a legitimate outcome, so that I am not pressured into
    cosmetic churn to look diligent.
13. As a QA evaluator, I want candidates that survived their author's forced
    re-read, so that my rounds are spent on defects a self-review cannot catch.
14. As a babysitter agent, I want audit outcomes visible in run status
    surfaces, so that I can tell a post-audit gate re-run apart from a stalled
    slice.
15. As an AFK maintainer, I want an ADR in docs/adr/ stating the mechanism,
    its SwarmForge provenance, and the one-invocation bound, so that a future
    audit-rounds proposal meets the recorded killing argument.
16. As an AFK operator, I want the prompt-prose self-audit section superseded
    on dispatch paths where the gate is active, so that one obligation is not
    stated in two places with two enforcement strengths.

## Implementation Decisions

- The audit pass sits between the candidate gate phase and QA dispatch, only
  for candidates that passed required cheap gates.
- The audit is one re-dispatch of the slice's generator in its own worktree —
  not a new agent role. It runs under the existing agent-failure-cause
  taxonomy (ADR 0025); only infrastructure causes retry, and exhaustion lands
  `AUDIT_NOT_RUN`.
- A new audit envelope manifest in the context-envelope layer declares
  objective, non-goals, allowed write scope (the slice worktree only), stop
  conditions, accepted input artifact classes (locked contract pair, handoff,
  change summary), and fixed input order, under the standard 64 KiB inline
  budget with stricter-only overrides.
- Verdict classification is a pure function over (pre-audit tree identity,
  post-audit tree identity, invocation result). Tree identity is the exact git
  tree object, the same identity the gate cache uses.
- `AUDIT_CHANGED` re-runs the required cheap-on-changed-tree gates from the
  gate catalog; a failure there enters the existing bounded repair loop.
- Outcome records join run state at the moment they land (truth-on-exit
  posture) with run-ID provenance, following the existing stale-record rules.
- One flag: `--self-audit`, default off. No per-slice configuration, no rate
  threshold, no second knob.
- An ADR in docs/adr/ states the mechanism, provenance, and bound; CONTEXT.md
  gains the three outcome terms.

## Testing Decisions

- Test external behavior at existing seams; no new spawned pipeline scenario
  (AGENTS.md test-placement ladder).
- Verdict classification and sequencing are unit-tested as pure functions —
  prior art: contract-convergence and guardian-convergence verdict rules.
- Envelope assembly asserts at the context-envelope unit seam — prior art: the
  per-role manifest tests.
- Run-state recording and resume-spent behavior assert at the run-state unit
  seam — prior art: exact-stage-resume tests.
- If an end-to-end assertion proves necessary, add an `it` to an existing
  spawned scenario whose fixture already reaches the candidate-accepted state.

## Out of Scope

- Auditing planner, evaluator, explorer, or guardian outputs.
- Any gate, merge, or dispatch decision keyed on the audit rate.
- The default-on decision and retirement of the prompt-prose self-audit
  section.
- A second audit challenge for changed trees.
- In-session or provider-hook enforcement (consistent with the 2026-08-29
  hook-proposal cut).
- Changes to QA evaluator behavior, inputs, or the sanity command set
  (ADR 0012 untouched).

## Dependencies and Sequencing

No external dependencies. Slice 1 (#299) lands the flag, envelope, dispatch,
and the full verdict classifier with the unchanged-tree path; slices 2 (#300)
and 3 (#301) are both blocked only by #299 and can run in one wave. Source
decision: `.kiro/specs/generator-self-audit-gate/intent.md`. Spec of record:
GH issue #298.
