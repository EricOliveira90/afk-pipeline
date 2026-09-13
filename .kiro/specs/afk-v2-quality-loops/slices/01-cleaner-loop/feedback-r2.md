# Contract review — round 2 (cleaner loop)

The revision resolves all three carried findings, and it resolves them by
deciding, not by hedging. Each of the two contradictions is now settled in one
direction and that direction is written into both behaviors and both manifest
entries, which is what the round-1 review asked for.

## F-24 — the malformed-escalation round's outcome and tree state

Settled as a revert path. B-07's new exit-path list gives a malformed
`cleaner-escalation.json` one reset target (the round's input checkpoint) and one
outcome (`ESCALATION_MALFORMED`), and says in the same breath that the round's
checkpoint is discarded by that reset and is therefore never gated. B-13 no
longer competes with it: the "treated as a plain cleaner round whose checkpoint
is still gated" clause is withdrawn in so many words, and the replacement text
points at B-07's reset as the reason.

The manifest follows the prose rather than lagging behind it. B-07's `then`
enumerates one target and one outcome per path, and its `observableResult` adds
the negative assertion that no gate result exists for a discarded malformed
checkpoint — which is the assertion that makes the withdrawal observable rather
than merely stated. B-13's `then` calls `ESCALATION_MALFORMED` "its only
outcome" and its `observableResult` asserts `HEAD` at the input checkpoint.

Two consistency checks pass. `ESCALATION_MALFORMED` is already a member of
B-14's `PersistedQualityStageRound` outcome union, so the single recorded
outcome is representable without touching a behavior outside this finding's
scope. And B-08 no longer collides: a malformed round retains no checkpoint that
could be "PASS at the last checkpoint".

## F-25 — the reset target for a valid escalation

Settled as the accepted tree, with the exception declared where the general rule
lives. B-07 now carries the escalation path as its fourth exit path, names the
accepted tree, calls it the one documented exception to the input-checkpoint
target, and records why: an escalation hands the slice back to the generator
loop and invalidates the accepted tree's baseline citation, so every
post-approval cleaner commit goes, not only the escalating round's. B-13 states
the same target and cross-references B-07 rather than asserting an independent
one.

The part that makes this durable is that both declared assertions are now pinned
to round 2. Manifest B-07 asserts "the accepted tree and not round 1's output
commit for the round-2 escalation"; manifest B-13 asserts the same comparison
from its own side; both test-plan bullets carry the round-2 framing. In round 1
the two candidate targets are the same commit, so a round-1-only test would have
passed under either reading and the disagreement could have survived green.
Pinning the case to round 2 removes that hiding place.

## F-26 — the fileScope exclusion of `src/candidate-gate-phase.ts`

The advisory is cleared by citation, and the citations check out against the
source. `runCandidateGatePhase`'s single args object declares
`declarations: readonly GateDeclaration[]` and an optional `cache?:
GateCacheOptions` documented as a verbatim pass-through to `runGates`
(`src/candidate-gate-phase.ts:47-72`); `GateDeclaration.stage` is `stage: string`
(`src/gate-runner.ts:130`) validated only as non-blank in `classifyDeclaration`
(`src/gate-runner.ts:451`). So the mixed clean/deterministic/full-suite
declaration list, the new `"clean"` stage string, the new `suppressions`
declaration and the round-0 cache options all reach the helper without an
additive parameter, and holding the file out of scope no longer rests on hope.

The citation is written into B-04, B-06 and P-04 rather than into one of them,
which matters because it is P-04's exclusion that the other two lean on. Each of
those three manifest entries carries `typecheck` among its `gateIds`, so the
"compiles against the unedited signature" half of the claim is observed by a
gate instead of asserted in prose.

## Note for the generator, not a finding

B-07's framing sentence keeps the phrase "a reset runs on every exit path out of
a round that wrote" and then enumerates four paths as exhaustive. Read as an
enumeration of the *reset* paths — which the four listed items plainly are, all
four being failure or escalation exits — it is consistent with B-08, whose
green-bundle paths (PASS at the last checkpoint, and continue the next round from
that output tree) deliberately keep the round's output tree. That is the reading
to implement; nothing in the pair supports resetting a round that gated green.
