# The generator budget counts required input

**Status:** Accepted
**Date:** 2026-09-14

Issue #273. ADR 0068 moved the generator's locked contract pair by reference
and, deliberately, did not raise the budget: "a budget that has to grow to hold
a whole copy of an artifact is measuring the copy, not the discipline." That
reasoning was right about the copy and wrong about the zero. Moving the pair out
of the prompt did not stop the round from being *required* to read it — every
generator prompt tells the round to open both files in full before writing
anything — so the 65,536-byte assertion went from measuring too much (a copy) to
measuring too little (nothing at all). A pair of 63,970 bytes and a pair of 600
bytes produced the same number.

That is a budget the pipeline can pass and the round cannot survive. The
assertion is the only thing standing between an accepted contract and a
dispatch, and it was answering a question nobody asks: not "how much starting
context is this round obliged to take on" but "how many bytes did we happen to
paste".

## Decision

**The generator's budget bounds its required input, not its inline prompt.**
`GENERATOR_CONTEXT_MANIFEST` declares 98,304 bytes, and the total asserted
against it is the assembled inline prompt plus the exact UTF-8 byte size, read
from the worktree, of every artifact the prompt requires the round to read in
full — today the locked contract pair.

### Required-input bytes are a deterministic lower bound

They are a **deterministic lower bound on the round's mandatory starting
context**, and nothing more is claimed for them. Deterministic: the same
worktree and the same round produce the same number, every time, from
`Buffer.byteLength(content, "utf-8")` over files on disk. A lower bound: the
round will read at least this much, because AFK's own prompt requires it.

The two things this number is explicitly **not**:

- **AFK does not predict provider tokenization.** Bytes are not tokens, and no
  tokenizer — the provider's, an approximation of it, or a third-party
  library — is consulted anywhere in `src/context-envelope.ts`. A byte count is
  a fact about a file; a token count is a fact about a model version that can
  change under us between two dispatches of the same round. The budget is
  denominated in the unit AFK can actually measure.
- **AFK does not budget later agent-chosen reads.** The round will open files
  this number knows nothing about — the ones it decides to open, which is the
  work. Bounding those would mean predicting an agent's behavior, which the
  budget has no standing to do. This is why the number is a lower bound and is
  described as one, rather than presented as the round's context size.

The honest claim is narrow on purpose. A gate that overstates what it measures
gets trusted for things it cannot see, and the first such trust that fails costs
more than the gate ever saved.

### Authoritative contract artifacts keep by-reference transport

ADR 0068's transport decision stands in full. `contract-view` and
`acceptance-manifest` are named at their worktree paths, carry the same
`CONTRACT_PAIR_BY_REFERENCE` `locatorExemption` the evaluator and planner rounds
use, and are never inlined. `FILE_SCOPE` remains a projection of the manifest,
not a copy of the file. The locked contract on disk is the authority (ADR 0008),
and reading it still beats being handed a copy of it.

Counting a file and copying a file are different acts. What changed is only
that the count is no longer zero.

### What this narrows, and what it does not supersede

- **ADR 0068** is narrowed on exactly one sentence: the reading under which
  `inlineSizeBudgetBytes` means inline-only for the generator, and the
  accompanying refusal to raise the number. Its decision — the pair travels by
  reference — is unchanged and unrestricted, as is its rule that an envelope
  must not inline a file the role can open in its own worktree. ADR 0068 is
  **not superseded**.
- **ADR 0062 decisions 2 and 4** are narrowed the same way and no further.
  Decision 2's by-reference transport is untouched; decision 4's
  overflow-breakdown shape is *extended* — the breakdown now also reports the
  per-artifact required referenced weights beside the inlined ones, for the same
  diagnostic reason it exists. ADR 0062 is **not superseded**.

No other role's budget or accounting changes: planner, explorer, evaluator,
cleaner, hardener, remediator, and guardian envelopes keep inline-only
accounting against their own declared `inlineSizeBudgetBytes`, and a
by-reference artifact still contributes zero bytes for them. Required-input
accounting happens only where an artifact is declared required-in-full, which is
the generator's pair.

## Mechanics

- **98,304** = the pre-#273 inline allowance of 65,536 plus 32,768 for a pair
  the round has always been required to read. The field keeps its name, because
  every other role still reads it as an inline-only budget and the
  stricter-only override rule is shared.
- **Overrides stay stricter-only in both directions.**
  `generatorInlineSizeBudgetBytes` below 98,304 becomes the effective
  required-input limit — for the assertion *and* for the repair round's
  commit-log room; above 98,304 it is clamped. `min(override, manifest)`, as
  before.
- **A missing or unreadable required artifact refuses the round** as
  `CONFIGURATION`, naming the artifact id and the path it was looked for at. The
  alternative is counting it as zero, which is the accounting this ADR exists to
  end.
- **One logical artifact is counted once.** A repeated artifact id contributes
  on its first appearance; an artifact whose content is already inlined
  contributes no referenced weight, because the prompt's own bytes carry it.
- **The repair round reserves the referenced weight before it sizes its commit
  log.** `boundRepairSituationCommitLog` (#230) is still the only block that
  yields, and it now yields against room that has already paid for the pair.
- **A pointer is not a requirement.** `repair-context` references
  (`stuck.md`, `handoff.md`) stay zero-weight: the prompt points at them rather
  than requiring them in full, and counting a pointer would make an absent
  `stuck.md` a hard configuration failure.
- **The accounting is reported where it can be read.** The four totals — inline,
  required referenced, required-input, allowed — plus every per-artifact weight
  appear in the `prompt-assembly` run event, in the overflow `CONFIGURATION`
  message, and in `run.log` and `run-summary.md`. The new event fields are
  additive and optional on read: absence means "this writer counted nothing",
  never zero, so a journal written before #273 stays readable and its
  prompt-bytes aggregation is unchanged.

## Consequences

- An accepted contract whose pair is large is refused *before* dispatch with a
  message naming which term overran, instead of dispatching a round whose
  mandatory reading does not fit. The refusal is the honest outcome; what #273
  fixes is that it used to not happen at all.
- Prompt preparation now touches the filesystem for two files per generator
  round, and can fail for a reason unrelated to prompt content. That is the
  fail-closed direction: a required artifact AFK cannot read is a configuration
  fault whether or not anyone counts its bytes.
- `assembleGeneratorEnvelope` takes the absolute root its worktree-relative
  artifact ids resolve against as an explicit input, because the orchestrator
  dispatches from the host checkout rather than from inside the slice worktree.
  A caller that omits it — a unit caller with no worktree — gets inline-only
  accounting and evidence fields that are *absent*, not zero.
- Fixing the number does not make every pair fit. A slice whose required input
  genuinely exceeds 98,304 bytes is a slice that is too large, and the budget
  now says so in the units the claim is made in. Deciding what to do about such
  a slice — splitting it, shortening required evidence — is deliberately not
  this decision's business.
- Cites ADR 0068 (narrowed: the inline-only budget reading), ADR 0062
  (decisions 2 and 4, narrowed and extended respectively), ADR 0066 (the
  planner-side application of the same by-reference pattern, unchanged),
  ADR 0008 (the locked contract on disk is the authority) and ADR 0038 (the
  generator's verification command, unrelated and unchanged).
