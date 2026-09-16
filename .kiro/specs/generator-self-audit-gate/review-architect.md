# Architect review — generator self-audit gate (round 1)

**Verdict:** FIX-BEFORE-SHIP

Scope read: `git diff main...HEAD` (60 files), the three slice contracts and
handoffs under `.kiro/specs/generator-self-audit-gate/slices/`, ADR 0069, and
the surrounding production code the diff plugs into (`src/post-qa-gates.ts`,
`src/base-gates.ts`, `src/gate-runner.ts`, `ARCHITECTURE.md`).

The shape of the feature is right and largely exemplary for this codebase: the
verdict is a pure function over two tree identities, dispatch and gate execution
arrive through injected callbacks so the whole stage is testable without a
provider or a git process, the persisted fact takes a `run-state.ts` version
bump with a sanitizer and a reader (ARCHITECTURE.md:142), the run-summary
totals report and never gate (ADR 0063), and `resolveGradedCandidate` collapses
four candidate-identity consumers into one value, which is the correct answer to
the ADR 0012 divergence risk. One structural hole blocks.

## FIX-BEFORE-SHIP

### A-01 — a dead audit invocation that already wrote leaves the worktree drifted from the tree QA is authorized for

**Files / locations.**
- `src/self-audit.ts:85-94` (`classifySelfAuditVerdict`, not-completed branch)
- `src/self-audit.ts:436-475` (`dispatchAudit`, catch path)
- `src/orchestrator.ts:6634-6645` (`resolveGradedCandidate` call), `6888`
- `src/post-qa-gates.ts:190-223`; `src/orchestrator.ts:6962-6963`

**What I read/ran.**
- `resolveCandidateTreeId` hashes *tracked plus untracked working state*
  through a throwaway index (`src/gate-runner.ts:267-282`, `readCandidateTree`
  at `290-301`), so any file a dispatched audit leaves in the slice worktree —
  a partial edit, a scratch note, a half-written test — changes the tree id.
- On an invocation that did not complete, the stage never re-hashes and never
  restores: `dispatchAudit` catches the rejection and returns
  `{ completed: false }` with no `postAuditTreeId` (`src/self-audit.ts:458-463`),
  and `classifySelfAuditVerdict` returns `AUDIT_NOT_RUN` on the **pre-audit**
  tree without consulting any post-audit id at all. The suite pins this as
  intended: `src/self-audit.test.ts:1277-1283` asserts that
  `{ preAuditTreeId: pre, postAuditTreeId: post, completed: false }` classifies
  `AUDIT_NOT_RUN` with `treeId: pre` — i.e. a killed audit that *did* rewrite
  the tree is released under the pre-audit identity.
- The changed-tree repair is reached only from `AUDIT_CHANGED`
  (`src/orchestrator.ts:6505-6510`); every other verdict resolves the graded
  candidate to the released pair by reference, so `qaApprovedTreeId` is the
  pre-audit id (`src/orchestrator.ts:6888`).
- Nothing between the audit and the post-QA phase resets the worktree — I
  grepped `reset --hard|resetHard|discardWorktree|checkoutForce` across
  `src/orchestrator.ts:5600-7000` and found no match.
- `runPostQAGates` then hashes the live worktree fresh
  (`src/post-qa-gates.ts:184-195`) and returns `action: "ERROR"` when it differs
  from `qaApprovedTreeId` beyond the slice review-artifact dir
  (`:202-223`), which the hub turns into `return { phase: "ERROR", ... }`
  (`src/orchestrator.ts:6962-6963`) — a terminal slice error needing a human,
  after the QA evaluator round has already been spent.

**Reachable trigger (normal operation).** A run launched with `--self-audit`
whose audit invocation edits the slice worktree and then dies on every attempt:
an idle-timeout or wall-clock kill (`AUDIT_KILL_SIGNATURES`,
`src/self-audit.ts:159-166`) with the `--infrastructure-retries` budget
exhausted, a `tool-call-cap` kill, which `isInfrastructureSelfAuditCause`
excludes from retry outright (`src/self-audit.ts:236-245`), or an
`internal-error`. The taxonomy this slice ships exists precisely because these
kills are routine for an unattended pipeline. The second `AUDIT_NOT_RUN` branch
reaches the same state from the other side: `resolveCandidateTreeId` throwing
after a completed audit (`src/self-audit.ts:469-474`) releases the pre-audit id
for a tree the audit may well have rewritten.

**Introduced by the reviewed diff.** Yes. Before this branch nothing wrote to
the slice worktree between the candidate checkpoint / gate release and the QA
dispatch; the audit invocation is the new writer in that window, and the diff
handles its drift on exactly one of its three verdicts.

**Why this is not "the gate declining".** ADR 0069's own invariant is that the
gate "may add scrutiny and may never block a run by its own failure", and its
`AUDIT_NOT_RUN` clause claims the candidate "proceeds to QA exactly as if the
audit had never been dispatched". That equivalence holds only if the worktree is
unchanged, which is asserted nowhere. Recovery does not complete before another
actor consumes the state: the QA round is spent and the slice ends in `ERROR`,
which is durable, operator-visible harm caused by the opt-in gate itself.

**Clear condition.** On a not-completed invocation, and on one whose post-audit
tree cannot be resolved, the stage must reconcile the worktree with the released
tree before returning `AUDIT_NOT_RUN` — either re-hash and route a drifted tree
through the existing `AUDIT_CHANGED` re-gate path, or restore the worktree to
the released tree (and record the restore) so the released identity is true
again; with a unit test covering "dead invocation left files behind" at the
`runSelfAuditStage` seam, and `src/self-audit.test.ts:1277-1283` amended to the
new rule.

