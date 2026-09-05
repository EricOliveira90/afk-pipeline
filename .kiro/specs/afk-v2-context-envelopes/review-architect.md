# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

Reviewed `main...HEAD` at `1bbf2d5e77347745ab3e7ea6284b870c48fc6bb2`
against base `817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD, every
available slice artifact, `ARCHITECTURE.md`, and the governing ADRs. I
accepted the recorded pre-ship result and did not rerun the full suite. I
ran only `pnpm vitest run src/post-qa-gates.test.ts`; all six focused tests
passed.

## FIX-BEFORE-SHIP

### A1 — A scope-amendment flag grants evaluator-written bytes orchestrator authority

- **Convention:** ADR 0012, “Fail closed on the tree ID,” requires QA
  authorization to describe the exact tree reviewed. ADR 0048, “The
  orchestrator performs the amendment,” says agents never edit the locked
  file list. ADR 0055, Seam 1 §3, makes the accepted contract pair a
  byte-preserving orchestrator transaction.
- **File and location:** `src/orchestrator.ts`, `runQAStage` at
  `recordValidAttempt` (lines 4006–4013), the amendment/re-grade branch
  (4195–4317), and `runSliceExecute` (5108–5111, 5180–5181, 5231–5245);
  `src/post-qa-gates.ts`, `reviewArtifactViolations` (lines 51–82);
  `src/post-qa-gates.test.ts`, “admits the accepted pair only under explicit
  orchestrator authority” (lines 100–122).
- **Evidence gathered:** I read the full amendment and post-QA control flow,
  inspected the introducing diff and blame, and ran the focused test above.
  After an amendment, `runQAStage` deliberately re-invokes the evaluator,
  but `recordValidAttempt` continues to stamp the attempt with
  `options.candidateTreeId`, the pre-amendment checkpoint. The stage returns
  only `scopeAmended: true`; `runSliceExecute` converts that Boolean into
  unrestricted path exemptions for `contract.md` and
  `acceptance-manifest.json`. `reviewArtifactViolations` then suppresses
  every difference on either path. The passing unit test demonstrates this
  with arbitrary replacement contents (`# Amended` and
  `{"amended":true}`), not bytes captured from the transaction.
- **Concrete failure path:** QA requests a valid scope amendment; the
  orchestrator applies it and starts the required re-grade. During that
  later evaluator invocation, the evaluator accidentally or deliberately
  edits either locked artifact beyond the additive amendment and writes a
  PASS review. The post-QA guard treats all bytes on both paths as
  orchestrator-authorized, the full suite runs, and `commitAll` ships the
  altered pair. The recorded QA attempt still names the pre-amendment tree.
  No later validation restores the transaction's bytes or rejects the
  evaluator-authored changes.
- **Attribution:** Commit `1bbf2d5e` introduced `scopeAmended`, the
  `orchestratorAuthorizedPaths` path waiver, and the test that accepts
  arbitrary changed bytes on those paths. This materially changed the
  authority boundary added in `29f6946c`.
- **Required correction:** Preserve an exact amended-tree ID or exact
  accepted-pair digests immediately after the orchestrator transaction and
  bind the re-grade, post-QA suite, and accepted commit to those bytes.
  Pass typed provenance or a tree/digest comparison, not a Boolean expanded
  into unrestricted path strings. A later evaluator edit to either artifact
  must invalidate the verdict.

## Standards

- `src/orchestrator.ts` grew from 6,193 to 6,507 lines in this diff and still
  owns envelope routing, explorer validation, gate classification, failure
  projection, and tree-authority policy. This conflicts with
  `ARCHITECTURE.md`, “Hubs — do not grow these; extract instead.” The new
  post-QA modules are useful extractions, but the hub remains the integration
  point for several new policies.
- `validateExplorerEvidenceMap` is an inline deterministic refusal in
  `negotiateAttempt`, not a declared gate with evidence. That violates
  `ARCHITECTURE.md`, “Placement rules: A new deterministic check is a gate
  in the catalog.” It fails safely as an `ERROR`, so this is a convention
  note rather than another ship blocker.
- `InvokeOptions.contextEnvelope` carries run-journal metadata through every
  provider even though providers ignore it. ADR 0002 and ADR 0030 define
  providers as command/output adapters. Keeping envelope evidence in an
  orchestration-owned invocation wrapper would make the provider seam deeper.

## Spec

- `ContextEnvelopeManifest` declares itself authoritative, but objective,
  write scope, stop/escalation conditions, and output contract remain
  duplicated in prompt templates; assembly validates only their nonblank
  manifest declarations, not their rendered presence. The current templates
  match, so this is a drift seam rather than an actual shipped mismatch.
- `prompt-assembly` and `invocation-completed` have no invocation-attempt ID.
  After a transient retry, two assembly events and one completion share only
  issue, slice, round, and role. B-05 evidence is still aggregatable because
  the retried prompt is byte-identical, but future per-attempt analysis cannot
  prove the pairing. Add a shared attempt identity before consumers require
  exact joins.
- The diff also expands `clean-failed` to remove clean, merged PASS worktrees
  and branches. ADR 0023 describes cleanup in terms of failed slices. Because
  the branch is already merged and dirty worktrees are preserved, recovery is
  available; document this semantic expansion in its own decision rather
  than leaving it attached to the context-envelope feature.
