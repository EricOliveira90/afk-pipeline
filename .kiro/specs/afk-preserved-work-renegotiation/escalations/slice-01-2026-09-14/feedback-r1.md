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
