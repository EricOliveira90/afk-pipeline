# PM / product review — PRD 4, slice 04 (#96) only

**Verdict:** ACCEPT-WITH-NOTES

Scope judged: slice 04 "Final evaluation and reuse" (#96). Slices 01–03 and
05–08 were not run by this invocation and are not judged here.

## What the PRD promised for this slice, and what a user gets

Slice 04 owns D20 (exact-tree reuse), D19's final-evaluation bound, D9's new
`evaluator-final` role, D11's baseline→final change-summary variant, and D10's
tree-keyed evidence as read (not written) by this slice. Each promised outcome is
present, and — unlike the seam-shaped findings earlier rounds raised against
#195 — every new export has a production call site I could follow.

- **An unchanged tree costs zero final-evaluator invocations** (D20). The reuse
  decision is a pure function (`src/final-evaluation.ts:89-137`), and its single
  production call site is `src/orchestrator.ts:6704-6715`, reached after the
  candidate checkpoint and before `dispatchAcceptedCandidate` (`:7297`) — i.e.
  before the merge, which stays in `src/wave.ts` under the one existing mutex
  this slice does not touch. On `reuse` the block records the decision in run
  state (`recordFinalEvaluation`, `:6724-6735`), journals exactly one
  `final-evaluation-reuse` event (`:6743-6750`) and renders a
  `## Final Evaluation Reuse` section from those events
  (`src/logger.ts:589-611`) — the three stores B-02 promised, and no
  `GateEvidence` field or D17 gate-cache `reused` flag is written (no
  `src/gate-runner.ts` change appears in `git diff --stat main...HEAD`).
- **A changed tree is evaluated, with no cosmetic exception.** Equality is plain
  string comparison; there is exactly one comparison deciding the dispatch (the
  earlier `postApprovalWriteChangedTree` second test is gone from the tree — I
  grepped, no occurrence remains). A `null` baseline and an invalidated tree both
  answer `evaluate`, so the fail-closed reading is the default. `pnpm vitest run
  src/final-evaluation.test.ts` → 47 passed, 349ms (my own run).
- **A fresh final evaluation is a real, bounded review.** `MAX_FINAL_EVALUATION_ATTEMPTS
  = 3` in `src/bounds.ts:59` with a remaining-budget helper; the loop at
  `src/orchestrator.ts:6826-7266` re-resolves the tree per attempt, re-runs the
  `scope` gate *on that tree* (`:6910-6966`), dispatches exactly one
  `evaluator-final` in a disposable worktree at the final checkpoint
  (`:7000-7077`), archives each attempt under a per-attempt name
  (`final-review-rN-aM.json` / `final-report-rN-aM.md`, `:7086-7111`), and
  persists the attempt entry after every attempt so a killed run cannot get the
  attempt back (`persistAttempts`, `:6804-6822`). A crashed evaluator still
  spends its attempt (`:7062-7073`).
- **The merge is blocked when the final verdict cannot be reached.**
  `decideFinalVerdict` (`src/final-evaluation.ts:455-509`) names each unmet
  condition independently and treats an absent artifact key, an unparsed review
  and an absent final scope-gate status as blockers rather than defaults; the
  orchestrator turns a non-PASS into `phase: "ERROR"` before the accept dispatch
  (`:7277-7286`). A review keyed to another tree is not accepted as evidence
  about this one (`:7228-7237`).
- **A finding names its own remedy** (D9/ADR 0048). `REPAIRS_BY_CLASS`
  (`src/final-evaluation.ts:223-229`) refuses a `PRESERVATION` finding with
  anything but `RESTORE` and a `BASELINE_IS_WRONG` finding with anything but
  `RETURN_TO_GENERATOR` *at parse time*, so an inadmissible pairing never gets
  routed. `RESTORE` goes to the single post-approval stage (`:7209-7213`) and
  costs an attempt; a baseline-is-wrong return invalidates the rejected tree
  (`invalidateFinalEvaluationBaseline`, `:7157-7162`), records the attempt as
  `RETURNED_TO_GENERATOR` with zero graded outcome, and re-enters the generator
  loop, spending exactly one generator round (`:7267-7275`) — D19's "never
  consumes an evaluator round" as promised. Afterwards `decideFinalReuse` refuses
  `reuse` against that tree even on exact equality (`:118-129`).
- **The evaluator can only return its own two artifacts.**
  `QA_WINDOW_ARTIFACT_NAME` (`src/post-qa-gates.ts:52-53`) admits
  `final-review.json` and `final-report(-rN-aM).md` and nothing else, and the
  same constant is passed to `scanReviewWorktreeWrites`, which journals every
  other write as a `reviewer-write-violation` (`src/orchestrator.ts:7046-7060`).
- **Nothing archives a final artifact under the wrong prefix.**
  `qaArchivePrefix` is a three-way map (`src/artifacts.ts:677-681`) and
  `final-evaluation` is a first-class `QAReviewStage` with its own filename,
  record and resume replay (`src/qa-review.ts:69-86, 145-146, 771`); the QA
  parser explicitly refuses to read `final-review.json`, so the two schemas
  cannot be confused (`src/qa-review.ts:447-451`).
- **The evaluator reads a code-generated, per-stage-attributed diff.**
  `buildFinalChangeSummary` / `writeFinalChangeSummary`
  (`src/change-summary.ts:291-370`) reuse the one existing two-ref builder and
  add `byStage` plus `stageOrder`; the prompt names it as the first thing to read
  (`prompts/evaluator-final.md:24-28`). `prompts/evaluator-final.md` asks exactly
  the two promised questions (preservation, gate-invisible drift, `:43-59`) and
  tells the reviewer its worktree is disposable and probes are free (D14, `:20-22`).

## Notes (not blocking)

### P-01 — the reuse section tells the operator a reason its own table contradicts

`src/logger.ts:598-600` states "The final checkpoint was byte-identical to the
approved baseline", directly above a table whose `Final tree` and `Baseline tree`
columns are, in every production reuse, different strings. My own reading of the
producers: the baseline is recorded at `checkpoint.treeId`
(`src/orchestrator.ts:6272-6276`), captured *before* the QA evaluator writes
`qa-report.md` / `qa-review.json`, while `finalTreeId` is the accepted tree with
those artifacts committed (`:6574`, `:6592-6626`); the event carries the
baseline's own `treeId` (`:6749`). So the two columns differ by construction, and
neither the event nor the section carries the authorized tree ID
(`baselineAuthorizedTreeId`, `:6688-6703`) that would reconcile them. The
behavior is right and the reuse is honestly recorded; only the explanation an
operator reads is wrong. Clear condition: the section (and the
`final-evaluation-reuse` doc comment in `src/run-events.ts`) either states
equality against the *authorized* tree or carries that tree ID in the row.

### P-02 — D20's comparison is against the authorized tree, and prd.md does not say so

D20 reads "Compare the final checkpoint's tree ID against
`approved-baseline.json`". As shipped, the comparison is against the accepted
tree, offered as `approvedTreeId` only after `reviewArtifactViolations` proves the
QA window (plus any orchestrator-audited scope-amendment blobs) explains every
differing path (`src/orchestrator.ts:6688-6703`;
`src/final-evaluation.ts:41-64`). I agree this is the only reading that delivers
D20's promised outcome — a literal comparison against the graded tree can never
be equal, so every production run would dispatch a final evaluator — and the
excepted paths are review artifacts the accept seam already authorizes, so no
code change escapes review. The note is that the PRD's D20 sentence and the
shipped rule differ in a way a later reader cannot reconstruct. Clear condition:
prd.md D20 records the QA-window/authorized-tree qualification, or the comparison
is moved onto a baseline record keyed to the accepted tree.

## Out-of-scope PRD gaps (for the operator, not driving the verdict)

- The post-approval writing stage is a production no-op (`B-03`, PRD 5 owns the
  cleaner/hardener), so in a production run the reuse branch is the only branch
  reached and the whole final-evaluation dispatch path is exercised through the
  injected stage in tests. That is what the contract and prd.md's Out of Scope
  authorize; recorded so the operator knows the evaluator is not yet load-bearing
  in production.
- Role write-scope enforcement (D4) is still a seam owned by #226, explicitly not
  #96's.
- D18's derived verification command, the `feedback-integrity`/`acceptance` gates
  and the merge-resolution re-run belong to slices 05, 02/07 and 06 — not run by
  this invocation.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Final Evaluation Reuse section claims byte-identity while its own two tree columns differ","class":"PRODUCT","clearCondition":"The run-summary section and the final-evaluation-reuse event state equality against the authorized tree, or carry that authorized tree ID in the row, so the prose and the table agree.","disposition":"OPEN"},{"id":"P-02","title":"Reuse compares against the QA-window-authorized tree, a qualification prd.md D20 does not record","class":"PRODUCT","clearCondition":"prd.md D20 records that the comparison is against the accepted tree proven to differ from the graded baseline only by QA-window and orchestrator-audited paths, or the baseline record is keyed to the accepted tree so the literal comparison holds.","disposition":"OPEN"}]}
