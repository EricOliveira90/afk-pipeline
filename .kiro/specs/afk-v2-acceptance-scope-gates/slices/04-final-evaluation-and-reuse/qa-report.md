# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran here (exit 0; the skip authorization does
not cover the install). `pnpm run typecheck` was re-run rather than cited and is
green. The change-summary artifact named in the brief
(`.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-04/change-summary.json`)
does not exist in this worktree — `.afk/` is absent entirely — so the changed-file
set was read from `git diff --stat main...HEAD` instead.

Boundary: the diff touches exactly the 21 paths in `## Files expected to change`
plus this slice's own `.kiro/specs/.../04-final-evaluation-and-reuse/` pipeline
artifacts. No undeclared source path, no migration. The two `M` entries in
`git status` are CRLF normalization noise on the contract and manifest, not
content edits (`git diff` on them reports only the LF/CRLF warning and no hunks).

Preservation: P-01 through P-06 all hold. `src/wave.ts` is untouched and no new
mutex primitive appears in the diff; `qaArchivePrefix` still returns `qa`/`uat`
and `qaReviewFilename` still maps the two existing stages; `recordApprovedBaseline`
remains the only baseline writer and the invalidation probe confirms
`approvedBaselines["70"]` survives byte-for-byte; the candidate change-summary
variant and `ChangeSummary` v1 are unchanged with one shared two-ref builder;
`reviewArtifactViolations` still names a source write and a stray note as
violations alongside the two admitted final artifacts; a `version: 4` state file
loads with its #91 locator and #193 waivers intact and gains a `finalEvaluations`
reader.

The `src/run-state.test.ts` edit matches P-06's authorization exactly: nine
changed lines — the eight current-version assertions moved `4` → `5` and the
`:1491` title retitled — with the four `version: 4` input fixtures left at `4`.

I ran the touched suites as probes: `src/final-evaluation.test.ts`,
`src/change-summary.test.ts`, `src/qa-review.test.ts`,
`src/post-qa-gates.test.ts`, `src/bounds.test.ts`,
`src/context-envelope.test.ts`, `src/run-state.test.ts` — 318 tests, all pass —
and the `final evaluation and reuse` block of `src/qa-orchestration.test.ts`,
6 tests, all pass. Nothing in this report is a red test; the findings are
behaviors the contract required that the passing tests do not cover.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: NOTES

Pass 2 was evaluated because the Pass 1 command checks are clean; the findings
below are contract-intent and test-honesty findings, not command failures.

Craft is high where the slice landed: `decideFinalReuse`, `parseFinalReview`,
`buildFinalChangeSummary` and `decideFinalVerdict` are genuinely pure, named for
what they decide, and their comments explain the *why* (D20's refusal of a
cosmetic-change exception, the tiling invariant, the reuse-marker/gate-cache
distinction) rather than restating the code. The `retryStage` refactor in
`src/qa-review.ts` is behavior-preserving — I checked the four interesting
combinations of `(deterministic, sharedPreview)` last-implementation-rounds
against the old ternary chain and the new loop agrees, including the tie going
to the earlier stage. The negative test lists (`final-report.md.bak`,
`nested/final-review.json`, `final-report-r0-a1.md`) are the kind of allowlist
coverage that actually catches a widened regex.

The notes are QA-06 (a double parse of the same artifact) and the test-honesty
issues folded into QA-01 and QA-04.

## Resolved findings
- None. This is round 1 of this QA stage; no findings were routed into it.

## Findings

### Finding 1 — No `evaluator-final` dispatch exists; a post-approval write aborts the slice instead of being reviewed
**Severity:** Blocker
**Pass:** 1
**Evidence:** `Select-String -Path src/*.ts -Pattern 'evaluator-final'` returns
only `src/context-envelope.ts` (the manifest literal and the
`ContextEnvelopeRole` union), `src/context-envelope.test.ts`, and two doc
comments. `src/orchestrator.ts` contains no occurrence of the string, no
`invoke()` for the role, and no disposable review worktree for a final stage.
The only new orchestrator branch reads `final-review.json` off disk and returns
`{phase: "ERROR"}` when it is absent. Probe — I added
`console.log("QA-PROBE-BLOCKERS:", error)` to the B-03 spawned scenario and ran
`pnpm vitest run src/qa-orchestration.test.ts -t "refuses to merge the tree it dirtied"`:

```
QA-PROBE-BLOCKERS: Final evaluation cannot pass the tree 9ae666c0a2477663d134fb1b79858873b8ffe8d7:
the final artifacts are keyed to no tree rather than the final tree 9ae666c0...;
final-review.json did not validate: final-review.json was not written;
the scope gate on the final candidate is absent, not PASS.
The approved baseline authorizes no tree (#96 B-11).
```

The slice aborted because nobody wrote the artifact, not because a reviewer
judged the tree. (Probe reverted; the worktree is back at the graded tree.)

**What the contract expected:** scope lock — "Different means one fresh
final-evaluation attempt: a new `final` review stage dispatches a new
`evaluator-final` role in a disposable worktree with a code-generated
baseline→final change summary partitioned per post-approval writing stage, and
that evaluator may return only `final-review.json` and `final-report.md`."
`acceptance-manifest.json` B-03 `observableResult`: "an it on an existing spawned
scenario shows one evaluator-final invocation after the stub write."

**What I observed:** Zero evaluator-final invocations are reachable. The
delivered scenario asserts `result.phase === "ERROR"` and asserts no invocation
at all. `FINAL_EVALUATOR_CONTEXT_MANIFEST` and `prompts/evaluator-final.md` exist
and are well written but have no consumer; the doc comment at
`src/context-envelope.ts:751-757` claims evaluator-final's prompt "is still
rendered directly by the orchestrator", which is not true of this tree.

