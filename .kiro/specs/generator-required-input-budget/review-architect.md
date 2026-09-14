# Architect review — generator required-input budget (round 1)

**Verdict:** ACCEPT-WITH-NOTES

## Scope reviewed

`git diff main...HEAD` (26 files, ~3k insertions), the slice contract and
acceptance manifest under
`.kiro/specs/generator-required-input-budget/slices/01-required-input-budget/`,
`docs/adr/0069-the-generator-budget-counts-required-input.md`, and the
production changes in `src/context-envelope.ts`, `src/orchestrator.ts`,
`src/logger.ts`, `src/run-events.ts`. I re-ran only the narrow seam
(`npx vitest run src/context-envelope.test.ts -t "B-0"` — 33 passed, 56
skipped) and read call sites; I did not re-run the suite.

## What the structure gets right

- **The accounting has exactly one owner.** `measureRequiredReferencedArtifacts`
  is the only filesystem read for byte weights, and its result is threaded
  through the repair-room reservation (`src/context-envelope.ts`, generator
  repair branch, `referencedWeight`) and the budget assertion
  (`assertEnvelopeBudget`) as the same value. The hoisting comment states the
  invariant: measure once so room and assertion cannot disagree. I checked the
  arithmetic — room = budget minus inline-empty minus referenced, and the
  post-block total is inline + referenced <= budget — so the reservation is
  subtracted exactly once and `mergeResolutionBlockRoom` is not double-charged.
- **The role split is preserved without branching at every call site.**
  `assertEnvelopeBudget` keeps its old message and inline-only path when
  `requiredReferenced` is undefined, so P-02 holds by construction rather than
  by six manifests being audited. Required-input accounting is an optional
  input to the shared assembler rather than a generator-only fork of it, which
  is the right shape for ARCHITECTURE.md's single context-envelope component.
- **The additive-evidence rule is stated once and honoured in three places.**
  `RequiredInputEvidence` (all optional, absence is absent and never zero), the
  mirrored optional fields on the `prompt-assembly` payload in
  `src/run-events.ts`, and the spread-only construction in
  `assembleContextEnvelope` mean an older journal cannot acquire a zero.
  `assembledByteSize` keeps its meaning, so the run summary's prompt-bytes
  aggregation in `src/logger.ts` is untouched.
- **No new coupling cycle.** `src/orchestrator.ts` now imports
  `renderPromptPreparationRefusal` from `src/logger.ts`; `src/logger.ts` imports
  nothing from the orchestrator (its context-envelope, preship and
  agent-provider imports are type-only), so the dependency stays
  one-directional.
- **No new reachable failure mode from the required read.** Both generator seams
  read `contract.md` and `loadAcceptanceManifest(ctx.absSliceDir)` immediately
  before assembly, and `absSliceDir = join(worktreeDir, relSliceDir)` is exactly
  what `resolve(requiredReadRoot, artifactId)` reconstructs. A pair the new read
  cannot open would already have thrown a few lines earlier, so B-04 hardens an
  existing invariant instead of adding a way to refuse a healthy round.
- **The ADR narrows rather than supersedes**, and says out loud what the number
  is not (no tokenization, no agent-chosen reads). That is the right register
  for a gate whose credibility depends on not overstating its reach.

## Notes (none blocking)

**A-01 — the merge-resolution room calculation bypasses the new refusal
rendering.** In `runSliceMergeResolution`, `blockBudgetBytes:
mergeResolutionBlockRoom(envelopeInput)` reaches `assembleGeneratorEnvelope`
directly, not through `assembleGeneratorRoundEnvelope`. If the fixed inline
render plus the pair already exceeds the allowance, the
`ContextEnvelopeConfigurationError` is thrown there: no
`renderPromptPreparationRefusal` line reaches `run.log`, and the outer catch
rewraps the message as "The merge resolution round could not run:
CONFIGURATION: ...", whose prefix no longer satisfies
`promptPreparationRefusalSection`'s startsWith test, so the summary section will
not render it either. The breakdown does survive in the `merge-resolution-round`
event detail and the outcome (terminal CONFLICT) is unchanged, so this is a
diagnostics gap in the one path B-10 exists to close, not lost or invalid
state. Routing the room call through the same seam, or matching on the error
type instead of a message prefix, closes it.

**A-02 — `requiredReadRoot` is optional, and omitting it silently buys a round
96 KiB of inline-only room.** When absent, `requiredReferenced` is undefined and
the generator asserts inline-only against the raised 98,304 ceiling: a weaker
bound than the 65,536 it replaced, with no evidence field announcing that the
accounting did not happen. Both current seams pass it; a future third seam that
forgets it fails open and quietly. A required parameter with an explicit
no-worktree sentinel would make the choice unforgettable. The contract decided
the optional form deliberately and documents it, so this is "I would have done
it differently".

**A-03 — the field name now means two things.**
`ContextEnvelopeManifest.inlineSizeBudgetBytes` and
`PipelineConfig.generatorInlineSizeBudgetBytes` mean inline for six roles and
required-input for the generator. The manifest doc comment explains the choice
(shared stricter-only override rule, no config-surface change since #161 is out
of scope) and the ADR records it, which is the right mitigation for a rename
that would touch the public config surface. Still naming drift to retire when
#161 lands.

**A-04 — refusal classification keys off message text.**
`PROMPT_PREPARATION_REFUSAL_PREFIX = "CONFIGURATION: "` in `src/logger.ts` is
matched against `slice.error`. `ContextEnvelopeConfigurationError` is today the
only producer of that leading prefix — I grepped, and the only other occurrence
(`src/ship-gate.ts`) embeds it mid-message and cannot match — so the
classification is correct now. It is still a string coupling to another module's
message format rather than to `failureKind`; a recorded failure kind would make
the section immune to a future reword.

**A-05 — the pair is read twice per round.** The generator seams read
`contract.md` and parse the manifest for projection, then
`measureRequiredReferencedArtifacts` reads both files again for their weights.
Cheap and arguably more honest (it measures what is on disk at assembly time),
but it leaves two reads that could observe different content. Passing the
already-read text in would remove both the duplicate I/O and the skew.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"mergeResolutionBlockRoom refusal bypasses the new run.log and summary refusal rendering, and its rewrapped message defeats the summary prefix match","class":"OBSERVABILITY","clearCondition":"The room calculation's ContextEnvelopeConfigurationError reaches run.log via renderPromptPreparationRefusal and the summary section, or the section matches on failure kind rather than message prefix.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-02","title":"Optional requiredReadRoot silently downgrades the generator to inline-only accounting at the raised 98,304 ceiling","class":"DESIGN","clearCondition":"A generator assembly without required-read accounting cannot be requested by omission (required parameter or explicit sentinel).","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-03","title":"inlineSizeBudgetBytes and generatorInlineSizeBudgetBytes name an inline budget that is a required-input budget for the generator","class":"NAMING","clearCondition":"The generator's allowance is named for what it bounds, once the #161 config surface allows renaming it.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-04","title":"Prompt-preparation refusals are classified by a CONFIGURATION message prefix rather than a structured failure kind","class":"COUPLING","clearCondition":"The summary section selects refused slices from a recorded failure kind instead of the error message text.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-05","title":"The locked pair is read from disk twice per generator round (projection, then byte measurement)","class":"DESIGN","clearCondition":"Byte weights are measured from the content the round already read, or the duplicate read is documented as intentional re-measurement.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true}]}
