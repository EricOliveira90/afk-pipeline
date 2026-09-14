# Contract negotiation stuck

- Slice: #277 Crash-recoverable preserve-work renegotiation
- Outcome: ESCALATE
- Round: 2
- Final verdict: VERDICT: NONE
- Round-cap decision: The planner stopped at round 2 to request a design decision instead of writing a contract: design decision requested: Whether slice 01 (#277) may be re-cut so that completion compare-and-swap, replay idempotence, launch-time crash reconciliation and run-event/snapshot reporting move out to a new successor slice, which requires changing the declared slice index, wave structure and #278's blocker, or whether slice 01 keeps the boundary the specification declares and F-01 is answered as CONTESTED on size grounds — the specification contradicts itself (SPEC_CONTRADICTION), cited issues.md:8 (slice 01 = #277 user stories 'Recovery admission, rollback and completion'), issues.md:13-14 and 19-23 (Wave 1 = #277 alone; '#277 establishes the single-target write-ahead state machine, immutable snapshot, crash reconciliation and fail-closed rollback semantics'; #278 'commits it only with successful recovery completion'), against contract-review F-01's clear condition requiring completion, replay, reconciliation and run-event folding be deferred to a successor slice; candidates: Re-cut #277: file a successor slice under this PRD carrying completion, replay, reconciliation and run-event folding, revise issues.md's slice table and wave structure, and re-point #278's blocked-by at the successor, since #278's atomic additions commit only with recovery completion | Keep #277's declared boundary whole and contest F-01: the specification assigns admission, rollback and completion to slice 01, so the contract retains all 17 in-scope behaviors and the 22-path file scope, resolving only F-02 through F-05. Record the decision in the source issue or an ADR, then rerun the slice. Report: .kiro/specs/afk-preserved-work-renegotiation/slices/01-crash-recoverable-preserve-work-renegotiation/planner-escalation.md.

## Unresolved gaps

# Contract feedback — round 1

## What is working

The contract is unusually well grounded. Nearly every behavior cites a concrete
symbol and line (`canonicalSliceNumber` at `src/afk-manifest.ts:240`,
`PersistedRunScope` at `src/slice-scope.ts:9`, `clearExactStageCheckpoint` at
`src/exact-stage-resume.ts:179`, `saveContractFindingLineage` at
`src/contract-convergence.ts:609`, the `createHash("sha256")` pattern at
`src/gate-runner.ts:1253-1255`), and the three decisions recorded rather than
escalated are exactly the right kind: the empty `extensions: []` seam for #278,
the additive version-7 field, and the local hash helper are all cheap to reverse
before merge. The non-goals section is genuinely useful — it names #278, refuses
multi-target invocation, and specifically calls out that
`src/scope-amendment.ts`'s contract-file scope is a different mechanism, which
is the exact confusion the explorer warned about. B-01's gate binding is
correct: it declares both the accepted input and the five refusal cases, and
`src/cli-options.test.ts` is in scope to hold them. Gate selections are apt
throughout — no behavior leans on the non-executable `lint` gate, and the
behavior-ID naming convention in the definition of done matches what
`--testNamePattern` needs.

## Why this cannot lock yet

**The slice is too large for one generator session.** This is the finding that
matters. The contract carries the whole PRD protocol in one pass: flag parsing,
canonical identity, a new scope-fingerprint encoder, four read-only git
eligibility predicates, atomic snapshot publication, a run-state version bump,
an append-only lineage state machine, live-control archival, an explorer and
planner/evaluator rerun, five distinct failure-path rollbacks, fail-closed
dispatch blocking, pre-resume reconciliation wired into `src/orchestrator.ts`,
a completion compare-and-swap, replay idempotence, and run-event plus snapshot
folding. That is 23 ID-selectable behaviors across 22 files, five of them new
modules with new test files, and the evidence includes a cross-process
lock-contention test and an extended `resume-integration` fixture. The
definition of done then asks for `test:heavy:resume` **and**
`test:heavy:orchestrator` on top of `test:fast`. Each piece here is
well-specified; there are simply too many of them. A natural cut is the
admission path — flags, identity, fingerprint, eligibility, snapshot, the
`PENDING` write under the ADR 0056 lock, and its rollback — with completion,
replay, launch-time reconciliation and run-event folding moved to a named
successor slice and listed under non-goals. The seam is already clean, because
the lineage state machine gives the later work a defined entry state.

**The run-events parser change binds only half its evidence, and names a
harness that does not exist.** Adding a `RunEventPayload` variant widens the
input language of `readRunEvents`/`serializeRunEvent` in `src/run-events.ts`,
so ADR 0060's both-halves rule applies. The positive half is covered by the
fold assertions in `src/run-snapshot.test.ts`. The other half is not: there is
no `src/run-events.test.ts` in this repository, so P-04's "existing run-events
parsing tests pass unmodified" points at nothing. The established harness that
actually round-trips `events.jsonl` and pins `EVENTS_SCHEMA_VERSION` is
`src/logger.test.ts` (it imports both symbols at lines 21-23 and asserts the
version at 1152 and 1319), and it is absent from the file scope — so the slice
cannot touch it. No rejected or boundary payload case is declared either. Bring
the owning test file into scope and declare both halves.

## Smaller things worth fixing while you are in here

B-04 lists four git-level predicates — registered worktree, clean worktree,
commits ahead of the feature branch, slice branch containing the current
feature head — but cites only `PersistedRunScope`, and no git or worktree module
is in the file scope. The explorer explicitly left open whether any of these
already exist. Say where they land.

B-05 claims no branch mutation "in any code path including rollback", which no
finite test can show; scope it to the paths your evidence exercises. The
manifest's B-05 also carries the feature-head refusal, which belongs to B-04 in
both halves.

B-10 treats direct reuse of `clearExactStageCheckpoint` as settled while
`src/exact-stage-resume.ts` sits outside the file scope and its signature is an
open explorer unknown. Saying that any adaptation lands as a wrapper in the new
recovery module keeps the scope statement true either way.

## Next action

Update the source issue body (the local issue manifest when present, otherwise the GitHub issue) to close the unresolved acceptance and test-plan gaps above, then rerun the slice.

## Artifact locations

- Working contract: .afk/worktrees/afk-claude-code-afk-preserved-work-renegotiation-s01/.kiro/specs/afk-preserved-work-renegotiation/slices/01-crash-recoverable-preserve-work-renegotiation/contract.md
- Working context: .afk/worktrees/afk-claude-code-afk-preserved-work-renegotiation-s01/.kiro/specs/afk-preserved-work-renegotiation/slices/01-crash-recoverable-preserve-work-renegotiation/context.md
- Working feedback: .afk/worktrees/afk-claude-code-afk-preserved-work-renegotiation-s01/.kiro/specs/afk-preserved-work-renegotiation/slices/01-crash-recoverable-preserve-work-renegotiation/feedback-r1.md
- Archive directory: .afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01
- Archived contract: .afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01/contract.md
- Archived context: .afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01/context.md
- Archived feedback: .afk/artifacts/afk-preserved-work-renegotiation-claude-code/slice-01/feedback-r2.md
