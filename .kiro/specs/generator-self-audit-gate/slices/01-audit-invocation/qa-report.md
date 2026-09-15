# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — exit 0, "Done in 5.5s using pnpm v10.33.0".
  Run here because the authorization's install ran in a different checkout.
- `pnpm run typecheck` — exit 0, no diagnostics. Run myself rather than cited:
  the skip authorization (attempt `8fc3265a-50c7-4e0b-8787-7ca92a6c17c2`, tree
  `afc68f0bc69c852a3a333649e68232aa8d21cfcd`) is void once files under review
  are modified, and I modified two for the mutation probes below. `git status
  --porcelain` after reverting shows only the two spec artifacts that differ by
  line endings alone (`git diff` over the slice directory is empty).

### Behavior verification

Every behavior was checked against the tree, not against the handoff. Probe:
`pnpm vitest run src/self-audit.test.ts src/context-envelope.test.ts
src/cli-options.test.ts src/run-state.test.ts src/eval-boundary.test.ts` —
**5 files, 210 tests, exit 0, 4.72s.** The heavy suites the DoD names are the
orchestrator's to run after this stage accepts; the two assertions this slice
moved in them are static version literals I read directly (below).

- **B-01** — `src/cli-options.ts:263` parses `args.includes("--self-audit")`
  in the exact shape of `recordPrompts` at `:262`, and `PipelineConfig` gains
  `selfAudit?: boolean` at `src/orchestrator.ts:546-549`. The test pins all four
  cases including both near misses.
- **B-02** — `src/self-audit.ts:164` declines on `selfAudit !== true` before
  anything else, and `:166` declines on the tree-id disagreement. Both tests
  additionally assert the run-state *file bytes* are unchanged, not just that
  the reader is empty, and the opt-out case asserts the `changeSummary`
  supplier was never called — so a declined audit costs the run nothing.
- **B-03** — verified independently of the test, by scanning the source myself:
  `requiredFailures = collectRequiredGateFailures(` at 6344,
  `assertGateEvidenceReleasesEvaluation(` at 6392, `runSelfAuditStage(` at 6419
  (one occurrence; the import at :186 carries no paren and cannot match), and
  the first `await runQAStage(` at 6475. Ordering holds and the failure branch
  span 6344–6392 holds no call site.
- **B-04/B-05/B-06** — the manifest is added to the every-registered-manifest
  validation list (`src/context-envelope.test.ts:2416`), so it is held to the
  same complete role contract as the other five. Order and budget are enforced
  by the one existing `assembleContextEnvelope`, whose `Math.min` clamp at
  `src/context-envelope.ts:1422-1425` predates this slice; the generic
  parameter added to it is type-level only.
- **B-07** — `prompts/generator-audit.md` renders through the real
  `renderPrompt`, which itself throws on both an unreferenced arg and an
  unprovided placeholder (`src/prompt-template.ts:18-32`), so the
  no-unrendered-placeholder claim has two independent enforcers.
- **B-08** — pure: `classifySelfAuditVerdict` reads only its three input
  fields. Both uncertain branches return the pre-audit tree id.
- **B-09** — see the mutation probe below; this is the assertion that carries
  the record obligation.
- **B-10** — `RUN_STATE_VERSION = 7`, union widened, `selfAudits` additive,
  reader and writer added. I checked for stragglers rather than trusting the
  contract's count of three literal pins: `expect(...version).toBe(<digit>)`
  across `src/*.test.ts` now yields 7 at `qa-orchestration-gates.test.ts:1043`,
  `qa-orchestration.test.ts:1028`, `run-state.test.ts:1203` and `:1304`, and no
  6 anywhere; the single remaining `version: 6` (`run-state.test.ts:1225`) is
  the deliberate P-03 fixture. `src/orchestrator.test.ts:5829` uses the
  constant rather than a literal. The handoff's disclosure that a *fourth* pin
  existed (the `[behavior:#87:B-14]` test title) matches what is in the tree.
- **B-11** — ADR present with the repository's structure, the mechanism, the
  `swarm-forge` / `swarm_handoff.sh` provenance and the one-invocation bound.
  One accuracy defect in it: finding QA-01.

### Test honesty — mutation probes

Assertions that cannot fail are the failure mode this slice is most exposed to,
because two of its behaviors are proven by source scans and one by a spy. I
broke the code in this disposable worktree to check:

1. **The record obligation (B-09).** Changed `src/self-audit.ts:190` to
   `if (false as boolean && classification.verdict === "AUDIT_UNCHANGED")`.
   Result: `× runSelfAuditStage > [behavior:#299:B-09] audits once and records
   AUDIT_UNCHANGED for an untouched tree`. The stage-level observation the
   contract insisted on — rather than a writer round-trip that cannot fail on
   an uncalled writer — does fail on an uncalled writer.
2. **The stricter-only clamp (B-06).** Replaced the `Math.min` at
   `src/context-envelope.ts:1422-1425` with the bare override. Result:
   `× the generator self-audit envelope > [behavior:#299:B-06] clamps a wider
   budget override and honors a stricter one`, plus one pre-existing
   merge-resolution budget test — 3 failed / 83 passed across the two files.
   The assertion matches on the byte count in the message (`/allowed 65536
   bytes/`), so a raised ceiling is caught rather than any throw counting.

Both edits were reverted with `git restore`; `pnpm run typecheck` was then
re-run to exit 0 on the restored tree.

### Boundary compliance

