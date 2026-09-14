# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` — run here, exit 0.
`pnpm run typecheck` — skipped under the orchestrator's skip authorization:
gate attempt `dc5a7259-5bc8-4770-ac91-13fb35deac55`, evidence
`.afk/logs/generator-required-input-budget-claude-code/run-20260914-121102/gates/s01/attempt-dc5a72595bc8.json`,
tree `b122d291a4fa39f16e3b846fa3f96e4b9692cb09`. I modified no file under review,
so the authorization holds.

`.afk/artifacts/generator-required-input-budget-claude-code/slice-01/change-summary.json`
does not exist in this worktree. I derived the same facts from git
(`git diff --stat ea08759 HEAD`): the slice changed exactly the ten declared
files' src/docs subset — `src/context-envelope.ts` (+284/-…),
`src/context-envelope.test.ts` (+602), `src/run-events.ts` (+29),
`src/orchestrator.ts` (+63), `src/logger.ts` (+70), `src/logger.test.ts` (+112),
`src/orchestrator-runs.test.ts` (+60), `src/resume-integration.test.ts` (+58),
`docs/adr/0069-the-generator-budget-counts-required-input.md` (+146). Nothing
outside the contract's `Files expected to change` list was touched;
`src/orchestrator.test.ts` is declared and unmodified, which is not a boundary
violation. The two working-tree "modifications" reported by `git status`
(`contract.md`, `acceptance-manifest.json`) are CRLF-normalization only —
`git diff` on them produces no content hunks.

### Behavior verification (probes)

`pnpm vitest run src/context-envelope.test.ts src/logger.test.ts` — 150 tests,
2 files, exit 0.
`pnpm vitest run src/resume-integration.test.ts src/orchestrator-runs.test.ts` —
79 tests, 2 files, exit 0 (305.8s).

Per behavior:

- **B-01** — `GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes` is `98_304`
  (`src/context-envelope.ts:192`). The B-01 test lands the required-input total
  on 98,304 exactly and asserts `98,305` throws with
  `/required-input total 98305 bytes, allowed 98304 bytes/`. No generator path
  asserts 65,536: the six remaining `65_536` literals in
  `src/context-envelope.ts` are the six non-generator manifests (`:72`, `:529`,
  `:592`, `:682`, `:755`, `:833`).
- **B-02** — `referencedWeight` is hoisted above the render and subtracted from
  the commit-log `room` (`src/context-envelope.ts:2394-2399`), and
  `mergeResolutionBlockRoom` reserves the same weight
  (`src/context-envelope.ts:2276-2283`). The B-02 test compares a
  `requiredReadRoot`-less assembly against the same round with accounting and
  asserts the shrink equals the pair size to within one commit entry, while
  `preSlice.assembledByteSize + pairBytes > 98_304` — i.e. the inline-only
  calculation really did overrun.
- **B-03** — `measureRequiredReferencedArtifacts` resolves
  `resolve(requiredReadRoot, artifactId)`; the orchestrator supplies
  `ctx.worktreeDir`, and `absSliceDir = join(worktreeDir, relSliceDir)`
  (`src/orchestrator.ts:1095`), so the resolved path is the real pair path. The
  test checks the reported weight against `Buffer.byteLength` of both fixture
  files, that neither body appears in the prompt, and that a wrong root refuses.
- **B-04** — a read failure throws `ContextEnvelopeConfigurationError` naming
  both artifact id and absolute path; the test asserts all three of those and
  that an absent `stuck.md` repair-context pointer still assembles and is
  excluded from `requiredReferencedArtifacts`.
- **B-05** — `counted: Set<string>` plus the `locator !== undefined` skip. The
  test drives `measureRequiredReferencedArtifacts` directly with a repeated id,
  an inlined duplicate, and a non-required pointer, expecting one weight.
- **B-06** — the five fields are declared optional on the `prompt-assembly`
  payload (`src/run-events.ts:118-140`) and reach it through
  `...assembled.evidence` at `src/orchestrator.ts:5942-5947`, which
  `logger.event` spreads at `src/orchestrator.ts:1157-1161`. The `satisfies
  RunEventPayload` test pins the shape and asserts `assembledByteSize` still
  equals `Buffer.byteLength(result.prompt)` only.
