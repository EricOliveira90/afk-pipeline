# Architecture Guardian Review

**Verdict:** ACCEPT-WITH-NOTES

Reviewed `main...HEAD` at
`2e3726e7446315593780103e9793d83b9e0e123a` against base
`817d663b480145ef16a02d581a67a15d4ef2ec6f`, the PRD, every available
slice artifact, `ARCHITECTURE.md`, and the governing ADRs. The recorded
pre-ship gate already passed this exact tree, so I did not rerun the full
suite.

No changed control flow establishes a FIX-BEFORE-SHIP failure path. The
round-7 correction in `src/logger.ts` restores one population for the B-06
summary columns: prompt bytes and provider tokens now cover only explorer,
planner, contract-evaluator, and generator invocations. I inspected commit
`2e3726e`, traced every production invocation of those roles, and ran
`pnpm vitest run src/logger.test.ts` (23 tests passed). `git diff --check
main...HEAD` also passed.

## Notes

### 1. Envelope telemetry crosses two declared module boundaries

- **Convention:** `ARCHITECTURE.md`, “Hubs — do not grow these; extract
  instead,” and “Modules → Gates” (`candidate-gate-policy.ts` is an internal);
  ADR 0002 and ADR 0030 define `AgentProvider` as the backend command/output
  adapter seam.
- **Evidence:** `src/orchestrator.ts` has a net `+821/-398` diff and still owns
  prompt-assembly journaling in `makeSliceContext`, completion telemetry,
  candidate-gate sequencing, and tree-authority checks. It also retains an
  unused direct import of internal `candidate-gate-policy.ts` at line 248.
  `src/agent-provider.ts:14-33` puts orchestration-owned `contextEnvelope`
  metadata on `InvokeOptions`; providers ignore it, but `makeSliceContext`
  still passes it through `provider.invoke`. `src/contract-prompt-orchestration.ts`
  consequently imports its evidence type from the provider layer.
- **Attribution:** commits `2fb0c11` and `eb012b9` introduced the provider
  metadata path; `ee68e16` introduced the internal gate-policy import, which
  remained after extraction commit `62458b4`.
- **Impact:** future envelope or provider additions require coordinated edits
  across orchestration, prompt assembly, provider types, events, and summary
  consumers. Current dispatches remain correct and fail closed, so this is
  structural debt rather than a ship blocker. Move invocation evidence onto
  an orchestrator-owned wrapper and finish removing internal gate policy from
  the hub when this seam is next changed.

### 2. `clean-failed` now exceeds its documented command scope

- **Convention:** ADR 0023 defines `afk clean-failed` as cleanup for
  failure-phase debris and says registered non-failure worktrees are skipped.
- **Evidence:** `src/cleanup-eligibility.ts:13-27` returns
  `completed-clean` for a merged, clean `PASS` slice, and
  `src/clean-failed.ts:217-329` removes that worktree and deletes its branch.
  The focused test at `src/clean-failed.test.ts:381-402` asserts this behavior;
  I ran that single test and it passed.
- **Attribution:** commit `183ddac` replaced the previous failure-phase guard
  with the shared cleanup eligibility rule and changed the prior skip test
  into a deletion test.
- **Impact:** the behavior is safe from data loss as implemented: the
  worktree must be clean, the merge must be recorded, and branch deletion is
  refused if commits remain ahead of the feature branch. The problem is
  command/ADR semantic drift, not unsafe recovery. Either rename/generalize
  the command and amend ADR 0023, or keep completed-slice cleanup in a
  separately documented path.

## Attribution check

I also verified the reported stale-explorer concern independently.
`runSliceNegotiate` already skipped exploration whenever `context.md` existed
on the base branch; commit `6067288` narrowed that behavior by accepting only
a structurally valid evidence map. Because the freshness defect was not
introduced or materially widened by this diff, it is not a ship finding for
this review.
