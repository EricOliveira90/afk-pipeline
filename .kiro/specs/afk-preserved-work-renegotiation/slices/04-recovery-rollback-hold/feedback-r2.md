# Contract review — round 2 (#333, recovery rollback hold)

The revision closes every prior finding. One new advisory stands, on an
assertion the revision introduced.

## F-01 — attempt identity — resolved

The planner is right and round 1 was wrong on the premise. `attemptId` is the
first declared member of `PersistedRecoveryLineageEvent`
(`src/run-state.ts:284-286`, "Opaque per-attempt identity; a retry never reuses
one"), it is required non-blank for every state by `sanitizeRecoveryLineage`
(`src/run-state.ts:1120`), and it is copied forward on load
(`src/run-state.ts:1144`). The interface's own doc comment
(`src/run-state.ts:269-277`) already fixes the append-only retry rule B-08
relies on. Round 1 took the explorer evidence map's field enumeration as
complete; it omitted the field.

The revision took the first option regardless: B-03, B-06, B-07 and B-08 each
cite the line range, B-07 also cites `snapshotPath` at `:307-308`, and the
schema section now states affirmatively that no attempt-identity field is added
and that none of the three new fields is one. The behaviors and the schema
declaration agree, which is what the finding was for.

## F-02 — parser regression surface — resolved

Both directions of the new per-state rule are now bound, and bound separately
from the pre-existing all-required gate they were previously conflated with.
Manifest B-06 adds input family (c) — a `ROLLBACK_FAILED` event missing, then
blanking, each of `rollbackError`, `observedContractFingerprint` and
`observedManifestFingerprint` — and family (d) — a `PENDING` carrying
`rollbackError` and a `ROLLED_BACK` carrying `observedContractFingerprint`. Its
observable binds them as inline tests in `src/run-state.test.ts`, which is that
parser's established harness, and the test plan adds matching scenarios naming
the same file.

The detail that makes these tests worth having: each rejection test also asserts
the same document loads intact once the offending field is corrected. Without
that, a rejection test can pass because the fixture was malformed in some
unrelated way, which is exactly how a one-directional rule ships green.

## F-03 — acceptance gate selectability — resolved

The Definition of done now requires an `it` named `[behavior:#333:P-0N]` for
every preservation behavior, and states the reason: `--testNamePattern
{behaviorId}` selecting zero tests reads as a pass, so an unnamed `P-0N` entry
would ship the preservation half of the slice with a vacuous gate behind it. It
also draws the right line — a `P-0N` test may assert against an existing
`[behavior:#332:B-0N]` or `[behavior:#277:B-0N]` fact, but it must carry its own
name to be selectable.

P-02 and P-05 followed through: they now assert their preserved facts directly
(history digest, the deleted set, the cleared checkpoint and lineage; the
transition map entry by entry) instead of only pointing at the older suites.

## F-04 — B-01's trigger sweep — resolved

B-01's observable is now stated purely over the restore call's own inputs, and
says explicitly that the routine takes no failure trigger so none is swept
there. The five-trigger sweep moved to B-03, and the test plan's first scenario
split into a B-01 direct-call scenario and a B-03 per-trigger scenario. Each
obligation is now proved under the name that owns it.

## F-05 — B-09 decidability — resolved

B-09 no longer asks a test to read source text. One induced restore obstacle met
through both entry points must produce the same failure identity — the direct
call's message and observed fingerprints equal the `ROLLBACK_FAILED` event's
`rollbackError`, `observedContractFingerprint` and
`observedManifestFingerprint`. That is decidable, and a second independent
compare inside the writer could not keep it true, so it actually carries the
single-implementation obligation rather than approximating it with a grep.

## F-06 — `listLiveNegotiationFiles` membership — resolved

The citation checks out exactly. `RECOVERY_NEGOTIATION_FILENAMES` is a closed
list at `src/preserve-work-recovery.ts:828-834`, and `listLiveNegotiationFiles`
(`:847-860`) reports that list plus the `feedback-r<N>.md` rounds matched by
`FEEDBACK_ROUND_FILENAME`. Neither pair filename is a member. B-05 additionally
asserts that non-membership, so "still returns an empty list" is now a claim
about a set whose contents the test pins rather than assumes.

## F-07 — B-03's lock clause is not observed by the mechanism it names (advisory, new)

B-03's revised observable ends: "It also asserts the append happened under the
lock by driving it through `transactRunState` and observing the reloaded file."
Reading the reloaded file shows only that the event was persisted. A writer that
appended outside the lock, or that opened its own second transaction, produces
the same reloaded file, so that clause reports a pass for any implementation
that persists the event at all.

The obligation is worth pinning — the contract states it as "reloaded state
under the ADR 0056 lock, rechecked the trailing event, and admitted the
transition" — and the recheck is the half with a visible consequence. If the
target's trailing event is replaced between the caller's read and the writer's
transaction body, the append must refuse and no `ROLLED_BACK` may be written;
that is a scenario a test can construct and fail on. Either restate the clause
around that, or drop it and leave the writer's call shape to P-03, which already
covers it.

This is advisory: the rest of B-03 (exactly one appended event, the `state`, the
`attemptId` equality against the trailing `PENDING`, the save/load round trip,
once per trigger) is sound on its own, and the slice is implementable as
written.
