# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here (exit 0). `pnpm run typecheck` is
covered by the skip authorization (gate attempt `ef4a4bc7-5361-4226-9042-6adea87f0464`,
evidence `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260911-201741/gates/s04/attempt-ef4a4bc75361.json`,
tree `40e361bbb944955a883b889ae731b67d3e9d352a`) — but I probed the tree, so I
re-ran it myself after reverting the probe: `pnpm run typecheck` → exit 0.

Touched suites, run directly:

- `pnpm vitest run src/final-evaluation.test.ts src/bounds.test.ts src/change-summary.test.ts src/qa-review.test.ts src/post-qa-gates.test.ts src/context-envelope.test.ts src/run-state.test.ts` → 7 files, 322 tests, all passed (24s).
- `pnpm vitest run src/qa-orchestration.test.ts -t "final evaluation and reuse"` → 8 passed (50s), including the three spawned scenarios.

Boundary: `git diff --name-only 4672247 HEAD` touches only paths in `## Files
expected to change` plus this slice's own spec artifacts. `src/gate-runner.ts`
and `src/wave.ts` are unmodified, as the contract requires. The only working-tree
delta is line-ending normalisation on the contract and manifest plus the removal
of the previous round's QA artifacts. No scope amendment is needed.

Preservation: P-02/P-04/P-05 are carried by the existing suites, which pass
unchanged (`qa-review.test.ts` 111 tests, `change-summary.test.ts` including
`[behavior:P-04]`, `post-qa-gates.test.ts` including `[behavior:P-05]`). P-03
holds — `invalidateFinalEvaluationBaseline` writes only `finalEvaluations`, and
the spawned and unit B-09 tests both re-read `approvedBaselines` intact. P-06
holds — a hand-written v4 file loads with its #91 locator and #193 waivers and
gains `finalEvaluations`, and the four `version: 4` input fixtures in
`src/run-state.test.ts` are unchanged. P-01 holds by `src/wave.ts` being
untouched, though its assertion is weak (QA-08).

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 1 is not clean, so Pass 2 was not entered. QA-08 is a Pass 1 test-honesty
finding, not a craft note.

## Resolved findings
- **QA-01** (evaluator-final never dispatched) — cleared. `src/orchestrator.ts`
  now dispatches `invoke({ role: "evaluator-final", ... })` in a bounded loop
  inside a disposable `createReviewIsolation` worktree, and the spawned
  `[behavior:B-03]` scenario asserts exactly one invocation, a cwd that is not
  the slice worktree and no longer exists afterwards, and `phase: PASS`.
- **QA-02** (final verdict could never PASS) — cleared. The scope gate is re-run
  on the final tree (`qaApprovedTreeId: currentFinalTreeId`) and its status is
  accepted only when the evidence's own `treeId` matches; the spawned scenario
  reaches PASS through `runSliceExecute`.
- **QA-03** (attempt count instead of per-attempt entries) — cleared.
  `PersistedFinalEvaluationAttempt` keys each attempt to the tree it graded and
  `finalEvaluationFor` derives `invalidated` per entry; the unit test seeds two
  attempts on two trees and asserts only the rejected one reads invalidated.
- **QA-04** (generator-round delta asserted as a literal) — cleared. The spawned
  `[behavior:B-09]` scenario reads `genRounds` and the spent-attempt count at
  each evaluator dispatch and asserts `[{genRounds: 1, spent: 0}, {genRounds: 2,
  spent: 0}]` across a real return.
- **QA-05** (bound had no call site) — cleared.
  `finalEvaluationAttemptsRemaining` gates every loop iteration before any
  dispatch; with three GRADED attempts seeded, the run ERRORs citing `all 3` and
  `finalCalls` is empty.
- **QA-06** (double parse) — cleared. `validateFinalReview` returns the parsed
  review and the verdict's `finalArtifactTreeId` comes from that same value.

## Findings

### Finding 1 — No run can reach a `reuse` decision; B-02's three stores are unreachable and asserted only by hand
**Severity:** Blocker
**Pass:** 1
**Evidence:** I added `stageWrites: false` to `finalEvaluationFixture` in
`src/qa-orchestration.test.ts` — production's no-op writing stage — and printed
what the orchestrator recorded. `pnpm vitest run src/qa-orchestration.test.ts -t "QA PROBE"`:

```
PROBE phase: PASS
PROBE decision: evaluate
PROBE finalTreeId: ca73af39ebc5d6ea3843adf34caadd09d8d3fb0a
PROBE baselineTreeId(record): 6e874143d63a38bcf223f1529f0945c5b9732e3e
PROBE finalCalls: 0
PROBE reuse events: 0
```

With nothing written after approval the two tree IDs still differ, so
`decideFinalReuse` returns `evaluate`. The cause is structural, not incidental:
`writeApprovedBaseline` records `checkpoint.treeId` — the QA checkpoint — at
`src/orchestrator.ts:6272`, while the tree the final decision reads is the
accepted checkpoint resolved at `src/orchestrator.ts:6574`, which
`reviewArtifactViolations` deliberately permits to differ by `qa-report.md`,
`qa-review.json` and `stuck.md`. Those bytes are committed before the reuse
decision runs, so the baseline tree and the final tree can never be equal.

Consequently `src/orchestrator.ts:6635` introduces a second, undeclared
comparison — `postApprovalWriteChangedTree = finalTreeId !== acceptedTreeId` —
and it, not `decideFinalReuse`, is what decides whether an evaluator is
dispatched. `decideFinalReuse`'s `reuse` branch, the
`final-evaluation-reuse` event member in `src/run-events.ts`, and the
`## Final Evaluation Reuse` section in `src/logger.ts` are all dead code.

The only assertions for B-02 call `recordFinalEvaluation(...)` and
`logger.event({ type: "final-evaluation-reuse", ... })` directly, so they would
pass with the orchestrator's reuse branch deleted. The probe was reverted
(`git checkout -- src/qa-orchestration.test.ts`) and `pnpm run typecheck` re-run
green.

**What the contract expected:** "the orchestrator compares the final
checkpoint's tree ID against the `approved-baseline.json` record #91 already
writes. Equal means reuse: no final evaluator is dispatched, and the reuse is
recorded in the slice's own persisted final-evaluation record in
`src/run-state.ts`, as a run event in `src/run-events.ts`, and in the slice's
`run-summary.md` section." B-02: "A `reuse` decision dispatches zero
final-evaluator invocations and records the reuse in three named stores."
**What I observed:** A run whose post-approval stage writes nothing dispatches
zero evaluators (right outcome) but records `decision: "evaluate"`, journals no
`final-evaluation-reuse` event, and renders no reuse section. The contract's
central state — a recorded reuse — occurs in no run, and the dispatch decision
rests on a comparison the contract does not declare.

### Finding 2 — P-01 is asserted by grepping source text, so it cannot fail
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/qa-orchestration.test.ts`, `it("[behavior:P-01] adds no
second lock: the merge mutex in src/wave.ts is untouched")` reads `src/wave.ts`
and asserts `expect(wave).toContain("mergeMutex")`, then asserts three of this
slice's files do not match `/mergeMutex|makeAsyncMutex/`. No merge runs. The
assertion would still pass if the mutex's critical section were narrowed, as
long as the identifier survived. The actual evidence for P-01 is that
`git diff --name-only 4672247 HEAD` does not list `src/wave.ts` at all.
**What the contract expected:** P-01's `observableResult`: "an it on an existing
spawned scenario showing one mutex-serialized merge; no new lock primitive in
the diff."
**What I observed:** Only the second half is checked, and by string search over
source bytes rather than by observing a merge.
