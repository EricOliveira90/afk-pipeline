# Contract review — round 2

Slice: `01-audit-invocation` (GH #299)

The revision closes both findings the previous round left open, and it closes
them on the seams the findings pointed at rather than by adding cost.

## The persistence obligation now has an observation behind it (F-11)

The prior round's objection was that the slice's one persisted fact — #299
AC10 — was proven only by a writer round-trip in `src/run-state.test.ts`, a
test that stays green whether or not any stage ever calls the writer. The
revision moves the obligation onto the stage's own entry point, which is the
route the finding preferred:

- B-09's `given` now includes the temporary run-state directory B-02 already
  declares, so no new harness appears.
- B-09's `then` states that exactly one `AUDIT_UNCHANGED` entry for the slice's
  GitHub issue was recorded through `recordSelfAuditOutcome` before the stage
  returned, with `candidateTreeId` and `auditedTreeId` both equal to the
  released tree id.
- B-09's `observableResult` declares the reading assertion —
  `selfAuditsFor(loadRunState(<that directory>), ghIssue)` returning exactly
  one entry with that verdict and those two tree ids — and says plainly that
  this is the observation a writer round-trip cannot make.

B-10 is the right shape after the move: it keeps its stable ID, the additive
`selfAudits` record, the `PersistedSelfAuditOutcome` covering all three
verdicts, the reader, the writer, `RUN_STATE_VERSION = 7`, the widened version
union and the three literal-`6` pins — and it now says explicitly that the
"a classifying stage actually calls the writer" claim is B-09's, so it no
longer advertises coverage it cannot deliver. The scope lock ("the stage itself
records `AUDIT_UNCHANGED` in run state (schema v7) before it returns"), the
test-plan scenario ("A stage that classifies `AUDIT_UNCHANGED` without calling
`recordSelfAuditOutcome` fails this scenario.") and the unchanged Definition of
done line now say one thing. A candidate that ships `recordSelfAuditOutcome`
unreferenced fails B-09.

## The typecheck-only wiring is now stated, not implied (F-12)

The advisory asked for one of two things; the revision takes the second, and
takes it thoroughly. B-03's scan stays a pure source-order assertion — the
right call, since anchoring inside the injected callback's body is the same
stale-syntax class the #299 operator decision refused, and #300 rebuilds that
dispatch site anyway. In exchange the limitation is written down in every place
a candidate reads: contract B-03, contract B-09's ADR 0002 / ADR 0007 sentence,
the test-plan scan scenario, and both manifest `observableResult`s — B-09's
under an explicit "What the stage-local test does not claim". It also names what
exercises the wiring for real: an operator self-run launched with
`--self-audit`, the run-summary and status surfaces #301 owns, and #300 over the
same injected dispatch. Adding `typecheck` to B-03's and B-09's `gateIds` is the
matching bookkeeping: the stated claim now rests on the gate that actually
carries it.

## One thing worth tightening before you build (non-blocking)

B-03's `observableResult` used to assert that its scan's anchors each resolve
before comparing indices; the revision keeps the declaration-exclusion half of
that discipline and drops the found-ness half. As declared now, the test asserts
one `runSelfAuditStage(` occurrence plus two orderings over four anchors, with
nothing requiring `assertGateEvidenceReleasesEvaluation(`, the
`requiredFailures = collectRequiredGateFailures(` assignment form and
`await runQAStage(` to match at all. If one of those stops resolving, its index
becomes the not-found sentinel, the ordering comparisons pass without
constraining anything, and both B-03 and P-02 — whose entire no-audit-in-the-
failure-branch claim delegates to this scan — go green on a call site placed
anywhere.

This is not a reason to hold the lock: all three anchors resolve in
`src/orchestrator.ts` today, the candidate's edit is a single inserted call, and
the exactly-one-occurrence assertion still bites. It is worth restoring while
writing the test, because this scan is the slice's only observation of
placement, and #319's "anchor on stable tokens, not line numbers" concern —
which B-03 cites as its own source — is exactly about anchors that quietly stop
matching. Asserting each anchor was found before comparing indices costs one
line per anchor.

## Everything else held up

The pair remains within its declared surface: no new spawned pipeline scenario,
migration count 0, the changed-tree path and the QA dispatch argument still
#300's, the failure-cause taxonomy and status surfaces still #301's, ADR 0012
untouched, and `prompts/generator.md` / `prompts/generator-repair.md` kept out
of `fileScope` so the scope gate enforces P-04. The remaining manifest edits in
this round were `gateIds` array reformatting and source-citation enrichment,
neither of which changes what is observed.
