# Contract review — round 1, cleaner loop (#87)

## What this round settles

Two carried findings are closed. The manifest declares `ARCHITECTURE.md` in the
upper-case spelling its own definition-of-done checkbox asks for, so F-22's
clear-condition is met on its face. It is worth recording that this axis was
never able to redden a gate: acceptance-manifest `fileScope` paths are
case-insensitive comparison keys — the declared path and the changed path are
both trimmed, separator-normalized and lowercased before comparison — so the
out-of-scope report F-22 predicted does not follow from casing. Keep the
upper-case spelling because the checkbox says so, not because a gate depends on
it.

F-23 is closed too. B-03's observable now names the tier-2 scenario
"a clean policy escalates, then repairs the re-approved tree" by title, says in
so many words that no third spawn is needed, and agrees with both the tier-2
assignment ("Shared result hosts B-03's ordering") and the test-plan bullet. No
manifest entry now asks for a spawned scenario the definition of done forbids.

Several things in this revision are genuinely good and I want to name them so
they survive the next round. The harness preamble that states, once, that
`finalEvaluationFixture` is a per-`it` factory and that no claim about a
`clean`-less run may cite a spawned scenario is the right shape: it turns a
recurring honesty trap into a declared constraint, and P-01's observable honours
it by refusing to cite a spawn at all. The two-commit boundary with its stated
green condition per commit, and the reasoning for why B-05 and B-10 appear in
the first commit's list, is the kind of thing a resuming session can actually
act on. And P-09's and P-10's "held by proxy, and is stated as one" passages are
honest about the difference between what a vitest unit test can observe and what
the behavior actually locks.

## What still blocks the lock

Both remaining blockers are the same kind of defect: two behaviors describing
one round's exit path in incompatible terms. Neither is a style question — the
acceptance gate selects B-07 and B-13 independently, so a generator would have
to make two mutually exclusive assertions green in the same file.

**The malformed-escalation path has two outcomes.** B-07 lists "malformed
artifact" among the exit paths where the reset "runs on every exit path out of a
round that wrote", and its observable asserts the post-round `HEAD` equals the
round's input checkpoint with one `it` per exit path, plus a `REVERTED` record.
B-13 says a malformed file leaves the round "recorded `ESCALATION_MALFORMED`
and treated as a plain cleaner round whose checkpoint is still gated", and its
observable asserts exactly that still-gated checkpoint. A round reset to its
input checkpoint has no output checkpoint left to gate, and
`PersistedQualityStageRound` carries one outcome, not two. B-08 makes it
sharper: if that still-gated checkpoint comes back green, B-08 wants `PASS` at
the last checkpoint, which the B-07 reset would have erased. Pick one reading —
the malformed escalation is either a revert or a plain gated round — and make
both behaviors and both manifest entries say the same thing.

**The escalation reset target differs by round.** B-07 resets to "the round's
input checkpoint"; B-13 resets "to the accepted tree". Those are the same commit
only in round 1. From round 2 on, B-08 has the next round running "from that
output tree", so the round's input checkpoint is the previous round's output
commit and not the accepted tree. Both behaviors declare a unit assertion on the
resulting `HEAD`, so for an escalation raised in round 2 or 3 one of them must
fail. Nothing in the contract restricts escalation to round 1, and B-12's prompt
deliberately carries `{{INPUT_TREE_ID}}` and `{{BASELINE_TREE_ID}}` as separate
values — the pair's own evidence that a later-round cleaner sees an input tree
that is not the accepted tree and can escalate from there. State the single
target that holds in any round.

## Worth a look, not blocking

B-06 puts one `runCandidateGatePhase` call over a gate set that mixes the new
`"clean"` stage, the new in-process `suppressions` gate, a `role`-source scope
gate and the full regression bundle, and B-04 asks it for "the same cache
options the candidate gate phase uses" — while `src/candidate-gate-phase.ts` is
deliberately outside the file scope, which is also how P-04 holds the release
helper unedited. The explorer's evidence for that module is an excerpt, with its
full contents an open unknown. If the helper turns out to need even an additive
parameter to accept that set, the generator is caught between B-06 and a scope
gate that reports the edit. Either cite the signature detail showing today's
entry point already takes an arbitrary declaration list plus those cache
options, or bring the file into scope and restate P-04 as a behavioral lock over
an edited file. I did not make this blocking: the excerpt does show a generic
declarations-plus-`infrastructureRetries` entry point, and the exclusion is a
declaration the next round can reverse cheaply.

## Scope, gates and feasibility

The declared file scope tracks the explorer's evidence, including the two
additive scope discoveries the contract argues for explicitly —
`src/escalation.ts` for the `artifactDirPolicy` argument (the explorer confirms
`runScopeGate` delegates every path decision to `outOfScopeChangedPaths`, so a
pre-filter in `src/scope-gate.ts` genuinely could not turn an exempted path into
an offender) and `src/artifacts.ts` for the `"cleaner"` prefix branch (the
explorer confirms `qaArchivePrefix`'s `else → "final"` fallback would otherwise
mislabel it). Gate assignments are apt: `typecheck` sits on every entry with a
type-level half, including P-04, P-09 and P-10, and `acceptance:behaviors` is on
all twenty-four. The wall-clock consequence of the two spawned scenarios is
declared with a number and routed to a handoff line rather than a budget edit,
which is the correct handling under ADR 0063. Non-goals name slice 04, #97, the
hardener loop, #226 and the self-run config exclusion. The remaining build-order
steps are large but bounded, and the commit boundary makes a mid-slice resume
safe.
