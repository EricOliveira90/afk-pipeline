# Slice Contract — Enforce the generator required-input budget

**Parent PRD:** .kiro/specs/generator-required-input-budget/prd.md
**GH issue:** #273
**Status:** LOCKED

**Lock-Provenance:** negotiation round 3
**Negotiation round:** 2

## Scope lock

Replace the generator's 65,536-byte inline-only budget assertion with one
98,304-byte *required-input* assertion that covers both the initial and the
repair round. Required input is the assembled inline prompt plus the exact
UTF-8 byte size of each distinct artifact the generator prompt requires it to
read in full — today the locked contract pair (`contract.md` and the acceptance
manifest), which keeps travelling by worktree reference (ADR 0068) but stops
counting as zero bytes. The assertion reads those artifacts from the worktree,
fails prompt preparation as `CONFIGURATION` when one is missing or unreadable,
counts one logical artifact at most once, reserves the referenced weight before
computing the repair situation's commit-log room (#230), keeps project overrides
stricter-only, and reports inline / referenced / required-input / allowed
totals plus per-artifact referenced weights in both the `prompt-assembly` run
event and the overflow diagnostics. An ADR records the new budget meaning and
narrows only the inline-only reading of the earlier by-reference decisions. No
other role's budget changes.

### In scope

- [behavior:B-01] The generator's effective allowance is a required-input total
  of 98,304 bytes: `GENERATOR_CONTEXT_MANIFEST` (`src/context-envelope.ts:181`)
  declares 98,304 in place of `inlineSizeBudgetBytes: 65_536`, and an initial
  round whose inline prompt bytes plus distinct required referenced artifact
  bytes total exactly 98,304 assembles, while a total of 98,305 throws
  `ContextEnvelopeConfigurationError` (`src/context-envelope.ts:1113-1118`)
  before dispatch. (GH #273 AC1; PRD "Implementation Decisions" 1-2.)
- [behavior:B-02] A repair round enforces the same 98,304-byte required-input
  total, and the repair-evidence room computed in
  `assembleGeneratorEnvelope`'s repair branch (`src/context-envelope.ts:2119-2166`)
  subtracts both the fixed inline render and the required referenced weight
  before `boundRepairSituationCommitLog` bounds the commit log. (GH #273 AC2;
  PRD "Implementation Decisions" 5.)
- [behavior:B-03] The `contract-view` and `acceptance-manifest` artifacts wired
  at `src/context-envelope.ts:2196-2204` each contribute the exact
  `Buffer.byteLength(content, "utf-8")` of the file at their worktree path to
  the generator's required-input total, while keeping their
  `locatorExemption: CONTRACT_PAIR_BY_REFERENCE` transport. Because those
  artifact ids are worktree-relative (`ctx.relSliceDir`, `src/orchestrator.ts:5840`),
  `assembleGeneratorEnvelope` takes the absolute root the required-read paths
  resolve against as a new input, supplied by the generator call sites at
  `src/orchestrator.ts:5838` and `src/orchestrator.ts:7956` — decided here as
  an explicit input rather than a `process.cwd()` assumption, since the
  orchestrator dispatches from outside the slice worktree. (GH #273 AC3.)
- [behavior:B-04] A required referenced artifact that is missing or unreadable
  fails prompt preparation with `ContextEnvelopeConfigurationError` naming the
  artifact id and path, and never contributes zero bytes. Only artifacts AFK
  declares as required-in-full are read: the locked contract pair. The
  `repair-context` references (`additionalArtifactIds`,
  `src/context-envelope.ts:2192-2195`) stay zero-weight pointers the prompt
  points at rather than requires in full — decided here because counting a
  pointer would also make an absent `stuck.md`/`handoff.md` a hard
  configuration failure. (GH #273 AC4; PRD "Implementation Decisions" 3.)
- [behavior:B-05] One logical artifact contributes at most once: the existing
  `(artifactClass, artifactId)` de-duplication at
  `src/context-envelope.ts:2233-2241` is joined by required-read accounting
  that adds no second weight for an artifact id already counted and no
  referenced weight for content already inlined via `contentLocator`
  (`src/context-envelope.ts:875`). (GH #273 AC5; PRD "Implementation
  Decisions" 4.)
- [behavior:B-06] The `prompt-assembly` run event (`src/run-events.ts:95-113`)
  additively records the assembled inline byte weight, the required referenced
  weight, the required-input total, the allowed total, and each required
  referenced artifact's id with its byte weight, journaled at
  `src/orchestrator.ts:1104-1108` before dispatch as today. Existing fields keep
  their current meaning, `assembledByteSize` included: it is the inline
  assembled weight that `src/logger.ts:472` sums into the run summary's prompt
  bytes column (`total.promptBytes += event.assembledByteSize;`), and the new
  referenced weight is a separate field rather than an addition to it. The new
  fields are additive and optional on read, so a reader that finds them absent
  treats them as absent and never as zero, matching the rule already stated for
  this event at `src/logger.ts:465-466`. (GH #273 AC6; PRD "Implementation
  Decisions" 6.)
- [behavior:B-07] The overflow `CONFIGURATION` message produced from
  `assertEnvelopeBudget` (`src/context-envelope.ts:1242-1256`) and its
  breakdown (`envelopeArtifactByteBreakdown`, `src/context-envelope.ts:1205-1240`)
  reports the same inline, referenced, required-input, and allowed totals plus
  per-artifact referenced weights, asserted on the thrown
  `ContextEnvelopeConfigurationError`'s `message` in
  `src/context-envelope.test.ts`. (GH #273 AC7; PRD "Implementation
  Decisions" 6, 8.)
- [behavior:B-08] `PipelineConfig.generatorInlineSizeBudgetBytes`
  (`src/orchestrator.ts:546`) stays stricter-only against the new ceiling: an
  override below 98,304 becomes the effective required-input limit for both the
  assertion and the repair-room calculation, and an override above 98,304 is
  clamped to 98,304, extending the existing
  `min(override, manifest budget)` rule (`src/context-envelope.ts:1289-1294`,
  `:2148-2151`, `:2253-2255`). (GH #273 AC8; PRD "Implementation Decisions" 2.)
- [behavior:B-09] `docs/adr/0069-the-generator-budget-counts-required-input.md`
  records the decision: generator required-input bytes are a deterministic
  lower bound on mandatory starting context, authoritative contract artifacts
  keep by-reference transport, and AFK does not predict provider tokenization
  or budget later agent-chosen reads. It narrows only the inline-only budget
  interpretation of ADR 0068 (`docs/adr/0068-the-generator-names-its-locked-pair.md`)
  and ADR 0062 decision 2/4
  (`docs/adr/0062-a-contract-revision-round-carries-its-delta-and-names-its-pair.md`),
  superseding neither wholesale. The ADR assertion lives in
  `src/context-envelope.test.ts`, beside the budget behavior it records, since
  that file is this slice's home for generator budget semantics. (GH #273 AC10;
  PRD "Implementation Decisions" 9.)
- [behavior:B-10] **This slice adds the recording path that carries B-07's text
  into `run.log` and `run-summary.md`; that path does not exist today.** The
  declared evidence found no `ContextEnvelopeConfigurationError` or
  `CONFIGURATION` call site in `src/orchestrator.ts`, and the run summary's
  slice table renders a slice's recorded `error` only for
  `AWAITING-ADJUDICATION` (`src/logger.ts:502-507`), so an `ERROR` slice's
  refusal text reaches neither artifact. Two named additions in files already in
  scope close AC7. First, `renderPromptPreparationRefusal(sliceTag, message)`, a
  new exported function in `src/logger.ts` returning the whole retained refusal
  text as one run-log entry, called from both `assembleGeneratorEnvelope` call
  sites in `src/orchestrator.ts` — `:5838`, which assembles the initial round and
  an ordinary repair round through a `mode` variable, and `:8041`, the
  merge-resolution round's `dispatchGenerator` — through `logger.phase`
  — `RunJournal.phase` (`src/run-journal.ts:89-103`) is what appends to
  `run.log` — which then rethrows the error unchanged, so the existing terminal
  outcome path at `src/wave.ts:534-542` is untouched (P-04). Second,
  `promptPreparationRefusalSection(slices)`, a new exported function in
  `src/logger.ts` that `Logger.writeSummary` (`src/logger.ts:860-875`) includes
  in the summary it writes, rendering the full recorded message for every
  `ERROR` slice whose error carries the `CONFIGURATION: ` prefix. Neither
  function omits, truncates, or summarizes; both are asserted in
  `src/logger.test.ts`. Decided here rather than escalated because GH #273 AC7
  states the obligation and both files are already in this slice's scope. (GH
  #273 AC7; PRD "Implementation Decisions" 6, 7.)

### Non-goals (explicit out-of-scope)

- Changing the planner, explorer, evaluator, cleaner, hardener, remediator, or
  guardian budget value or accounting.
- A contract-lock gate for pair size or behavior count, or any behavior-count
  deliverability threshold.
- Automatically splitting a slice, or asking the planner to shorten required
  behavior or evidence.
- Predicting provider token counts, or bounding agent-chosen tool reads after
  dispatch.
- The separate #161 CLI and configuration surface for budget overrides.
- Reversing or altering the generator pair-by-reference transport (#269/#270).
- Adding a spawned pipeline scenario for any of the above.

### Existing behavior to preserve

- [behavior:P-01] The locked pair travels by reference:
  `CONTRACT_PAIR_BY_REFERENCE` (`src/context-envelope.ts:1488-1490`) stays the
  `locatorExemption` for `contract-view` and `acceptance-manifest`, and
  `assembleGeneratorEnvelope` (`src/context-envelope.ts:2088-2258`) still
  inlines neither file — `FILE_SCOPE` remains the manifest projection it is
  today (ADR 0068; ADR 0062 decision 2).
- [behavior:P-02] Every other role's budget behavior is unchanged:
  `assertEnvelopeBudget` / `assembleContextEnvelope`
  (`src/context-envelope.ts:1242-1256`, `:1296+`) keep inline-only accounting
  and their declared `inlineSizeBudgetBytes` for the manifests at
  `src/context-envelope.ts:72`, `:506`, `:569`, `:659`, `:732`, and `:810`;
  required-input accounting applies to the generator only (PRD
  "Implementation Decisions" 8).
- [behavior:P-03] Prompt preparation stays fail-closed: required contract,
  acceptance-manifest, finding, gate-evidence, and repair content are never
  omitted, summarized, or truncated to fit. The only block that yields is the
  repair situation's commit log via `boundRepairSituationCommitLog` (#230), and
  an overflow that room cannot absorb still refuses dispatch rather than
  shortening an accepted contract (PRD "Implementation Decisions" 7).
- [behavior:P-04] `ContextEnvelopeConfigurationError` keeps
  `failureKind = "CONFIGURATION"` and its `` `CONFIGURATION: ${message}` ``
  prefix (`src/context-envelope.ts:1113-1118`), so the existing generic
  failure-recording path in `src/logger.ts` continues to classify a refused
  assembly exactly as it does today. B-10's run-log line is emitted before the
  rethrow and changes neither the thrown type, the message, nor the terminal
  outcome the wave records from it.
- [behavior:P-05] A `prompt-assembly` event journaled before this slice stays
  readable: because B-06's fields are additive and optional, replaying a run
  directory whose events carry only the pre-slice field set produces the same
  resume decision and the same run-summary prompt-bytes aggregation as it does
  today, with the absent referenced weight read as absent rather than as zero
  (`src/logger.ts:465-466`). Asserted at the declared
  `src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts` seams,
  which is what those two scoped files are for. This is why the contract makes no
  claim about a manifest version bump distinguishing an older event: the
  distinction that matters is field presence, which a reader can see directly.

### Changes to existing behavior (only if the issue asks for it)

- `GENERATOR_CONTEXT_MANIFEST`'s budget rises from 65,536 to 98,304 and changes
  meaning from inline-only to required-input, per GH #273 "What to build".
- By-reference artifacts declared required-in-full stop contributing zero bytes
  to the generator's budget, per GH #273 AC3 — this narrows ADR 0068's
  inline-only budget reading and is recorded in the new ADR (B-09).
- The `prompt-assembly` run event and the overflow `CONFIGURATION` message gain
  additive byte-accounting fields, per GH #273 AC6-AC7. The event's new fields
  are optional on read, so an event journaled before this slice stays readable
  and its absent referenced weight is read as absent, not as zero (P-05).
- `run.log` and `run-summary.md` gain a prompt-preparation refusal rendering
  they do not have today, per GH #273 AC7 — the two functions and their call
  sites are named in B-10. Nothing else about failure recording changes.

## Files expected to change

- `src/context-envelope.ts`
- `src/context-envelope.test.ts`
- `src/run-events.ts`
- `src/orchestrator.ts`
- `src/orchestrator.test.ts`
- `src/orchestrator-runs.test.ts`
- `src/resume-integration.test.ts`
- `src/logger.ts`
- `src/logger.test.ts`
- `docs/adr/0069-the-generator-budget-counts-required-input.md`

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- A required-read declaration on generator context artifacts: an artifact
  carrying `locatorExemption` may additionally be marked as required-in-full,
  which makes its on-disk UTF-8 size count toward the generator's
  required-input total. No new dependency; sizing stays
  `Buffer.byteLength(text, "utf-8")` with no tokenizer.
- An additive, optional-on-read `prompt-assembly` event field set (inline
  weight, referenced weight, required-input total, allowed total, per-artifact
  referenced weights). Absence means "not counted by that writer", never zero.
- Two new exported rendering functions in `src/logger.ts`
  (`renderPromptPreparationRefusal`, `promptPreparationRefusalSection`) that
  carry a prompt-preparation `CONFIGURATION` refusal into `run.log` and
  `run-summary.md` verbatim (B-10).

## Test plan

All new tests are unit tests at the existing `src/context-envelope.test.ts` and
`src/logger.test.ts` seams, except P-05's older-journal replay, which belongs at
the existing `src/resume-integration.test.ts` / `src/orchestrator-runs.test.ts`
seams because that is where a journal is read back. No spawned pipeline scenario
is added; P-05 reuses an existing scenario's fixture rather than adding one, per
`AGENTS.md`'s ordering. Each test
name begins with its behavior ID so `--testNamePattern <id>` selects it.

- Given a generator initial round whose inline prompt plus the on-disk contract
  pair totals exactly 98,304 bytes, when the envelope is assembled, then it
  returns and reports a required-input total of 98,304; at 98,305 it throws
  `CONFIGURATION` (B-01).
- Given a generator repair round with a long commit log and a large referenced
  pair, when the envelope is assembled, then the bounded commit log fits the
  room left after the fixed inline render *and* the referenced weight, and the
  round's required-input total never exceeds 98,304 (B-02).
- Given contract and manifest files of known sizes on disk, when the generator
  envelope is assembled, then the reported referenced weight equals the sum of
  their exact UTF-8 sizes and neither file appears inline in the prompt
  (B-03, P-01).
- Given the acceptance manifest is deleted (or unreadable), when the generator
  envelope is assembled, then it throws `CONFIGURATION` naming the artifact and
  path, rather than counting zero bytes (B-04, P-04).
- Given duplicate artifact entries for one logical artifact and content also
  present inline, when the envelope is assembled, then that artifact's weight
  is counted once (B-05).
- Given a successful generator assembly, when the `prompt-assembly` event is
  journaled, then it carries inline, referenced, required-input, and allowed
  totals plus one `{ artifactId, byteSize }` entry per required referenced
  artifact (B-06).
- Given an overflowing generator round, when `assembleGeneratorEnvelope` throws,
  then the `ContextEnvelopeConfigurationError`'s `message` carries the same four
  totals and per-artifact weights, with no required content truncated
  (B-07, P-03).
- Given that message, when `renderPromptPreparationRefusal` renders it and
  `promptPreparationRefusalSection` renders an `ERROR` slice recorded with it,
  then both outputs contain the message verbatim — every total and per-artifact
  weight, nothing elided (B-10, P-03). In `src/logger.test.ts`.
- Given a run directory whose journaled `prompt-assembly` events carry only the
  pre-slice field set, when the run is resumed and its summary written, then the
  resume decision and prompt-bytes aggregation are unchanged and the absent
  referenced weight is never read as zero (P-05). In
  `src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts`.
- Given `generatorInlineSizeBudgetBytes` of 70,000, when a round totals 70,001
  required-input bytes, then assembly is refused and the repair room is
  narrowed to the override; given an override of 200,000, then the effective
  limit stays 98,304 (B-08).
- Given the repository, when the ADR file is read, then it states the
  lower-bound meaning, the retained by-reference transport, and the
  no-tokenization-prediction limit, and names ADR 0068 and ADR 0062 as narrowed
  rather than superseded (B-09). In `src/context-envelope.test.ts`.
- Given each other role's envelope with an unchanged manifest budget, when it
  is assembled at its own boundary, then its pass/fail byte behavior is
  identical to before this slice (P-02).

## Definition of done

- [ ] `GENERATOR_CONTEXT_MANIFEST` declares a 98,304-byte required-input budget
      and no generator code path asserts against 65,536.
- [ ] Initial and repair generator rounds both enforce the required-input total,
      with repair room computed after reserving inline and referenced bytes.
- [ ] The locked pair is counted at its exact on-disk UTF-8 size while still
      travelling by reference.
- [ ] A missing or unreadable required artifact refuses assembly as
      `CONFIGURATION` naming artifact and path.
- [ ] One logical artifact is counted at most once.
- [ ] `prompt-assembly` events and overflow `CONFIGURATION` text both carry
      inline, referenced, required-input, and allowed totals plus per-artifact
      referenced weights.
- [ ] `renderPromptPreparationRefusal` and `promptPreparationRefusalSection`
      exist in `src/logger.ts`, are wired at the two generator assembly seams
      and into `Logger.writeSummary`, and reproduce the refusal text verbatim.
- [ ] A journal written before this slice still resumes and still aggregates,
      with the new event fields read as absent rather than zero.
- [ ] Overrides remain stricter-only against 98,304 in both directions.
- [ ] Other roles' manifests and inline-only accounting are byte-for-byte
      unchanged in behavior.
- [ ] The ADR exists with the three required statements and narrows ADR 0068 /
      ADR 0062 without superseding them wholesale.
- [ ] Every behavior above has a uniquely named unit test; no spawned pipeline
      scenario was added.
- [ ] `pnpm run typecheck` and the tests covering the files in scope pass.