## ACCEPT-WITH-NOTES (notes — none of these block)

### A-02 — the re-gate set is derived from the audited tree's own catalog
`src/orchestrator.ts:6518-6521` reads `resolveCheapGateCatalog(ctx.worktreeDir)`
*after* the audit has written to that worktree, so an audit that touched the
sanity plan or `gatePolicy.cost` chooses which gates re-gate its own tree (an
empty selection is a legal outcome of `selectAuditedGateDeclarations`,
`src/self-audit.ts:586-596`). Downstream the scope, skip and feedback-integrity
gates plus the full suite still run on the live worktree
(`src/orchestrator.ts:6799-6850`), so this is not a hole to ship-blocking depth
— but resolving the catalog once per round, before the audit, alongside
`costPlan`, would make the re-run provably the same policy that released the
pre-audit tree (ARCHITECTURE.md:74-80, "a gate's price is declared, not
discovered").

### A-03 — cancellation is absorbed as `AUDIT_NOT_RUN` and persisted as spent
`runSelfAuditStage` takes no `AbortSignal` and `dispatchAudit` catches every
rejection (`src/self-audit.ts:445-463`), so a `CancelledError` from a stop or
Ctrl-C becomes "did not complete" rather than propagating the way every other
invocation site does (`isCancelled` rethrow, `src/orchestrator.ts:3185`). The
stage then writes an `AUDIT_NOT_RUN` entry (`src/self-audit.ts:411-418`) which
`selfAuditsFor`'s spent check treats as an invocation already spent
(`:365-378`), so a resumed run never audits that candidate. Also, a cancel
message matching `/was killed/i` classifies as `orchestrator-kill` and buys a
re-dispatch after the abort. ADR 0069 says the bound counts *completed*
invocations; persisting the aborted one as spent is a narrower promise than the
ADR makes. Cheap, non-durable, and arguably deliberate — hence a note.

### A-04 — the failure-cause taxonomy and kill-signature table now exist twice
`src/self-audit.ts:130-245` re-implements `classifyNegotiateFailure` /
`isInfrastructureCause` (`src/orchestrator.ts:1841-1856`), including the
dash-agnostic provider-message regexes. The cycle argument is real and
`classifyReviewFailure` (`src/artifacts.ts:135`) is honest prior art, but the
regex table is provider-coupled: the next provider message change has two copies
to find. A leaf module owning the signatures (both hubs importing it) would keep
the same acyclicity with one source of truth (ARCHITECTURE.md:39-43, "New
behavior goes in a new module").

### A-05 — ~220 new lines inside `runSliceExecute`
`src/orchestrator.ts:6425-6645` adds the dispatch wiring, the event emission,
the changed-tree branch and the repair/exhaust handling inline in the hub
ARCHITECTURE.md:39-43 explicitly asks not to grow. The heavy lifting is
correctly in `src/self-audit.ts`; a thin `self-audit-orchestration` wrapper (the
`cleaner-orchestration.ts` precedent) taking the callbacks and returning
`{ gradedCandidate, repair? }` would leave one call site here instead of five
nested blocks. Style/placement, not behavior.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"A dead audit invocation that already wrote leaves the slice worktree drifted from the pre-audit tree QA is authorized for, so the post-QA authorization refuses the tree and the slice ends in ERROR","class":"INTEGRITY","clearCondition":"On a not-completed or unresolvable audit invocation, runSelfAuditStage reconciles the worktree with the released tree before returning AUDIT_NOT_RUN — either re-hashing and routing a drifted tree through the AUDIT_CHANGED re-gate path, or restoring the worktree to the released tree — with a unit test covering a dead invocation that left files behind and src/self-audit.test.ts:1277-1283 amended to the new rule.","disposition":"OPEN","reachableTrigger":"A --self-audit run whose audit invocation edits the slice worktree and is then killed by its idle timeout, wall-clock ceiling or tool-call cap on every attempt: the stage records AUDIT_NOT_RUN on the pre-audit tree id, QA is dispatched and spent on that id, and runPostQAGates then hashes the drifted live worktree and returns ERROR.","introducedByReviewedDiff":true},{"id":"A-02","title":"The audited-tree re-gate set is derived from the cheap-gate catalog read out of the post-audit worktree","class":"CONVENTION","clearCondition":"The cheap-gate catalog used by selectAuditedGateDeclarations is resolved once per round before the audit dispatch, alongside costPlan.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"A cancellation during the audit is absorbed as AUDIT_NOT_RUN and persisted as a spent invocation","class":"ROBUSTNESS","clearCondition":"A cancelled audit invocation propagates cancellation (or is not persisted as spent), so a resumed run still audits that candidate.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"The agent-failure-cause taxonomy and provider kill-signature regex table are duplicated between self-audit.ts and orchestrator.ts","class":"DUPLICATION","clearCondition":"The kill-signature table and infrastructure-cause predicate live in one leaf module both call sites import.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"About 220 lines of audit orchestration were added inline to runSliceExecute, a hub ARCHITECTURE.md asks not to grow","class":"CONVENTION","clearCondition":"The audit dispatch, event emission and changed-tree branch move behind a self-audit orchestration module with one call site in the hub.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false}]}
