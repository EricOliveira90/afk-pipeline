# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

## Commands run

- `pnpm install --frozen-lockfile` — exit 0 (run here; the authorization's install
  ran in a different checkout).
- `pnpm run typecheck` — exit 0. Run directly rather than skipped: I probed
  `src/orchestrator.ts` (see QA-01 below) and the skip authorization is void once
  a file under review is modified. After reverting,
  `git status --porcelain src/ docs/` is empty and typecheck passes on the
  restored tree, so the authorized gate evidence
  (`attempt-b34a1e03b6ad.json`, tree `b9b6ab67feb318dfe9ab761ede471bba6386159c`)
  and my own run agree.
- Probes (permitted here, discarded with this worktree):
  `npx vitest run src/self-audit.test.ts` — 16 passed, exit 0;
  `npx vitest run src/orchestrator.test.ts -t "audited-tree gate re-run call site"`
  — 10 passed, exit 0.

## Resolved findings

- **QA-01 (BLOCKING) — RESOLVED.** The B-02 distinct-path requirement now has a
  test that fails on the regression it exists to catch. The fabricated
  `ROUND_CHECKPOINT_DIR` constant is deleted; the unit test asserts what it can
  observe (`createCheckpoint` called once, with the directory it was handed —
  `src/self-audit.test.ts:499-500`), and distinctness is asserted at the only
  place that decides it: a new `[behavior:#300:B-02]` call-site scan
  (`src/orchestrator.test.ts:8389-8410`) that extracts the `checkpointDir:`
  argument from the `verifyAuditedTree(` call and requires something to remain
  once the round's own binding and the interpolation syntax are struck out.

  Verified by probe, not by reading the commit message. I rewrote
  `src/orchestrator.ts:6502` from `` checkpointDir: `${checkpointDir}-audited`, ``
  to `checkpointDir: checkpointDir,` — the exact reuse that would make
  `createCandidateCheckpoint` throw "target already exists" on every changed-tree
  round — and the scan failed:

  ```
  FAIL src/orchestrator.test.ts > the audited-tree gate re-run call site >
    [behavior:#300:B-02] mints the audited checkpoint at a path of its own
  AssertionError: checkpointDir: expected '' not to be '' // Object.is equality
   ❯ src/orchestrator.test.ts:8409:41
  ```

  Reverted; the tree is byte-identical again (`git status --porcelain src/ docs/`
  empty) and the describe passes 10/10.

- **QA-02 (ADVISORY) — RESOLVED.** The unreachable `createCheckpoint` spy and its
  tautological `toHaveBeenCalledTimes(0)` are gone from the `[behavior:#300:P-01]`
  test. What remains is falsifiable and reachable: with no audited value the
  graded candidate *is* the pre-audit pair, base-gate object included by
  reference (`src/self-audit.test.ts:288-290`). The non-minting claim is carried
  by the B-05 scan, which pins the single `verifyAuditedTree(` call site behind
  its `AUDIT_CHANGED` guard.

- **QA-03 (ADVISORY) — RESOLVED.** `for (const value of [undefined])` is gone.
  The released-pair case is straight-line, and a second, genuinely different
  input is asserted alongside it — the omitted `audited` member the hub actually
  passes on non-changed paths (`src/orchestrator.ts:6612`) — compared against the
  explicit-`undefined` result (`src/self-audit.test.ts:611-628`).

## Boundary compliance

`git diff --stat 63f4593^..HEAD -- src docs prompts` lists exactly the five
declared paths and nothing else:
`src/self-audit.ts`, `src/self-audit.test.ts`, `src/orchestrator.ts`,
`src/orchestrator.test.ts`,
`docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`.
Migration count 0. `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts` and
`src/gate-runner.ts` are untouched (P-04). No amendment is needed.

## Preservation

Counted directly over `src/orchestrator.ts`, matching the contract's B-09/P-06
arithmetic exactly:

| token | count | contract |
| --- | --- | --- |
| `treeId: checkpoint.treeId,` | 1 | exactly 1, the pre-audit gate run (P-06) |
| `candidateTreeId: checkpoint.treeId,` | 2 | exactly 2 (P-02 exhaust, `qaBaseGate`) |
| `qaApprovedTreeId: checkpoint.treeId,` | 0 | 0 |
| `candidateCommitSha: checkpoint.commitSha,` | 0 | 0 |
| `commit: checkpoint.commitSha,` | 0 | 0 |
| `candidateTreeId: gradedCandidate.treeId,` | 2 | exactly 2 (QA dispatch, shared preview) |
| `verifyAuditedTree(` | 1 | exactly 1 |
| `runSelfAuditStage(` | 1 | exactly 1 |

P-01, P-03, P-05 and P-06 are asserted by tests that pass on this tree. ADR 0069
is amended in place (B-11): the "changes nothing downstream" paragraph is
replaced by the cheap-gate re-run, the single graded-candidate identity with its
ADR 0012 reason, and the ordinary-repair-round statement, while `## Decision`,
`## Consequences`, the SwarmForge provenance and the one-invocation bound keep
their text.

## Pass 2 notes

`verifyAuditedTree` builds its base-gate object fresh from the re-run's own
evidence with `candidateTreeId` the audited tree, never a spread and never a
pass-through (`src/self-audit.ts:429-449`), and declares the shape structurally
so no import cycle is introduced. The `REPAIR` branch reuses the existing bounded
repair loop with no new counter (`src/orchestrator.ts:6569-6599`). The
`verifyAuditedTree` unit harness drives a real `runCandidateGatePhase`, so the
pass path's `assertGateEvidenceReleasesEvaluation` and `verifyGateEvidence` run
against genuine artifacts rather than mocks. Nothing material to note.

## Findings

None open.
