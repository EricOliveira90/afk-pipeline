# Contract review — slice 08 (#195), file-scope gate, round 1

## Summary

The contract is lockable. Every one of the six findings this slice carried in is
answered in the contract text itself, not in prose about the contract, and each
answer holds against the code I read. The one thing I would still change is a
test-plan omission, not a scope or evidence problem, so it does not block the
build.

## The carried findings

**Manifest bytes at gate time (F-01).** B-07 now says where the comparison
manifest comes from: `run` calls `loadAcceptanceManifest(absSliceDir)` when it
executes, so an ADR 0048 amendment applied during the QA window is the scope the
gate measures against. That helper exists at the cited line and throws when the
file is absent, which is the fail-closed direction. The test plan carries the
case the call-site decision exists to protect — a path added to `fileScope`
after the declaration was built produces no violation.

The `acceptedPairIntact` half checks out too. I read
`src/orchestrator.ts:5348-5377` and the integrity check sits *before*
`existsSync(escalationPath)` at `:5379`, with a comment saying so explicitly:
the pair is protected across every generator invocation, not only the escalating
ones. The generator dispatch is unconditional inside the implementation-attempt
loop and `runPostQAGates` runs later in that same iteration (`:5804`), so the
latch B-07 describes is always set for the tree being gated, and starts false —
which fails closed through B-10 rather than open.

**A throwing `run` (F-02).** B-02 is new and covers the whole recorded outcome:
`INFRASTRUCTURE`, `failureKind: null`, the error message as `detail`, the loop
continuing, the evidence document still written, one result per declaration. The
`INFRASTRUCTURE`-over-`FAIL` choice is argued from the helper that actually
throws (`diffTreePaths`) and from ADR 0041, and it lands in the retry P-06
relies on, which keys on status and never on declaration shape. The assertion is
declared in `src/gate-runner.test.ts`.

**One shape for version 2 (F-03).** B-03 types all four D22 fields here and says
why: version 2 has one shape regardless of which slice merges first. That is
D22's own text, and `riskClass` is the `GateRiskClass` type from #84's already
merged `src/gate-policy.ts` rather than a bare string. Nothing is handed to #193
inside a file this slice bumps.

**B-10's Given (F-04).** The Given now states that both pair files differ from
the feature branch, which is what the Then needs — `outOfScopeChangedPaths`
filters a changed set, and with `acceptedPairIntact: false` it pushes both
normalized pair paths as offenders even when the manifest declares them
(`src/escalation.ts:227-250`).

**Which directory the probe reads (F-05).** B-06 states that the candidate
source probes its own `worktreeDir` and not `ctx.cwd`, and that the recorded
`treeId` stays the checkpoint's. Both halves matter at this call site:
`runPostQAGates` only materializes the checkpoint when some declaration carries
a `command`, so `ctx.cwd` can be a path that does not exist — and B-01 puts the
`run` branch ahead of the `existsSync(options.cwd)` break, which is what keeps
the gate runnable in that case.

**Position in the declaration list (F-06).** The declaration is prepended, which
takes the stronger of the two ways out: no earlier declaration's
`INFRASTRUCTURE` or checkpoint `break` can leave the required gate without a
result, and the deterministic check does not queue behind the suite. The
complementary rule is stated as well — a red `scope` does not short-circuit the
declarations after it, which matches `runGates` continuing past a `FAIL`.

## What I would still fix

Two manifest observables have no matching test-plan line. P-06 promises an
assertion that the bounded infrastructure retry fires for an in-process
`INFRASTRUCTURE` result, but names two candidate files with an "or" and the plan
declares neither. The retry lives in `src/candidate-gate-phase.ts`, which is
deliberately out of scope and whose test file is not in `fileScope`, so the
in-scope home is a `src/gate-runner.test.ts` case that imports
`runCandidateGatePhase` and drives it with a `run` returning `INFRASTRUCTURE` —
workable, but the contract should pick it. B-06 likewise promises assertions on
a differing `ctx.cwd` and on the recorded `treeId`; the plan's real-repo
candidate-source line mentions the untracked file and neither of those. Both are
places where the definition-of-done checklist could be satisfied with the
promised observable still unwritten.

## Why the scope and the plan hold up

The declared file list matches what the change actually touches. I checked the
persisted-schema blast radius, since that is the class the anchors record as the
cause of this slice's earlier escalations: `GATE_EVIDENCE_VERSION` is referenced
only in `src/gate-runner.ts`, the assertion that must flip
(`/unsupported gate evidence version: 2/`) is in `src/gate-runner.test.ts`, and
the two evidence fixtures outside the declared list
(`src/qa-gate-authorization.test.ts:45`, `src/candidate-gate-policy.test.ts:40`)
use a literal `version: 1`, which stays assignable once `GateEvidence.version`
widens to `1 | 2`. No consumer branches on the version. `stage` is a plain
`string` on `GateDeclaration`, so `deterministic` needs no type edit.

The cited seams are real: `src/gate-runner.ts:413-440` already makes a required
command-less declaration `FAIL`/`CONFIGURATION` and an optional one `SKIPPED`,
which is exactly the split B-08 preserves and exactly D22's 2026-09-08
correction; `acceptanceManifestPaths` returns `[]` for
`no-repository-changes`, which is what makes B-13 true rather than asserted; and
`src/qa-orchestration.test.ts:2167-2176` is the `["typecheck","lint"]` /
`["tests"]` gate-id assertion the changes section says becomes
`["scope","tests"]`.

Structured evidence does reach the next generator round without touching
`src/candidate-gate-phase.ts`: `decideCandidateGatePhase`'s `references` are the
evidence document path plus each failed gate's log path
(`src/candidate-gate-policy.ts:79-101`), and the evidence document is now the
thing that carries `findings.outOfScopePaths`. That is what makes the
`CandidateGateOutcome` projection a defensible non-goal rather than a gap.

The call-site choice also deserves a note. The anchors call
`src/post-qa-gates.ts` "the natural home" but leave the exact seam open; the
contract keeps that file unedited and builds the declaration at the orchestrator
call site instead, citing the split map that assigns `post-qa-gates.ts` to #193.
The gate still runs inside `runPostQAGates`, so the settled decision is honored
and a merge-order collision with #193 is avoided.

Feasibility is the honest risk, not correctness: sixteen files, and every
spawned fixture whose stub writes an undeclared path has to declare it. The
work is mechanical — `fileScope` already appears about thirty times across the
declared fixture and test files — and I confirmed the other suites that build
manifests (`resume.test.ts`, `scope-amendment.test.ts`,
`contract-prompt-orchestration.test.ts`, `migration-claims.test.ts`) spawn no
pipeline and so cannot be reached by the new gate. The correction rule is stated
the right way round, too: declare the path in the fixture manifest, never weaken
the gate or drop an assertion.
