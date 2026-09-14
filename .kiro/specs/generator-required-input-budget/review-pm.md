# PM review — generator-required-input-budget

**Verdict:** ACCEPT-WITH-NOTES

Scope reviewed: slice 01 (#273) "Required-input budget" only — the full
manifest.

## What I checked, and how

- **US1 / US3 — required worktree reads count; the limit is 96 KiB.**
  `src/context-envelope.ts:192` declares `inlineSizeBudgetBytes: 98_304` for
  `GENERATOR_CONTEXT_MANIFEST`; `measureRequiredReferencedArtifacts`
  (`src/context-envelope.ts:968-997`) reads each `requiredInFull` artifact from
  `requiredReadRoot` and returns `Buffer.byteLength(content,"utf-8")`;
  `assertEnvelopeBudget` (`:1400-1422`) asserts `inline + referenced` against the
  allowance. I ran `pnpm vitest run src/context-envelope.test.ts -t "#273"` —
  14 tests pass, including `[behavior:#273:B-01]` which lands exactly on 98,304
  (asserting `inlineByteSize` is *below* the old 65,536, i.e. the boundary is
  genuinely made of the pair) and refuses 98,305 with
  `required-input total 98305 bytes, allowed 98304 bytes`. Moving content from
  prompt to file no longer hides it.
- **US2 — the pair stays available by stable worktree path.**
  `assembleGeneratorEnvelope` (`src/context-envelope.ts:2327-2340`) keeps
  `locatorExemption: CONTRACT_PAIR_BY_REFERENCE` with no locator for
  `contract-view` and `acceptance-manifest`; `measureRequiredReferencedArtifacts`
  skips any artifact carrying a locator, so counting did not become inlining.
  `[behavior:#273:B-03]` / `P-01` assert both facts.
- **US4 — a babysitter can tell duplication from slice size.** I saw the real
  rendered text while running `pnpm vitest run src/logger.test.ts -t "B-10"`:
  `CONFIGURATION: Generator prompt exceeds required-input budget: inline 60321
  bytes, required referenced 63970 bytes, required-input total 124291 bytes,
  allowed 98304 bytes (... required referenced bytes by artifact:
  .../contract.md 41230, .../acceptance-manifest.json 22740)`. That is inline,
  referenced, total, allowed, and per-artifact, verbatim, and it now reaches an
  operator: `renderPromptPreparationRefusal` (`src/logger.ts:1093`) is called
  from the single generator seam `assembleGeneratorRoundEnvelope`
  (`src/orchestrator.ts:1051-1067`) before the rethrow, and
  `promptPreparationRefusalSection` (`src/logger.ts:1108`) is spliced into
  `Logger.writeSummary` (`src/logger.ts:867`). The same four totals plus
  per-artifact weights ride the `prompt-assembly` event
  (`src/run-events.ts:138-141`, populated at `src/context-envelope.ts:1524-1536`
  and spread into the event at `src/orchestrator.ts:5942`, `:8108`).
- **US5 — initial and repair mean the same thing.** The repair branch reserves
  `referencedWeight` from the room before `boundRepairSituationCommitLog`
  (`src/context-envelope.ts:2384-2400`), and the merge-resolution block room does
  the same (`:2275-2281`). `[behavior:#273:B-02]` passes against an
  inline-only control.
- **US6 — overrides stricter-only.** `effectiveBudget = min(override, manifest)`
  (`src/context-envelope.ts:1504-1507`) and the repair branch's own
  `Math.min` (`:2381-2385`). `[behavior:#273:B-08]` shows 70,000 becoming the
  effective limit for *both* the assertion and the repair room, and 200,000
  clamping to 98,304.
- **US7 — fail closed.** A missing/unreadable required artifact throws
  `ContextEnvelopeConfigurationError` naming artifact id and path
  (`src/context-envelope.ts:983-991`, `[behavior:#273:B-04]`); only the commit
  log yields (`P-03`); other roles keep inline-only accounting through the
  `requiredReferenced === undefined` branch (`P-02`).
- **Recorded decision.** `docs/adr/0069-the-generator-budget-counts-required-input.md`
  states the deterministic-lower-bound meaning, the retained by-reference
  transport, and the explicit refusal to predict tokenization or later
  agent-chosen reads, narrowing ADR 0068 / ADR 0062 rather than superseding
  them (`[behavior:#273:B-09]`).

Every PRD user story and every Implementation Decision in scope is delivered.
No spawned pipeline scenario was added, matching the Testing Decisions.

## Notes (non-blocking)

- **P-01: an omitted `requiredReadRoot` silently reverts the generator to the
  old, looser accounting.** `assembleGeneratorEnvelope` treats
  `requiredReadRoot === undefined` as "count nothing"
  (`src/context-envelope.ts:2341-2348`), which is what preserves P-02/P-05 for
  out-of-boundary callers such as `src/resume.test.ts`. Today both production
  seams go through `assembleGeneratorRoundEnvelope`, so the operator outcome is
  intact; the residual risk is that a future third generator call site bypassing
  that wrapper would dispatch with an unbudgeted pair and no signal that the
  budget stopped counting. Worth a follow-up that makes the root mandatory (or
  makes "counted nothing" visible in the `prompt-assembly` evidence) when the
  out-of-boundary callers can be edited.

## Out-of-scope PRD gaps

- None. The PRD's own Out of Scope list (other role budgets, behavior-count
  gates, auto-splitting, #161 CLI/config surface) is respected by the branch and
  was not expected here.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"An omitted requiredReadRoot silently returns the generator to inline-only budgeting","class":"PRODUCT","clearCondition":"Either requiredReadRoot becomes mandatory for assembleGeneratorEnvelope's production path, or an assembly that measured no required artifacts is distinguishable in prompt-assembly evidence from one that measured zero bytes, so a future generator call site cannot dispatch unbudgeted without a signal.","disposition":"OPEN"}]}
