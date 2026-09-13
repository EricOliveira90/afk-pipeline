# Contract feedback — round 6 (fresh negotiation, round 1)

## What is solid

Most of this contract does not need defending. Fourteen behaviors and ten
preservations each name a concrete observable, a home for it and a gate set that
can actually produce evidence: no entry declares `lint` (which the catalog marks
non-executable), every entry carries `acceptance:behaviors`, and the entries with
a type-level half — P-04's signature claim, P-09's widened union, P-10's
default-argument claim, B-14's schema — carry `typecheck` alongside `tests`,
which is the right call given that vitest strips types without checking them.

The scope reasoning is unusually well grounded. B-11's decision to land the
`role`-source rule in `src/escalation.ts` rather than `src/scope-gate.ts` is
argued from where the exemption actually lives — `runScopeGate` delegates every
path decision to `outOfScopeChangedPaths`, so a pre-filter in the gate could only
widen the accepted set — and that matches the explorer's reading of
`src/escalation.ts:259-325`. B-09's decision to widen the `QAReviewStage` union
without joining `QA_REVIEW_STAGES` is what keeps the file scope closed, and the
contract says so rather than leaving a reader to notice. P-09 and P-10 are
honest about the two claims they can only hold by proxy — the module-private
`RECORD_FILENAME` anchor and the "no `sliceArtifactDir: ""`" rule — and each
substitutes an observable a vitest unit test can genuinely reach instead of
asserting a diff it cannot see. P-01 goes out of its way to exclude the run-state
`version` field from its no-change claim, because B-14's bump is unconditional;
that is exactly the kind of admission that makes a preservation entry testable
instead of aspirational.

The harness reasoning is also right. The plan establishes that
`finalEvaluationFixture` is a per-`it` factory with no shared spawned result, and
then draws the two consequences that follow: an appended `it` is a new spawned
scenario rather than a free assertion, and because both tier-2 scenarios declare
`clean`, no claim about a `clean`-less run may cite one. The disabled-stage
claims are correspondingly unit claims. That is the discipline `CLAUDE.md`'s
"Where a new assertion goes" asks for, applied rather than cited.

## Why this cannot lock yet

The contract's picture of what is already built is wrong, and the plan of record
is built on top of that picture.

The contract is right that the explorer's "no cleaner-related symbol exists in
`src/`" is stale — it is. But the correction it substitutes stops several commits
short. It says the remainder is "deliberately two commits, not one", naming them:
`feat(#87): cleaner stage, its gates and the cleaner role` and `feat(#87):
persist and archive cleaner rounds`. Both of those commits already exist on this
branch, as `07cb5e3` and `1a9961a`, and ten `test(#87)` commits sit on top of
them. `src/cleaner-stage.ts`, `src/suppression-gate.ts` and `prompts/cleaner.md`
are all present. `src/run-state.ts:67` reads `RUN_STATE_VERSION = 6`.
`ARCHITECTURE.md` already carries the module rows and the version-4
`suppressions` paragraph the build order's fifth step promises to add. The two
tier-2 spawned scenarios landed in `e16d6de`.

So four of the five build-order steps describe finished work, and the commit
boundary describes commits a generator cannot make because they are already made.

The second-order damage is worse than the staleness itself. Step 2 rests entirely
on one claim — that `src/acceptance-gate.test.ts:329` still pins
`GATE_EVIDENCE_VERSION` at 3 and "the suite is red at HEAD until it moves" — and
that pin already reads 4, at line 306. The manifest carries the same
counterfactual as B-10's `given`. Meanwhile the branch *is* red, on something
else: `src/eval-boundary.test.ts:127` and
`src/qa-orchestration-gates.test.ts:1016` still pin the run-state version at 5
against a constant that reads 6. That is the one obligation the repository shows
as genuinely outstanding, and B-14 describes it accurately and completely — down
to the "only the literal changes" constraint. But the build order files it in
step 4, behind three steps of already-finished work, and tells the generator its
first move is a pin that is not there. A session following this ordering opens
`src/acceptance-gate.test.ts`, finds nothing to do, and has to re-derive the
branch's real state before it can start — which is the precise cost the commit
boundary says it exists to avoid.

None of this is a reason to reopen a behavior. The behavior set, the file scope,
the gate assignments and the preservation reasoning all still hold; what needs
rewriting is the ledger that says which of them are done. Re-derive the
not-greenfield paragraph, the build order and the commit boundary against this
branch's tip, citing its commits by hash. State every landed behavior the way
B-01 and B-10 already state their landed halves — the obligation is that it stays
true and is not re-implemented. Then let the remaining-work statement name only
the two version-5 pins, and let the commit boundary describe a commit that does
not yet exist.

## One smaller thing

The test plan asks for tags in "the bracketed `behavior:` form this contract's
In-scope and preservation bullets use" — that is `[behavior:B-05]`. The landed
tests use the issue-qualified `[behavior:#87:B-05]`, and that qualification was a
deliberate commit (`8d2c966`). `acceptance:behaviors` selects by
`--testNamePattern`, so the qualified form still matches and no gate is at risk;
the concern is only that the sentence as written invites someone to strip the
`#87:` back off. Naming the qualified form, or saying either satisfies the gate,
settles it.
