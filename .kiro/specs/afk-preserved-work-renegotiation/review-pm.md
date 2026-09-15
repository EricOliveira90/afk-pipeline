# PM review — PRD 9: Preserve-work contract renegotiation

**Verdict:** ACCEPT-WITH-NOTES

Scope judged: slices 01 (#277), 02 (#278), 03 (#332), 04 (#333), 05 (#334),
06 (#335). The full manifest ran; #336 is a deliberate deferred successor and
is judged only in the out-of-scope section below.

## What I verified myself

I read `prd.md`, all six slice contracts, and the implementation. I ran one
narrow probe (`parsePipelineRuntimeOptions` with a well-formed request) and one
test file (`src/cli-options.test.ts`, 99 passed). I did not re-run the suite.

| PRD promise | Where it lands | Verdict |
|---|---|---|
| Interface: one selector, non-blank reason, `--extend-scope` only with both, duplicate-free | `src/cli-options.ts:173-306` — separate messages for second occurrence, comma list, repeated selector, blank reason, orphan `--extend-scope` | Delivered |
| Canonical identity: reason is `trim()` only; target is `{number, ghIssue}` corroborated against persisted scope; ambiguous selector refused | `src/preserve-work-recovery.ts:256-286` (`reason: request.reason.trim()`, `selector-ambiguous` when two entries match) | Delivered |
| Scope fingerprint: SHA-256 over the exact shape, key order not inherited from a literal, persisted slice order | `:597-620` — keys emitted explicitly; one encoder shared by admission and completion | Delivered |
| Admission step 1: in scope, registered worktree at the recorded branch, clean tree, commits ahead, valid locked pair, slice branch already contains the feature head, no ref moved | `:750-847` — six ordered read-only refusals; git surface is three injected predicates (`hasUncommittedChanges`, `countCommitsAhead`, `isAncestor`), so no merge/reset/rebase is reachable | Delivered |
| Admission step 2: every extension member an AFK slice in `issues.md`, allowed by `afk.json`, absent from scope, identity-consistent, blockers scoped or in the same set; no state change on refusal | `:371-486` — six distinct `extension-*` codes; resolver is pure and called before any publication (`:1244-1258`) | Delivered |
| Admission step 3: byte-copied immutable snapshot, temporary sibling, verified before atomic publish, never overwritten | `:884-954` — verification reads the bytes *in the temporary sibling*, `renameSync` publishes, an existing directory is `snapshot-already-published` | Delivered |
| Admission steps 4-5: recheck under the ADR 0056 lock, then one `PENDING` append as the first admitted mutation, carrying reason, full extension set, provider, both heads, fingerprint, locator, original pair fingerprints | `:1292-1419` — pair, both tips, slice branch, target identity, scope fingerprint, open-attempt and extension set all rechecked as values; refusal leaves the snapshot inert and appends nothing | Delivered |
| Attempt execution (#332): live negotiation bytes into immutable history, then delete only those; clear only the checkpoint and convergence entry | `:1590-1682` — history published before any deletion; `reviews/` and every implementation/QA artifact untouched; proven against a resumed run's whole document in `src/resume-integration.test.ts:1291-1351` (only `stageCheckpoints` and `contractConvergence` differ) | Delivered |
| Failure semantics: verified restore then `ROLLED_BACK`, else `ROLLBACK_FAILED` with observed fingerprints and a dispatch hold | `:1770-1861` (reread + byte compare + locked-pair revalidation + original-fingerprint compare), `:2005-2082`, `:2543-2559` | Delivered |
| Launch reconciliation (#334): first act of a launch, before resume and dispatch; a launch without an exact request stops and tells the operator to retry | `src/orchestrator.ts:8499-8541` at the top of `runPipeline`; `src/resume-integration.test.ts:1192-1281` proves zero provider invocations, no worktree, no slice branch, resume counter still 2, scope untouched, and one operator line per target | Delivered |
| Completion + scope atomicity: one locked transaction rechecks the same `PENDING` attempt and the admitted fingerprint, revalidates the additions, then publishes one document holding the terminal event *and* the whole extension set | `:2274-2519` — single `transactRunState`; `appendRecoveryLineageEvent` and `appendScopeExtensions` in the same body with no seam between them; `src/preserve-work-recovery.test.ts:4796-4845` shows exactly `recoveryLineage` and `scope` moving and the additions becoming schedulable, `:4867-4890` shows neither half on disk when the attempt stops trailing | Delivered |
| Additions non-executable while `PENDING` | `src/preserve-work-recovery.test.ts:4551-4586` — resolved scope, skip reasons and DAG identical to a run with no attempt | Delivered |
| Replay: exact repeat is a no-op; different target, reason, partial or different set is refused naming the completed attempt; a genuinely newer lock admits normally | `:1068-1172`, `:1232-1262` — keyed on the *pair*, so a repeat cannot snapshot the replacement as if it were the original | Delivered |
| Failure matrix rows | Each row has a code and a test: pre-admission refusals write no lineage, `completion-cas-lost` ends through the one rollback writer, `ROLLBACK_FAILED` holds dispatch, v6 run-state files still load at v7 | Delivered |

Nothing in the selected slices is missing, and no promised outcome is wrong in a
way an operator could reach today. The three notes below are accuracy and
reachability, not behavior.

## Notes

### P-01 — operator-facing text still names #335 as the unshipped blocker

Three strings shipped in this tree tell the operator to wait for #335, which
merged on this branch (`29cc87f`, `870ae0a`):

- `src/cli-options.ts:480-487`. I ran the parser against
  `--renegotiate-stale 1 --recovery-reason stale` and got, verbatim:
  *"--renegotiate-stale is refused until #335 lands: verified rollback (#333)
  and launch-time reconciliation (#334) are unshipped, so an admitted recovery
  attempt could not be completed or undone."* All three named slices are on
  this branch (`574a82c`, `4a65d60`, `29cc87f`), so every clause of the reason
  is false in the tree that prints it. The operator is pointed at a landed
  slice instead of at #336, the slice that actually removes the refusal.
- `src/preserve-work-recovery.ts:2903` and `:2909`
  (`describeRecoveryReconciliation`): *"the target stays held until #335's
  attempt-state reporting can resolve it"* and *"This hold is intentionally
  terminal until #335 supplies the completion path"*. This one is reachable in
  a live launch — `src/orchestrator.ts:8519-8521` logs it per reconciled
  target — and `src/resume-integration.test.ts:1252` pins the literal
  `"terminal until #335"` out of a real `run.log`.

Non-blocking: slice 06's contract froze `src/cli-options.ts` and its refusal
tests (P-04, `contract.md:229-231`), so the CLI wording could not be corrected
inside this run's scope. The behavior is right; only the slice number in the
explanation is stale.

### P-02 — the PRD's own delivery table now contradicts the shipped cut

`prd.md:39` still says *"#335 removes the refusal"*, and `prd.md:51` still
promises the three flags on all three entry points. `issues.md:72-95` — which
`prd.md:7` names the authoritative slice table — records the maintainer-approved
2026-09-14 second cut moving refusal removal and CLI wiring to #336, with the
governing evidence in `escalations/slice-06-2026-09-14/`. Both readings cannot
be right, and the next human to read `prd.md` alone will expect a working
`--renegotiate-stale` on this branch. The code follows `issues.md`; the PRD
sentence is the stale one.

### P-03 — the protocol is complete but not yet reachable from the command line

`admitStaleRenegotiation`, `executeRecoveryAttempt`, `completeRecoveryAttempt`,
`recoveryPreDispatchRefusal` and `recoveryDispatchRefusal` have no non-test
caller: I grepped every `src/*.ts` outside the module and its tests, and the
only production call site added by this branch is `reconcileRecoveryLineage` in
`src/orchestrator.ts:8515`. The three flags are also deliberately absent from
usage output (`src/cli-entries.test.ts`). So the *user-visible* delta of this
branch is: three flags that refuse with an explanation, and a launch that
reconciles-and-stops if a lineage ever exists.

I judged this a note rather than a blocker for two reasons I checked rather than
assumed. First, the deferral is the approved cut, not a slip: slice 06's
contract (`contract.md:186-199`) and `issues.md:96-103` both name #336 and
explain why it cannot be slice 07 (a persisted scope may be narrowed, never
grown). Second, it exposes no user to risk: because admission is unreachable,
no `PENDING` or `COMPLETED` lineage can exist in a real run, so the one
PRD-promised guard that is exported-but-unwired — the pre-dispatch fingerprint
reread (`prd.md:217-219`, shipped as `recoveryPreDispatchRefusal`,
`:2597-2628`) — cannot be bypassed by anything an operator can do today.

## Out-of-scope PRD gaps (for the human operator, not the verdict)

All of these belong to #336, the deferred successor, and none of them is a
defect in the six slices this run selected:

1. `prd.md:51-57` — the three flags are parsed and refused, never honored. No
   operator can start a recovery on this branch.
2. `prd.md:217-219` — the pre-dispatch fingerprint check exists as a predicate
   but is wired into no dispatch site (`src/wave.ts` is unedited).
3. `prd.md:193-195` — *"A launch carrying the exact request may admit a new
   attempt after reconciliation"* is unreachable while the entry-point refusal
   stands; the launch always stops after reconciling.
4. `prd.md:151-158` — the explorer plus planner/evaluator rerun is *enabled*
   (the checkpoint and convergence entry are cleared) but never dispatched;
   slice 03 non-goals that wiring explicitly.
5. Attempt state is readable from run state only — no `afk status` surface, no
   run event, no run-snapshot field.

Operator action I would take before closing #276: correct `prd.md:39` and
`prd.md` line 51's reachability caveat to name #336, and fold the three stale
"#335" strings into #336's scope so the first live recovery run prints a true
reason.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Operator-facing refusal and reconciliation text names #335 as unshipped although it merged on this branch","class":"PRODUCT","clearCondition":"The CLI refusal message in src/cli-options.ts and the two describeRecoveryReconciliation strings in src/preserve-work-recovery.ts name #336 (or the actual remaining gap) instead of asserting that #333/#334/#335 are unshipped.","disposition":"OPEN"},{"id":"P-02","title":"prd.md still says #335 removes the entry-point refusal, contradicting the approved second cut in issues.md","class":"DOCS","clearCondition":"prd.md's Delivery slices section and Interface caveat name #336 as the slice that removes the refusal and makes the flags reachable, matching issues.md.","disposition":"OPEN"},{"id":"P-03","title":"The recovery protocol is complete behind exported seams but reachable from no CLI or dispatch site, so no PRD user outcome is exercisable end to end","class":"PRODUCT","clearCondition":"#336 removes the entry-point refusal and wires admission, execution, completion and the pre-dispatch fingerprint check into the launch and dispatch paths, with one end-to-end run proving an operator-initiated recovery.","disposition":"OPEN"}]}
