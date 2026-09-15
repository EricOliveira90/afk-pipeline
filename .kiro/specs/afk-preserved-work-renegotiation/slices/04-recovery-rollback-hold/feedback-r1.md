# Contract review — round 1, slice 04 (recovery rollback hold, #333)

## What is already solid

The scope lock is unusually clean about what this slice is: two terminal
outcomes plus one exported predicate, no orchestrator call site, no ref
movement. The non-goals name every neighbour (#332, #334, #335, #278) and the
`--renegotiate-stale` entry-point refusal, so there is no ambiguity about where
this slice stops. The decision to reuse `LEGAL_RECOVERY_TRANSITIONS` unedited is
right and matches the evidence — the map already encodes
`PENDING -> {ROLLED_BACK, ROLLBACK_FAILED}` and `ROLLBACK_FAILED -> ROLLED_BACK`.

B-02 is the best scenario in the pair. Verifying from the destination bytes,
against both the snapshot copies and the `PENDING` event's original
fingerprints, is exactly the distinction the evidence draws between "the bytes I
just copied" and "the bytes admission blessed"; the tampered-snapshot scenario
is the one case that separates the two checks, and the contract picked it.
Choosing purely additive optional fields over a `RUN_STATE_VERSION` bump, with
the `specsDir` precedent cited, is a well-argued call and is recorded as a
planner decision rather than smuggled in. Declining a spawned pipeline scenario
with a stated reason is the right reading of the repo's test-cost discipline.

The single-session shape is credible: the transition rule, the snapshot
publisher, the pair reader and the lineage writer all exist, so the work is one
restore-and-verify routine, one writer, one predicate, and their tests.

## What has to change before this can lock

**Attempt identity is asserted but not evidenced.** Four behaviors turn on an
`attemptId` — "exactly one `ROLLED_BACK` event for that `attemptId`", a refusal
message that "names the `attemptId`", "a fresh admission afterwards yields a
different attemptId". The evidence map's enumeration of
`PersistedRecoveryLineageEvent` does not include such a field, and the only
per-attempt identity it establishes is the never-overwritten `snapshotPath`.
The scope lock declares three new persisted fields, none of them an attempt id.
So either the field exists and the contract should cite it, or it does not and
adding it is an undeclared schema change with its own validation rule. Right now
the reader cannot tell which, and four observables have no fixed referent.

**The lineage validator's new rejections are undeclared.** The per-state rule is
the load-bearing part of the no-version-bump argument: the three fields are
required non-blank when the state is `ROLLBACK_FAILED` and required absent
otherwise. Both halves of that rule reject inputs, and neither rejection appears
in any behavior or test-plan line. What is declared is only accepted input — a
well-formed `ROLLBACK_FAILED` round trip, and a `PENDING`-only lineage with the
fields absent. P-04's "a malformed event still degrades the whole target's list"
restates the pre-existing all-fields-required gate; it does not touch either new
branch. As written, the rule could ship enforced in one direction, or neither,
and every declared test would still be green. Inline tests in
`src/run-state.test.ts` are the established harness here, so what is missing is
concrete rejected-input scenarios, not fixture paths.

**The preservation behaviors declare a gate that cannot see them.** All five
`P-0N` entries list `acceptance:behaviors`, which runs
`vitest --testNamePattern {behaviorId}`. The Definition of done only requires
`[behavior:#333:B-0N]` test names, and P-02 and P-05 point at existing
`[behavior:#332:B-0N]` / `[behavior:#277:B-0N]` tests instead. A pattern of
`P-01` selects nothing, and a zero-test selection reads as a pass. The entire
preservation half would ship with a green gate that examined nothing. Either
require `[behavior:#333:P-0N]` names, or leave the preservation entries on the
`tests` and `typecheck` gates that can actually produce their evidence.

## Smaller things worth fixing while you are in here

B-01's observable sweeps "every one of the five admitted failure triggers", but
`restoreAcceptedPairFromSnapshot` never receives a trigger — that sweep is
B-03's. B-09's observable ("contains no second byte or fingerprint comparison",
"holds no second compare of its own") is a judgement about source text with no
dependable mechanical form; a behavioural restatement, such as one induced
obstacle producing the same shaped failure through both entry points, would
prove the same single-implementation point. And B-05 rests on the restored
accepted pair being disjoint from what `listLiveNegotiationFiles` reports —
structurally likely, since the pair is snapshotted at the snapshot root and the
history in a `negotiation/` child, but the evidence never fixes that set's
membership, and both files live under the same slice directory. Cite it.
