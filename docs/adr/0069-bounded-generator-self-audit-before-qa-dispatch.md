# 0069 — A bounded generator self-audit before the QA dispatch

**Status:** Accepted
**Date:** 2026-09-15

A candidate arrives at the deterministic QA dispatch having passed its required
cheap gates, and the only thing that has read it critically since the generator
stopped writing is a gate. `prompts/generator.md` already carries a
`# Self-audit before commit` section, and prose in the invocation that writes the
code is the weakest possible place to put "now check your work": the round that
is trying to finish is the round asked to find reasons it is not finished.

The idea of a *separate* call comes from SwarmForge
(github.com/unclebob/swarm-forge), whose `swarm_handoff.sh` dispatches the
implementing agent twice: once to build, and once more, on a fresh invocation,
to audit what it just built before the work moves on. The second call is cheap
relative to a QA round and its whole value is that it is a different invocation
with a different question.

The hard part is not the invocation, it is the verdict. An agent asked "did your
audit find anything?" answers with a claim, and a claim from the author of the
work is the one input this pipeline has the least reason to trust. There is a
fact available instead: the exact tree the audit leaves behind. The candidate's
tree object id is already the pipeline's identity for a candidate — the gate
cache keys on it, and ADR 0012's base-gate authorization refuses evidence whose
tree id is not the tree under review. Comparing the tree id before the audit
against the tree id after it answers "did the audit change anything?" without
asking anyone.

The other hard part is knowing when to stop. An audit that can be re-audited has
no natural terminus: each pass may produce a diff, each diff invites another
challenge, and the loop is bounded only by a counter someone has to pick. So the
bound is structural rather than numeric.

## Decision

Behind `--self-audit` (default off), a candidate that has cleared its required
cheap gates receives **exactly one** generator re-dispatch in its own worktree,
between the gate-release assertion and the deterministic QA dispatch.

The verdict is structural, never agent-certified. The stage re-hashes the
worktree with `resolveCandidateTreeId` — the same exact-tree identity the gate
cache and ADR 0012 use — and compares it against the tree the gates released:

- equal tree ids are `AUDIT_UNCHANGED`;
- different tree ids are `AUDIT_CHANGED`;
- an invocation that did not complete, or one whose post-audit tree could not be
  resolved, is `AUDIT_NOT_RUN` **on the tree the gates released** — the
  uncertain case takes the branch that cannot loop (ADR 0041), which is the
  branch that proceeds to QA exactly as if the audit had never been dispatched.

One invocation per QA submission, bounded by construction: there is no loop in
the stage, no retry, and no second challenge for a tree the audit rewrote. That
bound is the standing argument against an audit-of-the-audit. A second challenge
would be asking the same agent the same question with more context, which is how
a bounded improvement becomes an unbounded one; and the pipeline already has a
role whose job is to disagree with the generator — the QA evaluator, which the
audit runs *before* rather than instead of. If a future change wants more
scrutiny, the place to add it is a role that is not the author, not another turn
for the author.

The audit's licence is its own worktree within the locked file scope. It may
commit a fix where it finds a gap, and resubmitting the candidate unchanged is a
legitimate outcome — stated in `prompts/generator-audit.md` in those terms, so
the invocation is not pressured into cosmetic churn to look diligent.

## Consequences

- An unchanged tree is the expected outcome, not a wasted invocation. The
  measurement worth watching is the changed rate: a rate near zero says the
  audit is not earning its call, and a high rate says the gates before it are
  letting too much through.
- The gate may add scrutiny and may never block a run by its own failure. The
  stage declines rather than throws — when the run did not opt in, and when the
  base-gate evidence disagrees with the checkpoint it was handed — and even a
  configuration fault inside its envelope degrades to `AUDIT_NOT_RUN` on the
  released tree.
- A tree the audit rewrote has not been through the required cheap gates. That
  is why the changed-tree path is a separate decision from this one: whatever
  re-runs those gates and decides which tree QA grades has to be built
  deliberately, and until it exists an `AUDIT_CHANGED` verdict is recorded and
  changes nothing downstream.
- The audit costs one generator invocation per QA submission on runs that opt in
  and nothing at all on runs that do not, which is why the flag defaults off
  until the changed rate is known.
- Because the verdict is a tree comparison, it is auditable after the fact from
  run state alone: the persisted outcome carries the candidate tree the audit was
  handed and the tree it left behind, and a reader can check the verdict against
  them without trusting any narrative.
