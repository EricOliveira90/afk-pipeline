# Handoff — #284, the unread generator contract view

Branch: `fix/284-drop-contract-view` (pushed to `origin`, no PR opened).

## What changed

`src/context-envelope.ts`

- Deleted `projectGeneratorContractView` and its two now-orphaned module
  constants, `GENERATOR_CONTRACT_SECTIONS` and `CONTRACT_SECTION_LEVELS`.
  Nothing else referenced either constant.
- Deleted `GeneratorEnvelopeInput.contractView`, replacing it with a comment
  saying why the contract is not an input and why `acceptanceManifest` still is.
- Reworded the `assembleGeneratorEnvelope` comment that named `contractView` as
  a field.

`src/orchestrator.ts`

- Dropped the `projectGeneratorContractView` import and both
  `contractView: projectGeneratorContractView(contract)` writers (the
  implementation-round dispatch and the merge-resolution dispatch).
- Dropped the two `const contract = readFileSync(join(ctx.absSliceDir,
  "contract.md"), "utf-8")` reads that fed only those writers.

`src/context-envelope.test.ts`

- Removed 17 `contractView:` fixture keys and deleted the test that asserted
  the projected value byte-for-byte ("B-02 projects the six complete contract
  section bodies byte-for-byte") along with its contract fixture.
- Dropped the `not.toContain("LOCKED-CONTRACT-VIEW")` guards, which lose their
  subject once no input can carry the string, and recorded why in place.
- Renamed the #269 size fixture's `contractView` to `contractFileBytes`: it now
  stands for the contract file on disk, which is what its arithmetic measures.
- Fixed an assertion that was already passing for the wrong reason: the
  rendered-order test compared `indexOf("LOCKED-CONTRACT-VIEW")` against
  `indexOf("PATTERNS-AND-HARNESS")` in a prompt that has not contained the
  first string since #269, so both operands were `-1`. It now compares the
  inlined `file-scope` block, and asserts that block is present first.

`src/resume.test.ts`

- Removed the one `contractView:` fixture key.

`docs/adr/0068-the-generator-names-its-locked-pair.md`

- Added an `> **Amended by #284**` blockquote under the bullet that said
  `contractView` stays. It states that the generator reads the whole contract
  from `{{SLICE_DIR}}/contract.md`, cites the ADR's own rule that an envelope
  must not inline a file the role can open in its own worktree, records the
  deleted throw path, and confirms `acceptanceManifest` and the `contract-view`
  artifact class are untouched.

## What was left alone, deliberately

- The `contract-view` artifact class in `GENERATOR_CONTEXT_MANIFEST`, its
  `inputOrder` entries, its evidence entry and its `CONTRACT_PAIR_BY_REFERENCE`
  locator exemption. Verified: the entry keys off `${input.sliceDir}/contract.md`,
  never `input.contractView`, so the by-reference evidence, the
  `includedArtifactIds` ordering assertions and the overflow breakdown's
  "by reference: acceptance-manifest, contract-view" line are all unaffected.

## Also changed

`docs/specs/afk-v2-agent-roles.md` never repeated the projected-sections claim,
so there was nothing to correct. But #284's clear condition names this file as a
place that must *state* the generator reads the whole contract, and the closest
it came was the prompt skeleton's "Read `{{SLICE_DIR}}/contract.md`". Added a
§4 decision bullet saying it outright, and distinguishing the contract (one
indivisible artifact the round opens) from the explorer evidence map (which is
still routed by section, per §1).

## Symmetry audit (asked for before amending the ADR)

ADR 0068 justified keeping `contractView` by symmetry with `proposedContract`
on the evaluator's envelope. Audited: `proposedContract` on
`ContractEvaluatorEnvelopeCommonInput`, and `currentContract` /
`currentAcceptanceManifest` on `PlannerRevisionEnvelopeInput`, are **also
write-only**. `src/contract-prompt-orchestration.ts` forwards them (lines
~155, ~197, ~230, ~336, ~379) and no assembler in `src/context-envelope.ts`
reads them — `context-envelope.ts` mentions them only in type declarations and
in a comment that says they are not rendered.

So the symmetry holds, and it argues for removing all three. #284 removes only
the generator's. The ADR amendment says so and says why: the other two are a
wasted `readFileSync` of a file the round opens anyway, while the generator's
was a parser with a throw path, so it wasted a read *and* owned a failure mode;
and removing them crosses five input types plus their orchestrator callers.
**That is unticketed work — it needs its own issue.**

## Verified

- `pnpm run typecheck` — clean, no output, exit 0.
- `pnpm vitest run src/context-envelope.test.ts` — 74 passed, 1 file, exit 0.
- `pnpm vitest run src/resume.test.ts` — 54 passed, 1 file, exit 0.
- `pnpm vitest run src/prompt-template.test.ts` — 20 passed, exit 0. Run
  because it asserts `renderPrompt`'s arg/token symmetry for the generator
  templates.

## Verification still owed

- The full `pnpm test`. An AFK self-run was live on the host, so heavy suites
  and `test:fast` were off limits (host contention would corrupt its timings).
  `src/orchestrator.test.ts` and `src/orchestrator-runs.test.ts` spawn the two
  dispatch paths whose `readFileSync(contract.md)` calls were deleted; they are
  the runs most likely to catch a mistake here and they have **not** been run.
- `pnpm test:budgets` / `pnpm test:ratchet`. No spawned scenario was added, and
  one test file's worth of assertions was deleted rather than added, so the
  budget can only have moved down — but that is an inference, not a measurement.
