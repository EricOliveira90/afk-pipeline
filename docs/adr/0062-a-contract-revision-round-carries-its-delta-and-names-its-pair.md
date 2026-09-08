# A contract revision round carries its delta and names its pair

**Status:** Accepted
**Date:** 2026-09-08

Issue #196 (afk-v2-acceptance-scope-gates self-run, slice #195,
`run-20260908-043123`). The slice wrote a contract the evaluator reviewed at
45,862 bytes, drew `REVISE` with three blocking findings, revised it, and then
died at `CONFIGURATION` — "Contract evaluator prompt exceeds inline-size budget:
actual 151315 bytes, allowed 65536". Six of the PRD's eight slices were behind
it. A slice was blocked not by its contract's quality but by having drawn any
revision round at all.

The overflow also destroyed its own diagnosis. `assertEnvelopeBudget` throws
before `assembleContextEnvelope` returns, so no `prompt-assembly` event was ever
emitted for the round, and the run's otherwise exhaustive artifact log held
nothing about which artifact carried the 105 KB. Establishing that took a
hand-built harness replaying the preserved worktree files.

Measured that way, on the real artifacts:

| Revision-round block | Bytes |
|---|---|
| `contract-revision-evidence` | 70,899 |
| `revised-contract` | 22,495 |
| `revised-acceptance-manifest` | 17,034 |
| `explorer-behavior-preservation` (projected) | 10,545 |
| `prior-open-contract-findings` | 8,328 |
| `planner-response` | 5,197 |
| durable lineage (ADR 0061) | ~10,700 |
| `base-gate-catalog` | 1,520 |

Two facts follow, and the second is the one that decides the design.

`contract-revision-evidence` was `JSON.stringify(revisions, null, 2)` —
complete *before and after* copies of both artifacts. At 70,899 bytes it
exceeded the entire 65,536-byte budget by itself. That is the dominant term.

But the round's other blocks summed to about 69,000 bytes with **zero** bytes of
revision evidence. So compacting the evidence block alone could not make a
revision of this slice fit; one inlined artifact had to stop being copied into
the prompt.

## Decision

**1. The revision evidence block is the changed regions, quoted verbatim, and
nothing else.** `src/contract-revision-evidence.ts` renders a line-level diff of
each artifact as regions with their prior text and their revised text quoted
exactly. Unchanged text is not reproduced.

This is not a lossy summary of the old block; it is the part of the old block a
review could act on. The prompt already requires every fresh finding to carry a
`revisionCitation` whose `before` appears only in the prior artifact and whose
`after` appears only in the revised one — `validateRound2ContractReview`
enforces exactly that. Changed text is therefore the only citable text in the
round, and the unchanged bulk was carried so that it could never be used. On the
#195-shaped fixture the block goes from 70,899 bytes to about 21,000 with the
whole delta intact; a three-edit revision of the same contract renders in under
3,000.

**2. The revised pair travels by reference on the revision round.** The
evaluator runs in the slice's worktree, so `contract.md` and
`acceptance-manifest.json` are at the paths the prompt names, and the prompt
tells the round to read both in full. The classes stay declared; each carries a
`locatorExemption` recording why, so the omission is in the run evidence rather
than silent.

Reference, not omission: no evidence leaves the round, and the text a fresh
finding may cite is inlined by decision 1. The round-1 envelope still inlines
the pair — it fits, and a first review has no delta to anchor on.

The alternative was to keep the pair inline and drop the explorer projection or
the durable-lineage block. Both are worse. The projection is withheld
*mechanically* today (`explorer-patterns-and-harness` and
`explorer-data-and-integration` are declared omitted); replacing it with a
pointer plus an instruction would turn a mechanical control into a request. And
ADR 0061 decision 2 settled that a validator's informing block cannot be dropped
for bytes.

**3. The evidence block is sized to the room the round leaves it.** Assembly
renders the prompt once with an empty evidence block, subtracts, and renders the
delta within what remains. Every other block is required evidence, so the block
that overflowed is the one that yields. A revision can no longer be refused for
carrying too much of its own delta: it is truncated by whole regions — never
half a region, which would put text in the prompt that exists in neither
artifact — and the drop is named with its count and its budget.

**4. An overflow error names its per-artifact-class byte breakdown.**
`envelopeArtifactByteBreakdown` ranks the inlined classes by weight, states what
the template and unlocated text account for, and lists what travelled by
reference. The `prompt-assembly` event is still not emitted for a prompt that
was never dispatched — an event claiming an assembly that did not happen would
corrupt the run journal's byte totals — so the breakdown rides the error, which
is where a babysitter reads it.

The budget is **not** raised. ADR 0061 pointed at the budget setter (#161) for
#188's 72,688-byte overflow; this ADR takes the other route, because a budget
that has to grow to hold two whole copies of an artifact is measuring the
copies, not the discipline.

## Consequences

- A revision round's prompt no longer scales with the size of the contract pair,
  only with the size of the revision. The #195-shaped regression fixture
  assembles at 61,503 bytes with its full delta carried and no truncation.
- The revision review is no longer self-contained: an evaluator that does not
  read the two named files reviews a delta without its context. Every provider
  AFK dispatches has file tools and already must write two files, so the
  capability is not in question; the discipline is, and it is a prompt
  instruction rather than a mechanical guarantee. This is the cost of the
  decision, recorded rather than discovered.
- A fresh `revisionCitation` is now *more* likely to validate, not less. #188
  defect 1 reports a review refused for a citation whose `after` did not match
  the current manifest — the failure mode of quoting unchanged text out of a
  whole-file copy. The evidence block hands the round citation-ready strings and
  the prompt says to copy them.
- **Relationship to #188, stated as evidence rather than as a claim.** #188
  defect 2 (`actual 72688 bytes, allowed 65536`) is the same assertion on the
  same role, and ADR 0061 already attributes it to the revision envelope, so the
  code path is shared and this change reduces the same dominant term. It is not
  established as the *same* root cause: #188's report predates any per-artifact
  breakdown, so nothing in it distinguishes a 70 KB evidence block from a large
  PRD inlined elsewhere. Decision 4 is what would settle it on the next
  occurrence. #188's other three defects — artifact-schema strictness (closed by
  ADR 0061), win32 `spawn ENAMETOOLONG`, and infrastructure faults spending the
  resume cap — are untouched here.
- **Early contract-lock refusal was not implemented.** #196's point 4 proposes
  projecting the revision-round size at contract lock and refusing the round-1
  verdict. It is now the wrong shape: the projection's dominant input was the
  revised pair, which no longer enters the prompt, and the revised delta does
  not exist at lock time. Decision 3 makes the round fit rather than predicting
  that it will not, and decision 4 makes the residual case legible. If a lock-
  time gate is still wanted it should measure the fixed blocks alone, which is a
  different check from the one #196 describes.
- Cites ADR 0061 (the durable-lineage block this decision preserves, and the
  #188 attribution it records) and the by-reference precedent in the generator
  envelope's `repair-context` artifacts.
