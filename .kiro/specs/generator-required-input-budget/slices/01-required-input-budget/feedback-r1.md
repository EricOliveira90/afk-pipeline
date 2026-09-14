# Contract feedback — round 1 (slice 01, required-input budget)

## What is solid

Most of this contract is ready to lock. The core of the slice — moving the
generator from a 65,536-byte inline-only assertion to a 98,304-byte
required-input assertion — is stated as a boundary you can actually test, and
the acceptance manifest's B-01 pins it at the exact byte on both sides rather
than gesturing at "enforces the budget". B-02 does the harder version of the
same thing: it says *where* the room subtraction happens (the repair branch at
`src/context-envelope.ts:2119-2166`) and that the referenced weight is reserved
before `boundRepairSituationCommitLog` runs, which is exactly the seam the
explorer identified as needing to change.

B-03's decision to take the resolution root as an explicit input rather than
lean on `process.cwd()` is the right call and, more to the point, it is written
down as a decision with its reason, so the generator will not quietly pick the
other option. B-04 drawing the line between "required in full" (the locked
pair) and "pointer" (`repair-context` references) is the distinction that keeps
an absent `stuck.md` from becoming a configuration failure, and it is stated
with its rationale rather than left implicit.

The preservation set is genuine work, not decoration. P-01 keeps the
by-reference transport intact while the bytes start counting — the whole point
of the slice is that those two facts are compatible, and P-01 is what proves it.
P-02 pins every other role's declared budget and the zero-weight behaviour of
their by-reference artifacts, which is the guard the explorer explicitly asked
for when it flagged that it had not confirmed whether `assertEnvelopeBudget` is
a shared path. P-03 keeps the fail-closed rule honest: only the commit log
yields.

The non-goals are unusually well drawn. #161's CLI surface, the contract-lock
size gate, slice auto-splitting, token prediction, and reversing #269/#270 are
each named, and "adding a spawned pipeline scenario" is named too — which
matters, because the test plan puts every assertion at existing unit seams. The
gates fit: `--testNamePattern <id>` works because the test plan requires each
test name to begin with its behavior id, and no behavior leans on the
non-executable lint gate. One generator session can carry this: the changes are
concentrated in one module plus two orchestrator call sites, and there is no
migration.

## What has to change

**The failure-recording path B-07 depends on is not established.** B-07 promises
that the overflow text reaches `run.log` and `run-summary.md` "through the
existing failure-recording path in `src/logger.ts`", without omitting,
truncating, or summarizing. The explorer looked for that path and did not find
it: there is no reference to `ContextEnvelopeConfigurationError` or to the
string `CONFIGURATION` anywhere in `src/orchestrator.ts`, and the writer in
`src/logger.ts` is recorded as "likely", with the formatting call site listed as
an open unknown. B-06's `src/logger.ts:472` citation is in the same position —
precise to the line, with nothing in the declared evidence behind it.

This is not a nitpick about citation hygiene. Two different slices hide behind
the current wording. If a formatter exists and preserves the message, B-07 is a
short assertion on existing behaviour. If it does not, B-07 is "build the
recording path", which is a different amount of work and a different set of
touched functions. The pair has to say which, and B-07's observable result has
to name the function and test file under test rather than naming the two output
files, because "the rendered `run.log` text" is not by itself a unit seam.

**The older-recorded-event guarantee has no owner.** The change list says the
generator context manifest version is bumped "so an older recorded event is
never mistaken for one that simply counted nothing". That is a real obligation
about reading journals written before this slice, and nothing in the acceptance
manifest covers it — B-06 only looks at events the new code writes. The version
being bumped is the *context manifest's*, and the contract never connects that
to how a recorded event is read back, so the mechanism does not obviously
deliver the promise. Meanwhile `src/resume-integration.test.ts` and
`src/orchestrator-runs.test.ts` sit in `fileScope` with no behavior saying what
they assert. As written, a generator that makes the new event fields required
satisfies every behavior in the manifest and can still break replay of an
existing journal. Either bind the claim to a behavior whose Given is a
pre-slice journal, or drop the sentence.

**Smaller, non-blocking:** B-09's ADR assertion has no declared home. The test
plan confines new tests to `src/context-envelope.test.ts` and
`src/logger.test.ts`, and neither is a natural place to read a docs file, so
naming the file removes a coin flip. Its gate set also drops `typecheck` while
every other behavior keeps it, even though the assertion is TypeScript like the
rest.

## One note for the next round

The explorer's unknown about whether `assertEnvelopeBudget` is shared across
roles is not a contract defect — P-02 is precisely the guard that turns it into
something the generator must check rather than assume. Leave that as is; it does
not need a revision.
