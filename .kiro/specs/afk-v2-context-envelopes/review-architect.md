# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `0060ac61d3363c0af430d84070cf8a9cf190b125` against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD and all slice artifacts, `ARCHITECTURE.md`, and the governing ADRs. I accepted the recorded pre-ship result and did not rerun the full suite. Fresh evidence came from source/diff inspection and narrow `tsx` probes only.

## FIX-BEFORE-SHIP

### A1 — Candidate QA and the full suite authorize different trees

- **Convention:** ADR 0012, “Amendment (2026-09-02) — candidate QA precedes the full slice suite,” requires all steps to use the same captured candidate checkpoint.
- **File and location:** `src/orchestrator.ts`, `runSliceExecute` at lines 4869–4903, 5045–5061, and 5172–5254; `src/orchestrator.ts`, `runQAStage` at lines 3977–3983 and 4001–4056; `src/post-qa-gates.ts`, `runPostQAGates` at lines 80–116.
- **Evidence:** I traced the tree identities through the changed control flow. Pre-QA gates and the QA lifecycle record use the first `checkpoint.treeId`; the evaluator itself runs in the mutable slice worktree. After QA accepts, `runPostQAGates` creates a second checkpoint from that worktree, and the final path commits every remaining change and accepts the current worktree tree ID. There is no equality check between the QA-approved tree and the post-QA tree, nor an allowlist proving that only review artifacts changed. An evaluator source edit can therefore enter the second checkpoint, pass the suite, and be committed even though the PASS verdict is tied to the first tree.
- **Attribution:** Commit `c9a7b5be` introduced the split cheap-check → QA → full-suite sequence; commit `62458b45` introduced the second post-QA checkpoint and materially changed this authority boundary. Both are in the reviewed diff.
- **Required correction:** Run QA against an isolated checkout of the captured candidate and run the full suite against that same tree, copying back only validated review artifacts; alternatively fail closed unless the post-QA tree differs exclusively by an explicit review-artifact allowlist.

### A2 — The explorer envelope removed the required evidence labels

- **Convention:** `ARCHITECTURE.md`, “Placement rules,” says an agent obligation belongs in prompt text when no deterministic gate can enforce it. PRD story 9 and `docs/specs/afk-v2-agent-roles.md`, “Explorer,” require each statement to be distinguishable as `FACT`, `INFERENCE`, or `UNKNOWN`.
- **File and location:** `prompts/explorer.md`, “Citation rule,” lines 16–20; `src/context-envelope.ts`, `validateExplorerEvidenceMap`; `src/context-envelope.test.ts`, explorer B-04 assertions at lines 252–254.
- **Evidence:** I read the prompt, validator, and test. The prompt asks for citations and an Unknowns section but never requires labels; the validator checks headings only; the test explicitly asserts that `FACT`, `INFERENCE`, `UNKNOWN`, and “Label every statement” are absent. Downstream roles therefore cannot reliably distinguish cited facts from uncited inference as the public explorer contract requires.
- **Attribution:** Commit `4b076e13` replaced the old prompt and deleted the exact “Label every statement” rule.
- **Required correction:** Restore the three labels in the explorer prompt and validate or test that generated evidence uses them, while retaining section-level routing.

### A3 — The manifest abstraction can report a contract the prompt does not obey

- **Convention:** `ARCHITECTURE.md`, “Modules > Prompts,” defines assembled envelopes as the PRD 3 public seam. The PRD makes the manifest authoritative for role obligations and input order, and requires run evidence to describe the actual assembled prompt.
- **File and location:** `src/context-envelope.ts`, `ContextEnvelopeManifest` and `assembleContextEnvelope` at lines 647–968; `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST` at lines 544–603.
- **Evidence:** The assembler accepts an already-rendered opaque prompt, validates only manifest shape and declared classes, then sorts the evidence records into manifest order without deriving or checking prompt order. A narrow probe passed prompt text `SECOND BEFORE FIRST` with artifacts supplied second-first; assembly returned that prompt unchanged while reporting classes and IDs first-second. The manifest’s objective, non-goals, write scope, stop/escalation conditions, and output contract are otherwise used only for nonblank validation, so template drift is invisible to assembly.

  The first manifest added through this abstraction already demonstrates that drift: the candidate-evaluator manifest includes `candidate-handoff` and `dependency-sibling-handoffs`, although the parent design’s M7 excludes handoffs from every reviewer, and it omits the required acceptance manifest, change summary, and explorer evidence described by plan item 5 and the candidate-evaluator design.
- **Attribution:** Commit `0060ac61` introduced the complete-manifest claim, evidence sorting, and candidate-evaluator manifest.
- **Required correction:** Assemble prompt blocks and evidence from one ordered manifest/artifact representation, or validate the rendered block order before emitting evidence. Correct the candidate-evaluator manifest to the governing include/exclude contract, including change summary, acceptance manifest, and explorer preservation evidence, with handoffs excluded.

### A4 — `nonCommandTimeMs` records time outside its documented clock boundary

- **Convention:** ADR 0046, “Amendment (2026-09-05): per-invocation non-command time,” defines the measurement as process spawn through successful exit minus attributable command intervals, and requires unavailable or incomplete attribution to be omitted.
- **File and location:** `src/invocation-runtime.ts`, `settle` at lines 194–201, the exit handler at lines 371–410, and `createCommandTimeTracker.end` at lines 95–104; `src/agent-provider.ts`, `InvocationStats.nonCommandTimeMs`.
- **Evidence:** `settle` calls provider `onSettled` cleanup before the exit handler computes `Date.now() - invocationStartedAt`, so post-exit cleanup is counted as model time. A narrow invocation with a 250 ms `onSettled` delay reported `nonCommandTimeMs: 379` for a process whose command attribution was zero. A second probe called `end("missing")`; `totalMs()` returned `0`, so an unmatched completion is treated as complete zero command time instead of unavailable attribution. Both paths persist misleading ROI evidence and have no later recovery.
- **Attribution:** Commit `0060ac61` introduced the timer, tracker semantics, and ADR amendment.
- **Required correction:** Capture the wall-clock end timestamp immediately when successful process exit is observed, before cleanup, and poison attribution when an end record has no matching start.

## Non-blocking architecture notes

1. Commit `183ddac9` expands `afk clean-failed` to remove clean, merged PASS worktrees and branches. ADR 0023 explicitly says registered non-failure worktrees are skipped. The new path is guarded by cleanliness and merge state, so recoverable work is not lost, but this unrelated destructive-command semantic should receive its own ADR or separate change.
2. `InvokeOptions.contextEnvelope` is control-plane evidence that every provider intentionally ignores. ADR 0002 and ADR 0030 keep providers focused on dispatch/runtime concerns; recording this metadata through a dedicated orchestration invocation result would avoid a provider-interface parameter that silently does nothing for direct callers.
