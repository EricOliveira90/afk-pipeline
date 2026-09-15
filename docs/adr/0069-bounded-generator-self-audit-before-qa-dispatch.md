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

One **completed** invocation per QA submission, bounded by construction: the
bound counts invocations that finished, so a dead invocation whose cause
classifies as infrastructure under ADR 0025 is re-dispatched under the run's
`--infrastructure-retries` budget and an exhausted budget records
`AUDIT_NOT_RUN`, while the loop exits on the first attempt that completes — a
retry replaces a dead invocation rather than buying a second completed one, and
there is no second challenge for a tree the audit rewrote (#301). That
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
- A tree the audit rewrote has not been through the required cheap gates, so it
  is not a candidate anyone may grade yet. On `AUDIT_CHANGED` the same required
  cheap gate declarations that released the pre-audit candidate — the round's own
  pre-QA set filtered to the required ids of the cheap gate catalog, derived from
  the catalog rather than listed again — run a second time, on the audited tree.
  The acceptance gate and the full suite are excluded by that derivation: a gate
  whose `expectedCostMs` is undeclared cannot be asserted cheap, and the audited
  tree is still graded by the post-QA gate phase and the QA evaluator.
- A pass produces **one** graded-candidate identity — the audited tree id, its
  commit sha, and a base-gate evidence object built fresh from the audited run
  and naming the audited tree — and every pass-path consumer reads that one
  value: the deterministic QA dispatch, the approved baseline, the shared-preview
  stage and `runPostQAGates`'s `qaApprovedTreeId`. One value rather than four
  expressions because ADR 0012 gives a QA verdict authority over exactly one
  tree: `runPostQAGates` compares its approved tree id against a fresh checkpoint
  and refuses a tree the verdict does not cover, so a consumer left on the
  pre-audit id would fail the slice immediately after the verdict it just
  earned — and a single value cannot diverge from itself. The audited base-gate
  object is never a spread of the pre-audit one (which drops the skip
  authorization) and never that object passed through (which would authorize a
  skip for a tree QA is not grading); it vouches only for the gates that
  actually re-ran.
- A cheap-gate failure on the audited tree is an **ordinary repair round**, not a
  new failure path: it enters the existing bounded repair loop with the usual
  budget, spending no counter of its own and adding no terminal exit. The audited
  tree is registered as the attempt's current candidate when its checkpoint is
  minted, before those gates run, so it is named on the pass branch and the
  failure branch alike. After `AUDIT_UNCHANGED`, `AUDIT_NOT_RUN` or a run without
  `--self-audit`, every consumer still reads the pre-audit checkpoint pair
  exactly as it did before the changed-tree path existed.
- The audit costs one generator invocation per QA submission on runs that opt in
  and nothing at all on runs that do not, which is why the flag defaults off
  until the changed rate is known.
- Because the verdict is a tree comparison, it is auditable after the fact from
  run state alone: the persisted outcome carries the candidate tree the audit was
  handed, the tree it left behind, and the run-ID provenance of the run that
  spent the invocation, and a reader can check the verdict against them without
  trusting any narrative.
- A persisted outcome naming the tree in hand is a **spent** invocation: a
  resumed run that finds one dispatches nothing and records nothing, because the
  count of spent invocations is derived from the run-state file rather than
  re-derived from the tree (#301).
- The per-verdict totals and the changed rate the run summary reports **report
  and never gate** (ADR 0063). They are an operator measurement: no gate id, gate
  declaration, threshold, merge decision or dispatch decision keys on any of
  them, and the changed rate is compared against nothing.
