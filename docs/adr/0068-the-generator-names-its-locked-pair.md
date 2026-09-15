# The generator names its locked pair

**Status:** Accepted
**Date:** 2026-09-12

Issue #269, from this repo's own self-run: PRD 5 slice #87, relaunched as
`run-20260912-134807` on the build that had just fixed #265. The slice
negotiated a contract the evaluator **accepted** — zero blocking findings —
locked it, dispatched the generator, and died before writing a line:

```
CONFIGURATION: Generator prompt exceeds inline-size budget: actual 72040 bytes,
allowed 65536 bytes (inlined bytes by artifact class: contract-view 34593,
acceptance-manifest 29377, patterns-and-harness 3165, file-scope 837,
migration-reservation 109, verification-command 36, failure-set 6;
template and unlocated text 3917)
```

`contract-view` + `acceptance-manifest` = **63,970 of 72,040 bytes**. The pair,
inlined. `#97` then went `NOT-RUN` behind it, so one copied file blocked a
whole PRD.

`assembleGeneratorEnvelope` rendered `prompts/generator.md` and
`prompts/generator-repair.md` with `CONTRACT_VIEW` and `ACCEPTANCE_MANIFEST`
interpolated as fenced copies under `# Locked contract view` and
`# Acceptance manifest`. The generator runs in the slice worktree, where both
files sit at the paths its own write boundary already names
(`{{SLICE_DIR}}/escalation.md` is written beside them). The copy added nothing
the generator could not open, and it made the prompt scale with the size of the
contract rather than with the size of the work.

## Decision

**ADR 0062 decision 2 extends to the generator, in both modes: the locked
contract pair travels by reference.** `prompts/generator.md` and
`prompts/generator-repair.md` name `{{SLICE_DIR}}/contract.md` and
`{{SLICE_DIR}}/{{ACCEPTANCE_MANIFEST_FILE}}` and require the round to open and
read both in full before writing. `contract-view` and `acceptance-manifest`
stay declared in `GENERATOR_CONTEXT_MANIFEST` and both files stay in the
envelope evidence, each carrying the same `CONTRACT_PAIR_BY_REFERENCE`
`locatorExemption` the evaluator and planner rounds use, so the omission is in
the run evidence rather than silent.

Mechanics are the evaluator's, and nothing else moves:

- Accepted classes, input order and `inlineSizeBudgetBytes` (65,536) are
  unchanged. The budget is **not** raised, for ADR 0062's reason: a budget that
  has to grow to hold a whole copy of an artifact is measuring the copy, not the
  discipline. `generatorInlineSizeBudgetBytes` already exists on
  `PipelineConfig` with no CLI flag reaching it; wiring one is #161 and separate.
- The overflow breakdown keeps its shape. The pair now appears under
  "by reference" instead of among the inlined weights — the diagnosis this
  breakdown is for (ADR 0062 decision 4) is what made #269 a ten-minute read,
  and a babysitter must not be sent looking for bytes that are no longer there.