Every source, prompt, test and doc path in `change-summary.json` is in the
contract's declared list. Migration count 0 — no file under any migration
directory changed. The eight additional paths are all
`.kiro/specs/generator-self-audit-gate/slices/01-audit-invocation/*`
(`contract.md`, `acceptance-manifest.json`, `context.md`, `handoff.md`,
`feedback-r1.md`, `feedback-r2.md`, `contract-review.json`,
`contract-response.json`) — pipeline-authored slice artifacts, not candidate
work, so no amendment is owed. No `SCOPE_AMENDMENT` finding.

### Preservation

- **P-01** — `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts` and
  `src/gate-runner.ts` are absent from the change summary. The stage imports
  `resolveCandidateTreeId` and changes nothing in it.
- **P-02** — checked as behavior, not only as an absence: the failure-branch
  span still contains `baseGateRepairReferences`, the retry note, and
  `finishIntervention(candidateLifecycle.exhaustDeterministicGates({
  candidateTreeId: checkpoint.treeId, ... }))`, and contains neither
  `runSelfAuditStage(` nor `await runQAStage(`.
- **P-03** — the v6 fixture test asserts every other member deep-equals the
  fixture *and* that reading did not rewrite the file on disk, then that a
  later write re-stamps 7 while leaving `qualityStages` intact.
- **P-04** — the four existing manifests are untouched in the diff; the only
  edits to shared declarations are the `PromptAssemblyRole` union gaining
  `"generator-audit"` and `RoleEnvelopeEvidence`/`RoleEnvelopeResult` gaining a
  defaulted type parameter. The default is
  `JournaledAssemblyRole = Exclude<PromptAssemblyRole, "generator-audit">`, so
  a bare `RoleEnvelopeEvidence` means what it meant before rather than
  admitting the new role — the cleaner-role type test at
  `src/context-envelope.test.ts` and `prompts/generator.md` /
  `prompts/generator-repair.md` are all unedited.
- **Default-run neutrality**, which is what "behaves exactly as it does today"
  reduces to: with the flag absent the orchestrator spreads no `selfAudit`
  key, the stage returns on its first line, and the `git log` supplier is never
  called. The dispatch omits `contextEnvelope`, and `invoke` guards that with
  `if (opts.contextEnvelope !== undefined)` (`src/orchestrator.ts:1110`), so no
  `prompt-assembly` event is journaled — the declared non-goal holds.
- `prompts/` ships wholesale via `package.json` `files`, and the only
  `readdirSync(PROMPTS_DIR)` enumeration filters on `/merge|conflict|resol/i`
  (`src/context-envelope.test.ts:3073`), so the new template breaks no prompt
  inventory.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

The stage follows the injected-dispatch shape it cites (`src/cleaner-stage.ts`),
the classifier follows `decideFinalReuse`, the sanitizer mirrors
`sanitizeQualityStages` branch for branch, and the CLI flag mirrors
`recordPrompts`. The declining discipline is implemented where it matters and
not only documented: `dispatchAudit` catches an envelope configuration fault and
reports it as an incomplete invocation, so a manifest bug costs the run its
audit rather than the slice. Choosing a supplier over a string for the change
summary is what makes the opt-out path genuinely free, and the test asserts it.

One note, filed as QA-02: the new sanitizer is the only untested surface in the
slice.

## Resolved findings
- none — this QA stage routed no findings into this round.

## Findings

### Finding 1 — ADR 0069 says an AUDIT_CHANGED verdict is recorded; this slice does not record it
**Severity:** Minor
**Pass:** 2
**Evidence:** `docs/adr/0069-...md:78-82` states "until it exists an
`AUDIT_CHANGED` verdict is recorded and changes nothing downstream", and
`:86-89` generalizes that "the persisted outcome carries the candidate tree the
audit was handed and the tree it left behind". `src/self-audit.ts:190` guards
the write with `if (classification.verdict === "AUDIT_UNCHANGED")`, and
`src/self-audit.test.ts:229-231` asserts the ADR's negation for a changed tree:
`expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual([])`.
That test passes (`pnpm vitest run src/self-audit.test.ts` — 8 passed) precisely
because nothing is persisted.
**What the contract expected:** "Recording `AUDIT_CHANGED` or `AUDIT_NOT_RUN` in
run state" is a non-goal — "only `AUDIT_UNCHANGED` is written here" — and the
scope lock words the changed case as "classified and returned but changes
nothing downstream".
**What I observed:** All of B-11's declared observations hold; the ADR is
structurally and substantively correct about the mechanism, the provenance and
the bound. The one sentence about recording describes the state after the
sibling slices land, in the present tense, in the document a future reader will
treat as the record of what exists. Advisory, not blocking: no behavior is
wrong and no test is dishonest.

### Finding 2 — the new run-state sanitizer has no test
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/run-state.ts:1028-1083` adds `sanitizeSelfAudits` with five
reject branches and a whole-key discard on `dropped || entries.length === 0`.
Neither B-10 (`src/run-state.test.ts:1185`) nor P-03 (`:1220`) feeds it a
malformed entry — both write well-formed records through the writer. Removing
the verdict check leaves all 210 tests in the probe run green.
**What the contract expected:** the acceptance manifest's B-10 lists
"sanitization in `adaptLoadedState`" among the shipped members, and CLAUDE.md's
"Where a new assertion goes" makes a unit test the first-choice home for
exactly this kind of branch set. The repository backs that up at
`src/run-state.test.ts:205`, `:275`, `:498` and `:951`, where every other
persisted-record sanitizer pins its degradation.
**What I observed:** The sanitizer's rules are unobserved in either direction.
Mitigating, and why this is advisory rather than blocking: it is a faithful copy
of `sanitizeQualityStages` (`src/run-state.ts:847`), which is also untested, and
the contract's test plan names no sanitization scenario — so this is the
precedent being inherited, not a new gap invented here.
