# PRD 9 run outcome — preserve-work-renegotiation (2026-09-14, run-20260914-001821)

**Terminal state: ESCALATE (NON_CONVERGENCE) — contract negotiation for slice #277
exhausted its 2-round hard cap with 5 unresolved blocking findings. No code was
generated; no draft PR was opened. This is a correct pipeline outcome (a verdict,
not an infrastructure death), couriered here for a maintainer decision.**

- Run host: fresh clone `C:\Code\afk-run-prd9`, branch `docs/preserve-work-renegotiation`
  @ `49bd5ab` (= PR #282 head, rebased onto origin/main `bff786d`). Root `C:\Code\afk` untouched.
- Launch command (per readiness report, typecheck-mandatory flag included):
  `node C:/Code/afk-run-prd9/dist/afk-claude.js --prd-dir C:/Code/afk-run-prd9/.kiro/specs/afk-preserved-work-renegotiation --test-command "pnpm run typecheck && pnpm test:fast"`
  via detached wrapper `C:\Code\afk-run-prd9\.afk\launch-prd9.cmd`.

## Per-slice outcome

| Slice | Outcome | Phase stopped in |
|---|---|---|
| #277 Crash-recoverable preserve-work renegotiation | ESCALATE | contract negotiation (round 2/2, verdict REVISE) |
| #278 Atomic additive split-scope extension | NOT-RUN | held back by unresolved dependency #277 |

## The decision request (couriered, not decided)

Full verbatim artifact: `C:\Code\afk-run-prd9\.afk\artifacts\afk-preserved-work-renegotiation-claude-code\slice-01\stuck.md`
(plus `intervention.json`, `contract-negotiation-outcome.json`, `feedback-r1.md`, `feedback-r2.md`,
round-by-round reviews in `reviews\`). Preserved candidate tree
`d52ea8f5b37c4c9edda153687c166160dcb57c03` in that clone's object DB holds the
exhausted negotiation's contract pair.

The substance: ticket #277's behavior set (15 behaviors, B-01..B-15) is larger
than one generator session can deliver. In round 2 the **planner proposed a cut**:
keep B-01..B-07 (+ preservation behaviors) and defer B-08..B-15 to four follow-up
issues under parent #276 — (1) recovery attempt execution, (2) recovery rollback
and fail-closed hold, (3) launch-time recovery reconciliation, (4) recovery
completion, replay and reporting — with a launch-time refusal guard so no real run
can create a PENDING recovery attempt whose rollback is deferred. The **evaluator
blocked the revision** because only contract.md was narrowed: acceptance-manifest.json
still declares B-08..B-15 as gated behaviors, making the pair self-contradictory
(each deferred behavior demanded by one artifact, forbidden by the other), and the
fileScope cuts orphaned the evidence for F-07 (P-03/P-06 scenarios describe work the
revised contract no longer does) and F-08 (B-06's observableResult names a
resume-integration assertion in a file no longer in fileScope). The round cap ended
negotiation before the planner could reconcile the manifest half.

**What the maintainer owns:** whether to adopt the planner's scope cut (or decide a
different one) for #277. Per stuck.md, record the decision in the source issue body
(#277) or an ADR — the evaluator's "Clear when" lines give the exact reconciliation:
remove B-08..B-15 from the manifest behaviors array (F-01/F-02/F-03, also resolves
advisory F-04), restate the manifest's P-03/P-06 to the narrowed contract's claims
(F-07), and rename B-06's observableResult to a test file inside fileScope, e.g.
`src/preserve-work-recovery.test.ts` (F-08). If the cut is adopted, the four
follow-up issues should be filed under #276 (the contract's non-goals route them
"before #278").

**Safe next action after the decision:** rerun the same launch command from
`C:\Code\afk-run-prd9` (state file present; negotiation restarts at round 1 carrying
F-01/F-02/F-03/F-07/F-08 as durable lineage; #278 dispatches after #277 passes).
If main moves before the rerun, repeat the prep-branch rebase first (readiness
report caveat).

## State of the world

- `feat-claude-code/afk-preserved-work-renegotiation` and
  `afk-claude-code/afk-preserved-work-renegotiation-slice-01-crash-recoverable-preserve-work-renegotiation`
  pushed to origin (both at `49bd5ab`; zero unique commits — the run never reached
  the generator, so no work exists only locally).
- Slice worktree `C:\Code\afk-run-prd9\.afk\worktrees\afk-claude-code-afk-preserved-work-renegotiation-s01`
  left in place (holds the working negotiation artifacts; clean tree, untracked spec
  slice dir only). Not cleaned — `clean-failed` only on request, and the rerun resumes here.
- Draft PR #282 (prep branch) unchanged. No PR opened for the feature branch (nothing to review).

## Steps skipped, with reasons

- Project preflight script: none exists in this repo (`package.json` has no
  `afk:preflight`); ran the repo's authoritative checks instead — `lint:tickets 277 278`
  PASS and `--dry-run` PASS from the fresh clone.
- Post-merge extras (migration push, UAT, preview checks): repo has none.
- Contract-vs-non-goals check at lock time: no contract ever locked (escalation
  occurred at the cap), so the check had no object.

## Throughput evidence (events.jsonl, run-20260914-001821)

- Wall clock 18m58s, single lane (wave 1 = #277 alone; wave 2 never dispatched).
- Phases: explorer 4m14s → planner r1 4m14s → evaluator-contract r1 2m13s (REVISE,
  3 blocking) → planner r2 5m12s → evaluator-contract r2 3m01s (REVISE, 5 blocking) → ESCALATE.
- Lane-leader wait before generator: n/a — no generator invocation occurred.
- Lane-successor discarded negotiation: n/a — #278 was never dispatched, so nothing was discarded.
- Test cost per writing round: zero writing rounds ran; no test or typecheck commands
  were executed by any role. (One earlier aborted launch, prd9.out.log, died in <1s:
  fresh `git clone --branch <prep>` has no local `main`; fixed with
  `git branch main origin/main`. Worth folding into the launcher or the skill notes.)
- Bound fired: contract-round hard cap (2/2) on slice #277, at 18m56s elapsed —
  the only bound consumed; 2/2 resume attempts and 3/3 implementation rounds untouched.