- **B-07** — the refusal message carries all four totals plus
  `required referenced bytes by artifact: <id> <n>, …`, asserted as a contiguous
  substring, with the pre-existing inlined breakdown extended rather than
  replaced.
- **B-08** — `Math.min(override, manifest)` at both the assertion
  (`assembleContextEnvelope`) and the repair-room seam
  (`src/context-envelope.ts:2381-2385`, `:2262-2266`). The test refuses 70,001
  under a 70,000 override, reports `allowedByteSize` 98,304 under a 200,000
  override, and shows the narrow override shrinking the repair round's
  assembled bytes below the wide one's.
- **B-09** — the ADR states the deterministic-lower-bound, retained
  by-reference-transport, no-tokenization-prediction and
  no-agent-chosen-reads claims, and marks ADR 0068 and ADR 0062 decisions 2/4
  **not superseded**. The test asserts each and that the file contains no
  `supersedes`. No ADR index exists in this repo, so nothing else needed
  updating.
- **B-10** — `renderPromptPreparationRefusal` and
  `promptPreparationRefusalSection` are exported from `src/logger.ts:1090`,
  `:1108`, wired at both generator seams through
  `assembleGeneratorRoundEnvelope` (`src/orchestrator.ts:1053-1067`, called at
  `:5891` and `:8098`) and into `Logger.writeSummary` (`src/logger.ts:867-869`).
  Four tests cover the run-log line, the section, the end-to-end
  `writeSummary()` output, and — the honest half — that a non-refusal `ERROR`
  slice is not swept in and a refusal-free run's summary is unchanged.
- **P-01** — the pair keeps `locatorExemption: CONTRACT_PAIR_BY_REFERENCE` and
  no `locator`; the test proves it via the `by reference: acceptance-manifest,
  contract-view` breakdown line and `FILE_SCOPE` still being a manifest
  projection (`not.toContain("LOCKED-CONTRACT-VIEW")`).
- **P-02** — `assertEnvelopeBudget` keeps its pre-#273 branch verbatim when
  `requiredReferenced` is `undefined`, and the test asserts the exact old
  refusal string plus all six non-generator manifest budgets at 65,536.
- **P-03** — the P-03 test overflows a repair round whose commit-log room cannot
  absorb the pair and asserts the refusal still accounts
  `patterns-and-harness 60000` and `repair-situation` at full weight.
- **P-04** — `failureKind === "CONFIGURATION"` and the `CONFIGURATION: ` prefix
  asserted on both the overflow and the missing-artifact throw. The refusal is
  logged before the rethrow and the error leaves `assembleGeneratorRoundEnvelope`
  unchanged.
- **P-05** — both declared seams pass. Each strips the five new fields from a
  *real* event produced by the run under test (first asserting the real event's
  `requiredReferencedByteSize > 0`, so the "before" copy is not a copy of
  itself), replays it, and asserts the prompt-bytes column and total are the
  unchanged `assembledByteSize`. No spawned scenario was added — both reuse an
  existing scenario's fixture, per `AGENTS.md`'s ordering.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The additive-and-optional evidence shape is carried consistently through
`RequiredInputEvidence`, the run-event payload, and the `?? 0` reads, with the
"absence is not zero" rule stated at every seam that could get it wrong.
`requiredReadRoot` as an explicit input rather than a `process.cwd()` assumption
is the right call and is documented where a future caller will see it. The one
generator prompt-preparation seam (`assembleGeneratorRoundEnvelope`) removes the
chance of a third call site forgetting either obligation.

The tests are mutation-sensitive rather than shape-only: the boundary cases are
computed from a probe assembly rather than hardcoded, B-02 compares against a
genuinely-inline-only control, and the P-05 tests explicitly acknowledge and then
close the "a writer that defaulted the field would still pass" gap by asserting
on the stripped event's absent properties.

Only note, not a finding: `assembleContextEnvelope` calls
`requiredReferencedByteSize(required)` twice inside the evidence literal
(`src/context-envelope.ts:1527-1531`) where one local would do. Trivial.

## Resolved findings
- none (no findings were routed into this stage)

## Findings
- none
