# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `29f6946c2cb9d60f7ffdb7df6e025ac7100927ce`
against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD and all
available slice artifacts, `ARCHITECTURE.md`, and the governing ADRs. I
accepted the recorded pre-ship result and did not rerun the full suite.

## FIX-BEFORE-SHIP

### A1 — The QA tree allowlist includes the locked contract and every other slice artifact

- **Convention:** ADR 0012, “Amendment (2026-09-02) — candidate QA
  precedes the full slice suite,” requires candidate QA and the full suite
  to use the same captured candidate checkpoint. The evaluator may add its
  review artifacts; it may not replace governing inputs and have the later
  suite authorize them.
- **File and location:** `src/post-qa-gates.ts`,
  `reviewArtifactViolations` at lines 27–39 and its pre-suite check at
  lines 121–143; `src/orchestrator.ts`, `runSliceExecute` at lines
  5210–5214 and 5265–5295.
- **Evidence gathered:** I read the changed guard, both call sites, the QA
  prompt write contract, and `src/post-qa-gates.test.ts`. The predicate
  removes every changed path beginning with `ctx.relSliceDir/` from the
  violation set. That directory contains not only `qa-review.json`,
  `uat-review.json`, and the Markdown reports, but also `contract.md`,
  `acceptance-manifest.json`, `context.md`, `handoff.md`, and other
  authority-bearing artifacts. The test proves directory-wide drift is
  accepted but has no case showing that a locked contract or manifest edit
  is rejected.
- **Concrete failure path:** QA runs in the mutable slice worktree. If the
  evaluator accidentally or deliberately edits `contract.md` or
  `acceptance-manifest.json` while writing a PASS review, the post-QA
  checkpoint differs only below `ctx.relSliceDir`, so the guard returns no
  violation. The full suite then runs on the altered contract tree. The
  final guard applies the same directory-wide exemption, and `commitAll`
  commits that tree. The shipped lock can therefore differ from the lock
  the generator implemented and QA judged, with no later recovery.
- **Attribution:** Commit `29f6946c` introduced
  `reviewArtifactViolations`, passed `ctx.relSliceDir` as the allowlist at
  both authority boundaries, and materially changed the previously
  unguarded post-QA control flow.
- **Required correction:** Allow only the exact evaluator/orchestrator
  artifacts expected for the current stage, round, and attempt (plus any
  explicitly restored orchestrator-owned artifact), or isolate QA writes
  from the candidate checkout. Changes to the locked contract, acceptance
  manifest, explorer context, handoff, or source tree must invalidate the
  QA verdict before the full suite and before commit.

## Architecture notes

1. `ContextEnvelopeManifest` is described as the authoritative role
   contract, but `assembleContextEnvelope` still receives an opaque,
   already-rendered prompt. The new locator validation protects artifact
   presence and order, but objective, non-goals, write scope, stop and
   escalation conditions, and output contract remain duplicated in
   `prompts/*.md`. This is a future drift seam under `ARCHITECTURE.md`,
   “Modules > Prompts”; no additional current behavior mismatch was found,
   so it is not a ship blocker.
2. `InvokeOptions.contextEnvelope` carries orchestrator journal metadata
   through the provider interface even though providers ignore it. ADR 0002
   and ADR 0030 define providers as command/output adapters. Keeping this
   evidence wrapper at the orchestration seam would preserve a deeper
   provider interface.
3. `nonCommandTimeMs` is persisted only for invocations carrying
   `contextEnvelope`; candidate QA currently has neither an assembled
   envelope nor an `invocation-completed` record. ADR 0046 calls the metric
   per-invocation evidence, while plan item 5 names evaluator timing as its
   eventual consumer. The candidate-evaluator envelope is deferred to PRD 4,
   so track this as a follow-up rather than blocking PRD 3.
4. Commit `183ddac9` expands `afk clean-failed` to remove clean, merged PASS
   worktrees and branches. ADR 0023 explicitly limits registered state-driven
   cleanup to failure phases and says registered non-failure worktrees are
   skipped. The new path preserves dirty work and deletes only already-merged
   branches, so it is recoverable, but this unrelated command semantic needs
   its own decision record.
