# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here and exited 0. `pnpm run typecheck` is
covered by the orchestrator's skip authorization (gate attempt
`018b67df-2ef1-430f-b6ae-b0712d8289d2`, evidence
`.afk/logs/generator-self-audit-gate-claude-code/run-20260915-171050/gates/s02/attempt-018b67df2ef1.json`,
tree `3c0ea1e2486dc815ec55976755af2f812db6e75d`, PASS at 2026-09-15T21:15:49Z) —
and because one probe below edited a file under review, I re-ran
`pnpm run typecheck` myself after reverting it: exit 0, no diagnostics, and
`git status --porcelain -- src/` clean.

**Boundary.** The four slice commits (`63f4593`, `1f000c4`, `10a7d4e`,
`fdbc90b`) touch exactly the five declared paths — `src/self-audit.ts`,
`src/self-audit.test.ts`, `src/orchestrator.ts`, `src/orchestrator.test.ts`,
`docs/adr/0069-…md` — plus this slice's own artifact directory under
`.kiro/specs/generator-self-audit-gate/slices/02-changed-tree-gates/`, which the
pipeline owns. No migration file; migration count 0. No scope amendment is
needed.

**Intent.** Each behavior was checked against the source, not only against its
test name:

- B-01: `src/self-audit.ts:204-213` records both graded verdicts; `AUDIT_NOT_RUN`
  stays unrecorded. Observed green.
- B-02/B-04/B-10: `verifyAuditedTree` (`src/self-audit.ts:395-450`) mints,
  registers before `runGates`, and on a pass asserts
  `assertGateEvidenceReleasesEvaluation` + `verifyGateEvidence` over the re-run's
  own evidence and the audited tree id before building the base-gate object
  fresh. Evidence artifact ids are repo-relative and forward-slashed.
- B-03: the filter is an intersection with the round's own `preQaDeclarations`,
  returning the same objects. `resolveCheapGateCatalog` excludes
  `FULL_SUITE_GATE_IDS` and any declaration without `expectedCostMs`
  (`src/base-gates.ts:154-174`), so `tests` and `acceptance:behaviors` cannot
  enter the re-run set — the named non-goal holds by derivation, not by a list.
- B-05/B-07: `verifyAuditedTree(` occurs once, between `runSelfAuditStage(`
  (index 257893) and the first `await runQAStage(` (index 266505); that region
  contains zero `logger.bumpEvalRound(` occurrences and no `round` increment
  (independently counted, not just asserted by the test).
- B-06: I diffed the audited-failure references against the pre-audit branch at
  `src/orchestrator.ts:6355-6404`. The shapes match byte for byte — de-duplicated
  absolute evidence paths plus `join(evidenceDir, logArtifactId)`, both
  forward-slashed. No new counter, no new terminal exit, and correctly no
  `bumpEvalRound` (the audit spends no round).
- B-09: independent token counts over `src/orchestrator.ts` —
  `gradedCandidate.baseGate,` ×1, `candidateTreeId: gradedCandidate.treeId,` ×2,
  `qaApprovedTreeId: checkpoint.treeId,` / `candidateCommitSha: checkpoint.commitSha,`
  / `commit: checkpoint.commitSha,` ×0, `treeId: checkpoint.treeId,` ×1 and
  `candidateTreeId: checkpoint.treeId,` ×2, all before the audit index. The only
  post-audit textual mentions of `checkpoint.` are a comment (`:7214`) and the
  `finally` cleanup (`:8059`).
- B-11: the ADR's `Consequences` bullet is replaced in place; decision,
  provenance, `swarm_handoff.sh` and the one-invocation bound survive, and
  "changes nothing downstream" is gone.

**Downstream consistency, checked rather than assumed.** The audited base-gate
object vouches only for the selected subset, and `authorizeBaseGateSkip`
(`src/qa-gate-authorization.ts:105-157`) matches the audited tree id on both the
envelope and every per-gate result, so the evaluator still runs everything else.
`runPostQAGates` receives `qaApprovedTreeId: gradedCandidate.treeId` alongside
`priorAttemptTreeIds: implementationCandidateTreeIds` whose last entry is the
audited tree, which is what `post-qa-gates.ts:272`'s `.slice(0, -1)` needs.
Evidence artifact filenames are `attempt-<uuid>.json`
(`src/gate-runner.ts:464-465, :960`), so re-using the round's `evidenceDir` for
the audited run cannot overwrite the pre-audit artifact. I also checked the
degenerate case where the audit rewrites the project's scripts so the catalog
names fewer required gates: the selected set shrinks, and an empty set makes
`authorizeBaseGateSkip` refuse ("no base gate had an executable command"), so QA
runs the gates itself. It fails safe.

