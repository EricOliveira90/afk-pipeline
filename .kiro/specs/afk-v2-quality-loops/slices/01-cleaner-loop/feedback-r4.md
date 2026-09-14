# Contract feedback — round 4 (cleaner loop)

## What is solid

Most of this contract is unusually well anchored. The hook point (B-03) lands on a
named no-op the explorer confirms exists for exactly this purpose, and the stage is a
new module with one call site rather than a widening of the existing stub — P-02 keeps
that stub as the injectable seam an existing test depends on, so the seam and the new
stage do not compete.

The parser-language changes bind both halves of their evidence, which is what ADR 0060
asks for. `parseClean` (B-01) declares newly accepted input (a valid minimal `clean`
with its three defaults) alongside input that must stay rejected (an unknown sub-key,
an id colliding with a catalog gate), and the manifest's `observableResult` names the
refusal messages, not just the refusal. `{changedFiles}` (B-02) pairs the two-path
expansion with the empty-expansion boundary and pins the exact `SKIPPED` detail string.
`parseCleanerEscalation` (B-13) declares an accept set and a reject set. The evidence
bump is paired the same way: B-10 supplies version 4 carrying `suppressions`, P-06
supplies versions 1–3 still readable and a version-3 document carrying `suppressions`
refused. Both halves of the run-state bump are bound too (version 6 written, version 5
read as "no stage ran" and left byte-identical).

The scope-discovery decisions are recorded rather than assumed, and they hold up. Keeping
`"cleaner"` out of `QA_REVIEW_STAGES` is what keeps `src/qa-review.test.ts` out of the
file scope, and P-09 locks the four array-derived structures that depend on it —
including the `(qa|uat|final)` archive-name anchor, which is what stops a cleaner archive
being replayed as a QA attempt record. The single sibling `GATE_EVIDENCE_VERSION` pin the
bump falsifies is named with its line and pulled into scope for that one edit. The
non-goals are genuinely drawn: the hardener, #97's reporting surface, the CLI flag, this
repo's own config, and #226 staying open are each named.

## What has to change before this can lock

**The escalation exit path has two contradictory dispositions.** B-07 says the reset runs
on every exit path out of a round that wrote and names escalation as one of them, with the
round spent and recorded `REVERTED` at the round's input checkpoint. B-13 says a valid
escalation resets to the accepted tree and consumes zero cleaner rounds. For any round
after the first those are different commits, and "round spent" and "zero rounds consumed"
cannot both be true of the same round. B-14's round-outcome enum carries both `REVERTED`
and `ESCALATED`, so the manifest records the disagreement instead of settling it. Pick one
reset commit and one accounting rule, and have B-07 defer explicitly to B-13 on that path.

**The persisted shape cannot express B-13's zero-consumption promise.** `qualityStages` is
keyed by issue only, its rounds array carries no baseline discriminator, and
`cleanerRoundsSpent` counts every round with `round >= 1`. So the escalating round —
which B-13 and B-14 both persist — keeps counting after the generator produces a new
candidate, and the re-approved tree gets a shortened budget rather than the fresh one
B-13 describes. Either give the record a per-baseline discriminator, or state plainly
that regeneration does not restore the budget and change B-13's wording to match. Right
now the two behaviors promise opposite things about the same resumed run.

**The slice is scoped past one session, and its own mitigation breaks the definition of
done.** Sixteen behaviors and nine preservation behaviors across thirty-two files, with
two versioned schema bumps, a new bounded writing stage, a new in-process gate, a new
agent role and prompt, a new config sub-schema, a new event with summary rendering and a
newly packaged template directory. The load-bearing order is good engineering — no schema
bump lands before the reader it exists for — but its shed list authorizes dropping B-12's
prompt wording, B-15 and the doc rows, and the definition of done requires a passing
tagged test for all sixteen. Under that plan the slice cannot both finish and be done.
The cleanest cut is to move the template, its packaging and the doc rows to a follow-on
slice and keep B-12 to the registration the dispatch actually needs; if instead everything
is mandatory, delete the shed language so the session has no licence to stop short.

## Smaller things worth fixing in the same pass

P-04 and P-05 rest their observables on a `git diff` reading of files that are outside the
declared file scope. No declared gate produces that evidence — the enforceable halves are
the existing assertions passing and the scope gate refusing the write, so say that instead.

B-16 gives two line anchors 220 lines apart for what it calls exactly one emit site,
without labelling which is the enclosing function and which is the insertion point. The
behaviour's whole claim — one event per run, not one per slice in a wave — depends on the
reader resolving that correctly, so it should not need resolving.
