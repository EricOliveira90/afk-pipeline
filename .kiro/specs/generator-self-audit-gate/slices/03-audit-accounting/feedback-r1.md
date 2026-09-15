# Contract review — round 1

## What this contract gets right

The three unknowns the explorer left open that could have blocked a lock are all
decided in the contract rather than deferred:

- The run-state version question is answered unconditionally (`RUN_STATE_VERSION`
  → `8`, the `version` union widened, the version-history comment extended) with
  the reason the comment already gives for v6 and v7, and the consequence is
  carried by P-04 plus a named refresh of the pin at
  `src/eval-boundary.test.ts:127`. That pin is why `src/eval-boundary.test.ts`
  belongs in scope, and the contract says so.
- The "where does the spent check live" unknown is sidestepped by wiring it
  inside `runSelfAuditStage` via `selfAuditsFor`, so the review does not need to
  know whether `src/orchestrator.ts` already reads it today.
- Provider-level exit classification is a named non-goal with the reason a
  reviewer would otherwise have to ask for: under the non-kiro providers a
  transient death simply lands as `provider-exit`, which is still an
  infrastructure cause, so it still retries. Nothing silently degrades.

Gate aptness holds across the pair. Every behavior's assertions land at a unit or
source-order seam that `acceptance:behaviors` can select by name: the two new
pure functions (B-01, B-02), the stage loop and its call counts (B-03, B-04,
B-05, B-07), the run-state shape (B-06), the event builder and journal (B-08),
the derivation (B-09), the rendered summary (B-10), and text scans for the
never-gates rule, the ADR and CONTEXT.md (B-11, B-12, B-13). No behavior needs a
spawned pipeline to produce its evidence, and the contract makes that a non-goal
outright, which is what the repo's test-cost discipline asks for.

The two-sided evidence the changed input languages need is bound. For the
run-state loader, B-06 pairs a newly accepted v8 entry carrying `runId` against
v7-shaped entries that omit it or carry a blank one, and P-04 keeps v3/v6/v7
loading with the other members intact. For the event stream, B-09 pairs a
populated three-verdict stream against an only-`AUDIT_NOT_RUN` stream and a run
directory with no `events.jsonl` at all. Both halves live in the test files the
scope declares.

Scope and preservation match the evidence. The thirteen declared paths are the
thirteen the described work touches; `src/gate-runner.ts` is read as text by
B-11 and correctly not in scope. P-01 through P-06 pin the parts of the stage
this slice must not disturb — the opt-out and disagreement declines, the two
graded verdicts, slice 2's changed-tree helpers keeping their signatures and
bodies, the one-invocation bound, older run-state files, byte-identical summaries
for audit-free runs, and the single call site's position. The `AUDIT_NOT_RUN`
recording, the schema bump and the retry are each listed under changes to
existing behavior with the acceptance criterion that authorizes them, and ADR
0069 is amended in the same slice so no recorded decision is left contradicted.

## The one thing that has to change

B-03 declares a safety rule and then declares no way for it to fail. Its `then`
says an absent or invalid `infrastructureRetries` "reads as zero retries rather
than throwing", and the contract explains why that matters — the stage may never
block a run by its own failure. But the `given` only ever supplies
`infrastructureRetries: 2`, and the observables are three dispatch counts, two
retry log lines and a hub source scan. Nothing constructs a stage input that
omits the budget or carries a rejected value. B-04's exhaustion case pins `1` and
P-03's pins `2`, so no other behavior covers it either. An implementation that
threw on `-1`, or that read `undefined` as unbounded retry, would pass every
declared observable in the pair. Add the case to B-03's `given` and
`observableResult` (and its test-plan bullet): an input with no
`infrastructureRetries` and one with a value that is not a non-negative safe
integer, each dispatching exactly once and not rejecting.

## Two smaller notes, neither one a blocker

B-06 leans on a "whole-list rule" in `sanitizeSelfAudits` that the explorer
evidence does not establish. The evidence locates the helper and says a new field
must be reflected in its shape check, but says nothing about whether a malformed
entry discards that entry or the whole list. The declared `then` — no `selfAudits`
member for that issue — locks whole-list semantics. Since `src/run-state.ts` is in
scope and `runId` is the slice's own new field, the assertion is concrete either
way; the risk is that if the sanitizer discards per entry today, honouring the
declared outcome means changing discard granularity for the pre-existing
`candidateTreeId` and `verdict` checks as well, which no changes-to-existing
bullet authorizes. Either observe the granularity and state it, or declare the
change.

B-12 asks that the ADR "no longer carr[y] the unqualified phrase 'no retry'".
Unqualifiedness is not something a text scan can decide; the only mechanical form
is a substring absence check, which would also reject the correctly qualified
sentence B-12 is asking for ("no retry of a completed invocation"). Naming the
literal absence — the sentence at `:52-53` no longer appearing — makes the
assertion decide the thing it means.

## Carried-forward finding

The finding left open by the previous attempt — a B-07 observable tagged to
B-04, so a per-behavior gate run scoped to B-07 could not select the call-site
scan — is closed by this contract. The call-site scan is now split so each half
carries the tag of the behavior it proves: the recorder call with its
`sliceNumber` and `round` arguments under B-08, `runId: runIdFor(logger.runDir)`
under B-06, the `infrastructureRetries` argument under B-03, and the count and
position scan under P-06. No observable in this manifest points at an assertion
tagged to another id, so each behavior's gate run selects the tests its own
observables name.

## Feasibility

One session is a fair ask here. The work is wide in file count but shallow in
each file, and every piece is modelled on a named existing precedent the
contract cites: `classifyReviewFailure` for the situation-specific classifier,
`isInfrastructureCause` for the infrastructure predicate, the hub's existing
`infrastructureRetries` budget shape for the loop bound,
`buildQualityStageAttemptEvent` and `recordQualityStageAttempt` for the event,
`deriveQualityStageOutcomes`/`readQualityStageOutcomes` for the derivation pair,
and `qualityStageSection` for the optional summary section. No migration, no
dependency, no new prompt, no new fixture or wave. The verification the
definition of done names — typecheck, `test:fast`, and
`test:heavy:orchestrator` — matches the scope that is actually touched.