**Preservation.** `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts`,
`src/gate-runner.ts` and `src/run-state.ts` are unedited (P-03, P-04). P-01,
P-02, P-05 and P-06 are asserted and green:
`pnpm vitest run src/self-audit.test.ts` → 16 passed, exit 0;
`pnpm vitest run src/orchestrator.test.ts -t "audited-tree gate re-run"` →
9 passed, exit 0. The full suite and `test:fast` are the orchestrator's to run on
the authorized tree and were not run here.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

The code reads like the module around it: injected callbacks mirroring
`runSelfAuditStage`'s `dispatch`, `AuditedBaseGateEvidence` declared structurally
to avoid the hub import cycle, and comments that explain the *why* (the two
base-gate anti-patterns, the additive assertion, the absent round bump) rather
than restating the code. The audited worktree's cleanup was folded into the
attempt's existing `finally` — not contracted, but the right call, and it uses
the same `removeWorktreeOrWarn` seam. `resolveGradedCandidate`'s generic
parameter is a clean way to serve both base-gate shapes without a cycle.

The notes are all in the tests, and one of them is blocking. Three assertions
were written in forms that cannot fail; see the findings.

## Resolved findings
- None. This is round 1 of this QA stage and no prior findings were routed.

## Findings

### Finding 1 — The distinct audited-checkpoint path has no failing test
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/self-audit.test.ts` asserts
`expect(h.createCheckpoint.mock.calls[0]![0]).not.toBe(ROUND_CHECKPOINT_DIR)`,
where `ROUND_CHECKPOINT_DIR` is the literal `"/afk/checkpoints/round-1"` and the
harness supplies `checkpointDir: join(evidenceRoot, "checkpoint-audited")`. The
two values can never be equal, so the assertion passes for any implementation.

Probe: I changed the hub's only audited call site from
`checkpointDir: `${checkpointDir}-audited`` to `checkpointDir: checkpointDir`
(`src/orchestrator.ts:6491`) and ran
`pnpm vitest run src/self-audit.test.ts src/orchestrator.test.ts -t "audited"`:

```
 ✓ src/self-audit.test.ts (16 tests | 12 skipped) 39ms
 ✓ src/orchestrator.test.ts (199 tests | 190 skipped) 9ms
 Test Files  2 passed (2)
      Tests  13 passed | 202 skipped (215)
```

That edit makes `createCandidateCheckpoint` throw "target already exists"
(`src/gate-runner.ts:351-353`) on every changed-tree round, because the round's
own checkpoint is still registered until the attempt's `finally` — a total
failure of the path this slice exists to add — and the suite is silent about it.
The probe was reverted and `pnpm run typecheck` re-run to green.

**What the contract expected:** test plan — "`createCheckpoint` was called once
with a path other than the round's `checkpointDir`"; Definition of done —
"`verifyAuditedTree` mints the audited checkpoint at a distinct path".
**What I observed:** the production code is correct, but nothing observes it. The
unit assertion is a tautology against an unused constant, and no orchestrator
source-order scan mentions the `-audited` suffix or compares the call site's
`checkpointDir:` argument with the round's. The requirement is covered in name
only.

### Finding 2 — The P-01 `createCheckpoint` spy is unreachable
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/self-audit.test.ts`'s `[behavior:#300:P-01]` builds
`const createCheckpoint = vi.fn(...)` and its only later use is
`expect(createCheckpoint).toHaveBeenCalledTimes(0)`. `runSelfAuditStage`'s input
type (`src/self-audit.ts:114-151`) declares no such member, so nothing the test
invokes could ever call it.
**What the contract expected:** "the `createCheckpoint` spy used by B-02 was
never called on either path."
**What I observed:** an inert spy. The claim is genuinely upheld — by the type
and by B-05's single guarded call site — but this assertion contributes nothing
while reading as coverage.

### Finding 3 — A single-element loop implies coverage of four cases
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/self-audit.test.ts`'s `[behavior:#300:B-08]` wraps its
released-pair assertions in `for (const value of [undefined])`, under a comment
naming `AUDIT_UNCHANGED`, `AUDIT_NOT_RUN`, a declined stage and an audited
`REPAIR`.
**What the contract expected:** the four non-audited cases resolve to the
released pair; at this function's boundary they are all the same input.
**What I observed:** one iteration over `[undefined]`. Straight-line assertions
would state the same fact without suggesting the loop covers four distinct
inputs.