### Finding 2 — The wired final verdict can never return PASS
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/orchestrator.ts` derives `finalEvidence` from
`postQaGates.artifacts[postQaGates.artifacts.length - 1]` — evidence captured
*before* the post-approval writing stage runs — then passes
`scopeGateStatus: finalEvidence?.treeId === finalTreeId ? gateStatusOf(SCOPE_GATE_ID) : null`.
That branch is entered only when `postApprovalWriteChangedTree` is true, i.e.
only when `finalTreeId !== acceptedTreeId`, and `finalEvidence.treeId` *is*
`acceptedTreeId`. No gate is re-run on the final tree anywhere in
`git diff main...HEAD -- src/orchestrator.ts`. The probe output in Finding 1
shows the resulting permanent blocker: "the scope gate on the final candidate is
absent, not PASS".

**What the contract expected:** B-11 — "The final verdict is `PASS` only when
every required gate is green, the candidate and final artifacts are keyed to
their exact checkpoint tree IDs, canonical validation of `final-review.json`
succeeds, and the scope gate is green on the final candidate; any one of those
missing fails closed", with a unit test "asserting PASS once".

**What I observed:** `decideFinalVerdict` is correct in isolation and its unit
tests pass, but the call site hard-wires `scopeGateStatus` to `null` in the only
reachable branch. Even a valid `final-review.json` keyed to the exact final tree
cannot produce PASS. The PASS case is proven only against hand-built arguments,
never against the wiring — so the orchestrator's post-approval path is a
guaranteed slice ERROR rather than a fail-closed verdict.

### Finding 3 — The persisted record has an attempt count where the contract declares per-attempt entries
**Severity:** Major
**Pass:** 1
**Evidence:** `src/run-state.ts:104-113` defines `PersistedFinalEvaluation` with
`attempts: number` and no per-attempt collection.
`invalidateFinalEvaluationBaseline` (`src/run-state.ts:972`) copies
`attempts: existing?.attempts ?? 0` and marks nothing per attempt. No test
asserts an attempt entry reading as invalidated; the delivered B-09 test asserts
only `invalidatedCandidateTreeIds` and the dropped citation. `attempts` is never
incremented anywhere in `src/` outside tests.

**What the contract expected:** B-02 item 1 — the record "carries `decision`,
`finalTreeId`, `baselineTreeId`, the `baselineArtifactPath` it read, and
per-attempt entries"; the "New patterns" section repeats "attempt entries";
`acceptance-manifest.json` B-09 `observableResult` — "a unit test asserting the
invalidated tree ID **and attempt entries** read back through
`finalEvaluationFor`".

**What I observed:** There are no attempt entries, so `finalEvaluationFor` cannot
report any attempt as invalidated. A reader learns how many attempts were spent
but not which attempt was keyed to the rejected tree — the exact distinction
B-09 says the invalidation must make observable.

### Finding 4 — B-09's "one generator round" is asserted as a compile-time literal, and the return path does not exist
**Severity:** Major
**Pass:** 1
**Evidence:** `routeFinalReviewFinding` (`src/final-evaluation.ts:343`) returns
`{generatorRoundsConsumed: 1, finalEvaluationAttemptsConsumed: 0}`, typed as the
literals `1` and `0`; `src/final-evaluation.test.ts:218` asserts that object with
`toEqual`. The assertion cannot fail for any input.
`Select-String -Path src/*.ts -Pattern 'routeFinalReviewFinding|invalidateFinalEvaluationBaseline'`
shows both functions are called only from `src/final-evaluation.test.ts` and
`src/qa-orchestration.test.ts`; `src/orchestrator.ts` never reads a final
review's findings, never routes one, and never invalidates a baseline.

**What the contract expected:** B-09 — "a baseline-is-wrong finding invalidates
the downstream evidence keyed to the rejected candidate tree and returns control
to the generator loop, consuming a generator round and no final-evaluation
attempt", with the manifest asking for "the generator round counter incremented
by exactly one across the return".

**What I observed:** No round counter is read before or after anything. The test
observes two literals in a returned object and would still pass if the
orchestrator consumed zero or five generator rounds — and today it consumes
none, because the return path does not exist.

### Finding 5 — The three-attempt bound has no consumer
**Severity:** Minor
**Pass:** 2
**Evidence:**
`Select-String -Path src/*.ts -Pattern 'MAX_FINAL_EVALUATION_ATTEMPTS|finalEvaluationAttemptsRemaining'`
matches only `src/bounds.ts` (the definitions), `src/bounds.test.ts`,
`src/qa-review.test.ts`, and a doc-comment reference at `src/run-state.ts:107`.
Nothing in the dispatch path reads the bound or increments `attempts`.

**What the contract expected:** test plan — "Given three consumed
final-evaluation attempts, when a fourth is requested, then the bound refuses
it."

**What I observed:** A constant plus a clamped subtraction, both unit-tested,
refusing nothing. B-10's stated `observableResult` (a unit test on the bound plus
attempt-stamped archives) *is* met, which is why this is a minor note rather than
a blocker — but it stays dead until Finding 1's dispatch exists, so it belongs in
the same wiring round.

### Finding 6 — `final-review.json` is parsed twice over the same bytes
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/orchestrator.ts:6759` parses the file inside the
`reviewValidation` IIFE; `src/orchestrator.ts:6781` re-reads and re-parses the
same path to obtain `finalTreeId`.

**What the contract expected:** No explicit clause; this is Pass 2 craft against
the existing review-loading call sites, which parse once.

**What I observed:** Two reads and two parses of one artifact. The second could
observe different bytes than the verdict validated, and the duplication invites
the two to drift.
