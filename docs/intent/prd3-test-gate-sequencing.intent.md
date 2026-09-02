# Intent: PRD 3 test-gate sequencing as early PRD 4 delivery

Author: founder (via Codex session, 2026-09-02). Status: approved for
implementation before PRD 3 slices #90, #95, and #99.
Source: PRD 3 run evidence plus `docs/specs/afk-v2-agent-roles.md` M6 and
`docs/specs/afk-v2-plan.md` PRD 4.

## Problem

The current slice loop runs the repository's full test suite before candidate
QA. Candidate QA can run the same suite again when it does not use the
orchestrator's exact-tree authorization. Each QA repair round can therefore pay
for one or two full suites before the candidate evaluator reports a behavior
finding.

PRD 3 slice #83 exposed the cost. One full suite took 1,137.9 seconds. A later
base gate also stopped below the disk floor before candidate QA could review
the final repairs.

## Approved outcome

Use this slice sequence:

1. Run typecheck and the cheap or related tests on the candidate tree.
2. Run candidate QA only after those checks pass.
3. Run the full slice suite only after candidate QA accepts.
4. Return a full-suite failure to the next bounded repair round.
5. Keep the aggregate full suite before guardian review and draft-PR creation.

Candidate QA must use orchestrator-owned exact-tree authorization as evidence.
The authorization identifies the candidate tree, not the `HEAD` commit. The
evaluator cites a valid authorization and does not compare its tree ID with
`git rev-parse HEAD`.

## Plan placement

This change delivers the minimum useful part of PRD 4's M6 test-cost policy
before the remaining PRD 3 slices start. Record it as early PRD 4 delivery.
This changes delivery order, not the v2 architecture or quality bar.

PRD 4 still owns the complete system:

- The policy-owned gate catalog and automatic `test:related` selection.
- The derived generator verification command.
- Mechanical behavior-ID acceptance coverage.
- Exact-tree gate-result reuse and cache policy.
- Structured prerequisites, advisory attributes, and project-level policy.

## Affected users and systems

AFK run operators, generators, candidate evaluators, the per-slice gate runner,
the aggregate pre-ship gate, QA authorization evidence, and PRD 4 planning.

## Constraints and non-goals

- Preserve the full slice suite and aggregate pre-ship suite.
- Fail closed when the candidate tree differs from the authorized tree.
- Rerun candidate QA after a repair changes the candidate tree.
- Keep the implementation provider-independent.
- Do not add a separate QA behavior ledger. PRD 4 owns mechanical behavior-ID
  coverage.
- Use an 8 GB launch floor for the remaining PRD 3 runs. Do not change the
  global 5 GB default in this work.
- Do not add a durable process supervisor. The v2 plan cut that feature.

## Completion evidence

- A candidate-QA failure does not start the full suite.
- A candidate-QA pass starts the full suite once for that candidate.
- A full-suite failure returns evidence to the next repair round.
- The next changed candidate repeats cheap checks and candidate QA before its
  full suite.
- The aggregate pre-ship full suite still runs.
- QA authorization tests prove that the candidate tree ID is not a `HEAD`
  commit ID.
- The v2 plan records which PRD 4 work shipped early and which work remains.
