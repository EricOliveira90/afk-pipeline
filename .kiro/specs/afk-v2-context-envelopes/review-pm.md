# Product Guardian Review — PRD 3 selected slices

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed the current tree at `29f6946` against the parent PRD and selected
slices 01 (#83), 02 (#90), 03 (#95), and 04 (#99). No manifest slice was
skipped. The pre-ship sanity result was accepted and the full suite was not
rerun.

## Requirement verification

| Slice | Result | Product outcome |
|---|---|---|
| 01 — Generator runs on the focused envelope | **Partial** | The focused initial/repair templates, inline write boundary, six-section contract view, compact open-only failure set, resume data, fail-closed budget, deterministic assembly, reduced handoff, and §3c escalation rules are present. Assembly evidence is not re-journaled immediately before transient retry dispatches. |
| 02 — Explorer four-section evidence map | **Partial** | Four-section validation, the `FACT` / `INFERENCE` / `UNKNOWN` rule, section-level generator projection, optional ADR index, optional `ARCHITECTURE.md`, and provider-captured ordering are present. The explorer is not told to select a matching ADR by title or cite governing ADRs by number. |
| 03 — Planner and contract-evaluator envelopes | Delivered | Initial and revision envelopes are distinct; planner revisions receive open findings only; evaluator revisions receive their prior open findings and exact revision evidence; the planner receives repository context; both roles use the common envelope dispatch and evidence path. |
| 04 — Envelope parity and evidence completeness | **Partial** | Complete scoped manifests, stricter-only budgets, undeclared-class rejection, deterministic provider-independent assembly, stable-ID preservation, exact normal-path invocation evidence, provider token fields, and slice/run totals are present. Transient retries still create provider dispatches without a matching immediately preceding assembly event. |

## Fix before ship

### 1. Add the promised ADR-index usage rule to the explorer envelope

PRD user story 19 and slice #90 promise that the explorer uses the pushed ADR
index to cite governing ADRs by number and reads a full ADR only when its title
matches the slice. Supplying the index without that selection rule does not
deliver the promised no-grep workflow.

- **File and location:** `prompts/explorer.md`, `# Citation rule` through
  `# Repository context` (lines 16–50).
- **What I read:** the prompt defines evidence labels and inserts
  `{{REPOSITORY_CONTEXT}}`, but never tells the explorer to inspect indexed
  titles, open only a matching ADR, or cite a governing ADR by number.
- **File and location:** `src/context-envelope.ts`,
  `assembleExplorerEnvelope` (lines 379–415).
- **What I read:** assembly renders only `prompts/explorer.md` plus the
  repository-context block; no other explorer instruction adds the missing
  ADR behavior.
- **What I ran:** a direct prompt probe found zero occurrences of
  `indexed title`, `title matches`, `matches its slice`,
  `cite governing ADRs by number`, or `ADR index`.

**Clear condition:** Tell the explorer to use the index as pushed selection:
inspect titles, open a full ADR only when a title plausibly governs the slice,
and cite governing ADRs by number. Assert this in the captured provider prompt.

### 2. Journal assembly evidence immediately before every transient retry dispatch

Slice #83 requires the matching `prompt-assembly` event to be the immediately
preceding journal event at provider entry for every dispatch. Slice #99 also
requires envelope evidence for every scoped invocation.

- **File and location:** `src/orchestrator.ts`, `makeSliceContext` local
  `invoke` function (lines 892–974).
- **What I read:** one `prompt-assembly` event is written before entering
  `withTransientRetry`; `provider.invoke` is inside the retry callback.
  `onRetry` writes a `warn` event before the callback is dispatched again.
- **File and location:** `src/transient-retry.ts`, `withTransientRetry`
  (lines 61–74).
- **What I read:** the loop can call `fn()` repeatedly after `onRetry` and
  backoff. The second and later provider calls therefore have the retry warning,
  not their matching assembly event, at the journal tail.
- **What I ran:** a source-order probe confirmed the assembly event is outside
  the retry wrapper, while the provider dispatch is inside it. Existing
  stub-entry assertions cover ordinary one-attempt invocations only.

This also undercounts prompt bytes when one logical role invocation performs
multiple provider dispatch attempts.

**Clear condition:** Emit the matching assembly event inside the retry callback
immediately before each `provider.invoke`, and add a transient-failure stub
scenario that checks the journal tail and evidence count at every attempt.

## Verification performed

- Read the PRD, all slice artifacts, the four GitHub issue bodies, all scoped
  prompt templates, and the implementation/evidence seams.
- Direct source probes established both blocking findings.
- Focused Vitest commands could not start because this review worktree has no
  installed `vitest` binary. Dependencies were not installed because
  `review-pm.md` is the only permitted write. The already-passed pre-ship gate
  remains the test result for this exact tree.
- The full suite was not rerun.

## Out-of-scope PRD gaps

- The live Kiro, Claude Code, and Codex parity matrix remains explicitly
  deferred; slice 04 covers provider-independent assembly and named stubs.
- New assembled prompts for candidate/final evaluators, cleaner, hardener, and
  remediator remain assigned to PRDs 4–6.
- Acceptance and scope gate execution remains PRD 4 work.