- `contractView` and `acceptanceManifest` stay on `GeneratorEnvelopeInput`, the
  way `proposedContract` stays on the evaluator's and `currentContract` on the
  planner's. `acceptanceManifest` is still read — it is where the file-scope
  projection comes from — and every caller already passes both.

  > **Amended by #284 (2026-09-14).** `contractView` is gone. The generator
  > reads the whole locked contract from `{{SLICE_DIR}}/contract.md`; there is
  > no projected-sections field, no `projectGeneratorContractView`, and no
  > `GENERATOR_CONTRACT_SECTIONS` / `CONTRACT_SECTION_LEVELS` list of the
  > sections a generator is allowed to see. Keeping it contradicted this ADR's
  > own rule below: an envelope must not inline a file the role can open in its
  > own worktree, and a field carrying a *projection* of that file is the same
  > copy with sections filed off. Worse, it was inert — written at both
  > dispatch sites, read at none — and the projection threw on a contract with
  > duplicated projected headings, so a legal contract could kill an accepted,
  > locked slice's generator round while computing a string nobody read.
  >
  > `acceptanceManifest` stays, unchanged and still read, for the reason above.
  > The `contract-view` artifact class, its evidence entry and its
  > `CONTRACT_PAIR_BY_REFERENCE` exemption also stay: they name
  > `{{SLICE_DIR}}/contract.md`, so the by-reference evidence and the overflow
  > breakdown's "by reference" line are what this ADR shipped.
  >
  > The symmetry claimed above turns out to cut the other way: `proposedContract`
  > on `ContractEvaluatorEnvelopeCommonInput` and `currentContract` /
  > `currentAcceptanceManifest` on `PlannerRevisionEnvelopeInput` are write-only
  > too — `contract-prompt-orchestration.ts` forwards them and no assembler
  > reads them. #284 does not remove them, and the difference is not cosmetic:
  > those two are a plain `readFileSync` of a file the round opens anyway, so
  > they waste a read, whereas the generator's was a parser with a throw path,
  > so it wasted a read *and* owned a failure mode. Their removal crosses five
  > input types in `contract-prompt-orchestration.ts` and their orchestrator
  > callers; it wants its own ticket, and the rule to apply when it is written
  > is the one below, not the symmetry sentence above.

**The derived `file-scope` block stays inlined.** It is 837 bytes, it is a
projection of the manifest rather than a copy of a file, and it is the write
boundary the scope gate holds the generator to. The prompt says so explicitly,
so a generator cannot read the boundary as a substitute for the manifest:
"the write boundary above is a projection of it, not a substitute for reading
it."

The repair prompt adds one sentence the initial prompt does not need: a repair
round resumes work, so the contract it remembers from an earlier round may have
been revised since. Reading, not remembering, is the instruction.

## The fourth instance, and the claim that was wrong

- #196 — the contract evaluator inlined the pair (ADR 0062 decision 2).
- #230 — the generator repair round quoted `stuck.md` and `handoff.md` it
  already carried by reference as `repair-context`.
- #265 — the planner revision round inlined the pair (ADR 0066).
- **#269** — the generator, initial and repair.

ADR 0066 wrote, this morning, that the planner revision round "was the
remaining envelope that copied a worktree file into the prompt." That was
wrong, and PRD 5 paid for it eleven hours later. The generalisation was
available at #196 and has been restated three times as a special case.

So state it as a rule rather than an instance: **an envelope must not inline a
file the role can open in its own worktree.** Any new envelope, or any new
artifact class on an existing one, is subject to it. What makes it enforceable
rather than advisory is `renderPrompt`'s symmetry — it refuses an arg the
template does not reference *and* a token no arg supplies — so a class removed
from the prompt and left in the assembler fails a test rather than shipping.

## Consequences

- A slice's contract can grow to whatever its complexity requires without
  buying its generator a `CONFIGURATION` death. #87's pair alone was 63,970
  bytes: under the budget by itself, which is exactly why inlining it looked
  affordable until the round that added the other 8,070 bytes.
- One class of "the pipeline accepted this contract and then refused to
  implement it" is gone. That failure is the most expensive kind to read,
  because nothing about the slice is wrong.
- The generator must now open two files it used to be handed. Cost: two tool
  calls per round. The evaluator has paid it since #196 and the planner since
  #265, and both prompts fail closed — an unreadable path is an escalation with
  the path named, not a silent partial read.
- The #230 repair-round regression test asserted that a #193-shaped round
  *would have overflowed* while quoting files it carried by reference. Two
  thirds of #193's non-situation bytes were this pair (a 14,297-byte contract
  view and an 18,492-byte manifest), so that arithmetic is no longer true. The
  test now measures the de-duplication saving it was always about, and records
  in place why the number changed — a stale premise silently satisfied is worse
  than a red test.
- Cites ADR 0062 (decisions 2 and 4), ADR 0066 (the immediately preceding
  instance, and the claim corrected here), ADR 0038 (the generator's
  verification command, unchanged) and ADR 0008 (the locked contract on disk is
  the authority — which is the whole reason reading it beats being handed a
  copy of it).
