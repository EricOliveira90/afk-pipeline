# AFK v2 — the single plan

One document: where the work stands, the seven PRDs in dependency order
(plus the post-plan PRDs 8–12 registered in §2b, their operator work in
§2c, and the current run-derived backlog in §2d), the agreed hardening set
from the plan debate, and a sequencing that pays the next runs first.

Three companion documents, each authoritative for its own scope:

- `afk-v2-agent-roles.md` — the role-by-role design and cross-cutting
  mechanisms M1–M7. This plan sequences that design; it does not restate it.
- `afk-v2-recovery-plan.md` — the historical record: Phases A–D of
  stabilising the pipeline, plus run-by-run evidence (runs 3–6).
- `afk-v2-plan-debate.md` — the refereed two-agent debate (2026-08-28) that
  produced §3 below: full ratings, the cut list with the arguments that
  killed each item, the audit trail of concessions, and the re-open
  triggers. Read it for *why an item survived or died*; read this document
  for *what happens next*.

---

## 1. Where the work stands

### PRD 1 — Evidence backbone (#69): complete

PR **#125** merged to main (`ab0e25a`, 2026-08-28); #69 closed. Full suite
passed on the merged head, all budgets green.

| Slice | State | How |
|---|---|---|
| #75 Undeclared scope cannot lock | PASS, merged `1540c9b` | AFK, after a hand-amended contract |
| #76 Every behavior locks with an executable binding | PASS, merged `ab18bc2` | Hand-finished |
| #77 Contract review fails closed | PASS, merged `d86b8f6` | Hand-finished |
| #78 Negotiation converges on open findings | PASS, merged `2b8eaa6` | AFK |
| #79 QA verdicts and retries run on the same rails | PASS, merged via #125 | AFK; review SHIP-WITH-NOTES + follow-ups |

The #79 follow-ups shipped inside #125: `df46f8a` (review note N3,
error-cause chaining), `f481faf` (#124, validation archive fails closed),
`8cccd2d` (#123, stale review archives relocated on restart), `575bd9b`
(the slice-05 artifact trail, matching slices 02 and 04).

Wave session s7 (clear-on-dispatch) must read the #123 fix (`8cccd2d`)
before designing — same behavioral area, different scope.

Three of five slices needed human hands. That is the headline fact for
planning the remaining PRDs: **the pipeline could not yet deliver its own evidence
backbone unattended**, and every failure that stopped it was an
infrastructure or governance defect, not a coding one. The debate's joint
finding compresses it further: *the pipeline does not lack checking; it
lacks memory of checking already done* — the measured waste was rigour
re-spent on itself (22.7–30.3 min of evaluator reading per round, ~13 min
of duplicated QA gates per round, ~35 min of redundant full-suite runs in
one generator round), while the genuine reliability gaps were all cheap
truth-on-exit gaps.

### Pipeline defects found by running AFK on itself

| Issue | Defect | State | Absorbed by |
|---|---|---|---|
| #113 | From-base restart destroyed unmerged commits | Fixed, merged | — |
| #114 | Windows stop bypassed the abort path | Fixed, merged | — |
| #111 | Run killed mid-round keeps the previous run's error message | Fixed, merged (PR #128, s7, ADR 0047) | §3 item 11 (clear-on-dispatch) |
| #112 | Contract-amendment gap: QA boundary findings satisfiable only by reverting work | Fixed, merged (PR #128, s9, ADR 0048) | reliability wave, as filed |
| #120 | Candidate's own compile failure classified INFRASTRUCTURE | Fixed, merged (PR #127, s1, ADR 0041) | §3 item 1 (one fix, one ADR — the plan previously double-counted these) |
| #121 | Process-fatal crash bypasses cancellation bookkeeping | Fixed, merged (PR #128, s3, ADR 0044) | §3 item 4 |

All six are one class: **the pipeline records or classifies something that
misleads the next actor.**

### Current delivery snapshot (2026-09-13)

- **Test-timing Wave A is complete on `main`.** The QA-orchestration split,
  six-worker fast suite, and opt-in git-process measurement landed in
  `8b129c4`, `4124297`, and `e85e338`. The quiet-host full-suite measurement
  is 1022.1 seconds (17m02s, 2560 tests), recorded under
  `_measured2026_09_13_wave_a@main`. This is PRD 12's first delivered wave,
  not pending implementation.
- **PRD 5's selected cleaner-only scope is complete.** PR #297 merged on
  2026-09-14; selected slices #87, #97, and #274 are closed. Parent #73
  remains open because the broader theme originally included #92, but that
  hardener slice and its mutation machinery were explicitly deferred and do
  not block this milestone's completion. Open review follow-ups #290–#296
  and #313–#316 likewise do not reopen the merged scope.
- **PRD 7's three implementation slices are complete.** #262–#264 merged
  through PR #287. Parent #152 remains open for explicit maintainer
  acceptance, while #284 and #286 are non-blocking follow-ups.
- **Preserve-work renegotiation is already PRD 9.** #276–#278 and draft
  PR #282 reserve that number. The later self-audit and mutation PRDs move
  to 10 and 11 below.

---

## 2. The seven PRDs, in dependency order — with the agreed deferrals

| PRD | Theme | Depends on | Slices | Debate changes |
|---|---|---|---|---|
| 1 (#69) | Evidence backbone | — | #75–#79 | run-ID provenance fields land at assembly (§3 item 11) |
| 2 (#70) | Routing and adjudication | 1 | #80, #81, #82, #89, #129 (AFK) + #94 (manual courier follow-up after #89) | carries `afk adopt` (§3 item 10, ticket #129); **defer story 14** (babysit-skill packaging; #94 rescoped to courier-only, manual) |
| 3 (#71) | Context envelopes and prompts v2 | 1 | #83, #90, #95, #99 | carries the candidate-evaluator manifest entry (§3 item 5), the ADR-index envelope entry, the `ARCHITECTURE.md` envelope entry, and the §3c escalation-criteria prompt text; **defer story 16** (live cross-provider parity matrix) with the fence: envelope *assembly* and stub-provider parity stay provider-agnostic at the interface (ADR 0002; #71 story 17's determinism requirement depends on it); the approved cheap-check → candidate-QA → full-suite sequence ships during this PRD as early #86 delivery |
| 4 (#72) | Acceptance and scope gates | 1, 3 | #84, #85, #91, #96, #86, #132 | carries §3 items 2, 5 (artifact), 12, 15 (#132), and 17; #86 credits PRD 3's early sequence but still owns policy selection, caching, prerequisites, and advisory gates; **defer story 9** (probe-as-evidence) and **story 15** (final-evaluator code attribution — moot while cleaner/hardener are off) |
| 5 (#73) | Quality loops | 4 | #87, #97, #274 delivered; #92 deferred | Selected cleaner-only scope merged via PR #297 on 2026-09-14. Cleaner + hardener remain **default off** under story 17 ROI governance (§3 item 8); #274 is the tail split from #87. Stories 9–15 and 19 — including #92 and all hardener/mutation machinery — remain explicitly deferred and are not a completion blocker. |
| 6 (#74) | Aggregate: guardians and remediator | 4 | #88, #93, #98 plus item 19 slice to ticket | under item 8 governance; final evaluator is free while cleaner/hardener are off (#72 story 13); recurring-finding proposals use the versioned learning-proposal schema, which lands by hand on `main` (`afk-v2-plan-debate.md` §7, R1) and is AFK-canonical, consumed by rumo-app #809 |
| 7 (#152) | Agent-behavior eval harness | 4 | #262–#264 | carries §3 item 18: report-only `afk eval`, versioned scenario packs, one case kind (`prompt-plus-expected-verdict`, every case citing a `source`; count = what the sources yield), and consumer-owned packs; implementation merged via PR #287, parent remains open for explicit acceptance |

The dependency logic: PRD 1 makes control-plane facts
machine-readable; PRD 3 shapes what each role receives before PRD 4 adds
roles; PRD 4 establishes the baseline that PRDs 5–7 build on. PRDs 2 and 3 are
dependency-independent **at the contract level only**: in practice they
serialize, because PRD 3's tickets consume PRD 2 outputs (#83 assumes
PRDs 1–2 landed; #71 names PRD 2's escalation instruction and computed
unresolved sets as inputs) and the two PRDs overlap maximally on prompts
and orchestrator files, so a concurrent launch fails §3c policy 5's
overlap condition. After PRD 4, **PRD 5 and PRD 7** could run concurrently;
both selected scopes are now merged. PRD 5's deferred hardener #92 does not
block later PRDs.
PRD 6 is the final implementation run; it no longer waits on PRD 7, because
the learning-proposal schema item 19 consumes lands by hand on `main`
(§2 PRD 6 row).

### 2b. PRDs added after the seven (registered 2026-09-13)

Numbering continues past the debate's seven. Same governance: nothing here
adds minutes to a happy path that did not opt in; new machinery defaults
off; recorded evidence — not argument — decides escalation or deletion.

| PRD | Theme | Depends on | Slices | Status and notes |
|---|---|---|---|---|
| 8 (#271) | Generator required-input budget | #270 (merged) | #273 | Replaces the generator's 65,536-byte inline-only limit with a 98,304-byte required-input budget (inline prompt + required worktree reads). Motivated by PRD 5 slice #87's dispatch failure. **Delivered 2026-09-14 as draft PR #331** (ACCEPT-WITH-NOTES from both guardians; every finding non-blocking). Its six ship-gate notes #325–#330 are triaged: #330 closed as a same-round cross-guardian duplicate of #326, #326/#327 `ready-for-human`, #325/#328/#329 `ready-for-agent` and all three gated on #331 merging, since none of the code is on `main`. Source: `.kiro/specs/generator-required-input-budget/intent.md`. |
| 9 (#276) | Preserve-work contract renegotiation | current `main` | #277, #332–#335, #278 (+ deferred #336) | Adds a supported, crash-recoverable path to reopen a stale locked contract without discarding landed slice commits, plus atomic additive scope extension for a spec-level re-slice. Prepared in draft PR #282. **Re-cut twice on 2026-09-14 for size** — see §2f. #277 admission, #332 attempt execution, #333 rollback hold and #334 launch reconciliation are merged into `feat-claude-code/afk-preserved-work-renegotiation`; #335 (completion and replay) and #278 are the remaining waves; #336 (reporting and launch wiring) is a deliberate deferred successor, outside this run's persisted scope. |
| 10 (#298) | Generator self-audit gate | none beyond current `main` | #299–#301 | Port of SwarmForge's two-call audit gate (R. C. Martin): one bounded post-generation audit invocation between the candidate gate phase and QA dispatch; verdict is exact git tree identity, never agent-certified (`AUDIT_UNCHANGED` / `AUDIT_CHANGED` / `AUDIT_NOT_RUN`); consumes no generator round; the changed-rate reports and never gates. `--self-audit`, default off. **Prepared 2026-09-13:** branch `prd/generator-self-audit-gate` (37950f4), tickets linted, dry-run verified (wave 1: #299; wave 2: #300 + #301). **Escalated 2026-09-14 on contract finding F-07 and decided:** slice #299's unchanged-tree obligation is narrowed to the stage-local fact its stage test proves, and the source-order scan is *not* extended into the QA argument list — #300 legitimately rewrites that argument list, so the extended scan would be a test #300 must delete (#319's stale-anchor class), it pins syntax rather than behavior, and an honest proof needs a spawned scenario that #299 AC13 and `AGENTS.md` both forbid. F-10's anchoring rule (anchor on `await runQAStage(`, exclude declaration occurrences) is stated in the same pass, and the value-level base-gate assertion moved to #300 with the substitution risk recorded there. Both decisions are in the issue bodies, which is the only channel the pipeline reads. **Rerun 2026-09-15 (`run-20260915-034116`, 161m09s): F-07 and F-10 both cleared and #299 merged; #301's contract locked and its generator then died on a transient provider API error (#358); #300 escalated on F-01/F-02/F-06 and awaits one maintainer choice recorded on the issue.** No ship gate and no draft PR, because a failed slice suppresses both. #300's escalation is not a disagreement — the planner wrote the three behaviors the evaluator asked for and #340 discarded them. Source: `.kiro/specs/generator-self-audit-gate/intent.md`. |
| 11 (#302) | Mutation survivor report | none beyond current `main` | #303–#304 | Report-only ship-gate mutation step behind `--mutation-report`: project-declared command + mutation-testing-elements JSON schema, differential scope from the change-summary builder, concurrent with guardians, flat 30-min bound, `MUTATION_REPORTED` / `MUTATION_NOT_RUN`, never blocks a ship. Survivors land in run-summary.md and the draft PR body, split new/pre-existing against a committed baseline, with adjudicated survivors marked accepted. This is the ROI instrument for the PRD 5 cleaner/hardener decision (item 8) without building the role. **Prepared 2026-09-13:** branch `prd/mutation-survivor-report` (7ed91d9), tickets linted, dry-run verified (wave 1: #303; wave 2: #304). **Escalated 2026-09-14 at planner round 1 on `LOAD_BEARING_SILENCE` and decided:** the consuming project declares the mutation command and the report path in one optional `mutationReport: { command, reportPath }` member of the PRD dir's `afk.json`, validated *and returned* by `parseAfkManifest` and read before any agent dispatch. These are durable per-project facts and `afk.json` is already the strictly-validated cross-repository contract for that kind of fact (ADR 0034); CLI flags would put a per-project fact on every launch line and would stop the refusal distinguishing a misconfigured project from an omitted flag; a `package.json` script convention holds a command but not a paired output path. The member stays optional and `afk.json` stays at `version: 1`, stated as a condition on the parser rather than a reserved number (#249). #304's baseline and decisions paths join the same member, recorded pre-emptively because #304 is wave 2 of the same run and would otherwise meet the identical silence mid-run. **Rerun 2026-09-15: the planner wrote a contract instead of escalating, so the surface decision took. That run then used all three negotiation rounds and escalated on a late F-08 — round 1 raised four blocking findings, round 2 cleared three and raised one fresh, which earned a third round under the final-contract-response rule, and round 3 cleared it and raised F-08 with no rounds left. The round budget ended it, not a disagreement.** F-08 is a real defect in the design as declared (the guardian-rejection exit awaited the step with no deadline, and a rejection landing before the command spawns hits a no-op `terminate` and then blocks on an unbounded run whose process is registered after the only quiesce — ADR 0020/0035's exact prohibition), so the remedy is recorded on #303 and the slice was relaunched the same morning. Negotiation records for both runs are committed under the spec dir's `escalations/`. Source: `.kiro/specs/mutation-survivor-report/intent.md`. |
| 12 (parent to ticket) | Test-suite timing reduction | none; measurement-led | Wave A complete; later slices to ticket only from evidence | Wave A is on `main`: split the heaviest QA suite, run the fast suite with six workers, and make git-process counting opt-in. The quiet-host full suite fell to 1022.1 seconds from the roughly 1612-second planning baseline. Next work absorbs #239 (host-load sampling), #250 (timing-document closeout), and #322 (one guarded sequential git-process baseline command), then starts with process-listing seams and fixture hygiene; structural consolidation is ticketed only when a fresh profile names it. Budgets are not raised to make this PRD green. |

PRDs 10 and 11 are independent of each other and of PRDs 5–7's follow-up
work; they may launch as serial self-runs in either order (§3c policy 5's
one-clone-per-run condition is moot for self-runs, which stay strictly
serial). PRD 5's merged cleaner-only milestone no longer blocks them.
Provenance for
both: the 2026-09-13 SwarmForge analysis — the port keeps the mechanisms
(protocol-enforced self-audit, mutation as the gate that verifies the
tests) and drops the choreography, consistent with Martin's own 2026
retraction of heavy harness constraints.

PRD 9 is the run-recovery work exposed by PRD 5 and should precede another
re-slice or stale-contract recovery. PRD 12 is different: Wave A is already
delivered manually, and its remaining work stays manual because an AFK run
would confound the host-sensitive timings it is trying to improve.

### 2c. Operator work attached to PRDs 10–11 — never AFK slices, never prompts

These actions are load-bearing for the two PRDs' value but are deliberately
outside every contract. The principle, recorded in both intents: **the
instrument must not be built by the process it measures.** Mutation results
judge the pipeline's tests, so the pipeline must never generate the tests
that satisfy them; "mutant killed" is a gameable acceptance criterion.

| # | Action | Mode | When | What it unblocks / decides |
|---|---|---|---|---|
| O1 | **Mutation tool adoption + cost measurement for this repo:** decide and declare the mutation command and JSON path (StrykerJS incremental is the working assumption), then time one differential run on a quiet host before trusting the ship-gate-concurrent placement. | Manual, direct session | Any time; required before `--mutation-report` is exercisable on self-runs | If measured cost blows the 30-min bound on a typical diff, the bound or the placement is revisited *with the measurement in hand* — never by raising a number under pressure (ADR 0063's lesson) |
| O2 | **Baseline campaign, module by module:** run mutation over the load-bearing pure modules (contract-convergence, guardian-convergence, failure-cause classification, gate-runner decisions, scope gate, lane partitioning, afk-manifest validation; the PRD 10 verdict classifier once it lands) and commit the incremental baseline artifact. Explicitly not full-repo: the integration-tested orchestration hubs are excluded as cost-prohibitive and low-signal. | Manual, parallel direct sessions (kill/survive results are load-insensitive; only durations are not) | After O1; before PRD 11's attribution labels carry weight | New-vs-pre-existing survivor attribution in every subsequent report |
| O3 | **Stage A triage sessions:** one batch session per baselined module — an agent pre-triages survivors by consequence (what observable lie would the pipeline tell?) × containment (would any downstream gate catch it?); the human ratifies top-down; every decision (KILL / ACCEPT + one-line reasoning) is recorded in the committed decisions file, schema per PRD 11's ADR. | Manual, human + agent | After O2, per module | The accepted-survivor marking in reports, and the decision corpus that Stage B autonomy is later measured against |
| O4 | **Critical-survivor remediation:** KILL decisions from O3 become ordinary human-reviewed tickets worked in direct sessions. Never unattended AFK — the writer of a killing test must never be its accepter. | Manual | As O3 produces them; Pareto order | Closes the proven blind spots worth closing; ACCEPT is the default when confidence is low |
| O5 | **Stage B/C formalization:** only after the O3 corpus holds ~20–30 decisions, turn it into eval-pack cases (PRD 7 harness, `prompt-plus-expected-verdict`) and measure triage-agent agreement per category. No machinery before that threshold. | Manual, then PRD 7 tooling | Earliest after several O3 sessions | The per-category autonomy graduation in §6 |

The two decision points these feed — `--self-audit` default-on and
`--mutation-report` escalate-or-delete — are standing triggers in §6, not
scheduled work.

### 2d. Pending improvements from the PRD 5/7 self-runs

This is the run-derived queue discussed on 2026-09-12/13, not a replacement
for the full issue backlog. It records ownership so each symptom does not
become a new PRD.

| Issues | Disposition | Sequence |
|---|---|---|
| #275 host-wide AFK lease | Small pipeline-safety change; implement directly, not through AFK. Until it lands, keep one live AFK run per host. | **Implemented and pushed, not PR'd** (2026-09-14): `fix/275-host-run-lease`, three commits including ADR 0069, worktree `C:\Code\afk-275`; the issue is still OPEN and `ready-for-agent`. It gates #317 and #321 per §2e and it already rewrites `src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` and `src/cli-entries.test.ts` — the exact files #317 must extend — so #317 started against `main` conflicts with finished work. Awaiting a maintainer decision to open the PR or to release the dependency. |
| #276–#278 preserve-work renegotiation | PRD 9. This owns both locked-contract reopening with commits preserved and additive split-scope recovery. | Next recovery PRD after completed PRD 5. Do not add one-off operator edits instead. |
| #272 crash misclassification | Direct correctness fix. Preserve the native crash identity instead of reporting a candidate CONFIGURATION failure. | High priority and now unblocked. **In flight 2026-09-14** on `fix/272-238-preship-crash-and-skip` with #238: both live in `src/preship.ts` and render through `src/logger.ts`, so they collide and belong on one branch, and one full-suite pass buys two issues. |
| #239 host-load sampling and #250 timing-document closeout | Fold into PRD 12's reporting/measurement wave; neither justifies a separate PRD. | After Wave A's merged baseline, on a quiet host. |
| #238 absent pre-ship step | Small direct reporting fix: record the configured step as skipped instead of dropping it. | Now unblocked; no separate PRD. **In flight 2026-09-14** on the shared `fix/272-238-preship-crash-and-skip` branch. One ticket correction on the way in: #238's "reuse the `tests:skipped` shape from #86" rests on a misreading — `SKIP_GATE_ID = "tests:skipped"` is a gate that *fails* when a candidate disables tests, not a representation of a check that declined to run. The existing vocabulary for "cost nothing, and why" is `GateStatus "SKIPPED"` plus `gateStatusCell`'s `prerequisiteSkipped` annotation. |
| #284 and #286 PRD 7 notes | Direct follow-ups: remove or specify the unread contract view, and reduce eval-pack/provider-decorator coupling. | Now unblocked; they do not reopen the completed PRD 7 run. **Both in flight 2026-09-14** on `fix/284-drop-contract-view` and `fix/286-eval-home-and-decorator-guard` — they are the two items in this queue that are mutually disjoint and disjoint from everything else, so they parallelise cleanly. #284 is confirmed dead code (`GeneratorEnvelopeInput.contractView` is written twice and read nowhere) and its removal must amend ADR 0068, which currently says the field stays. |
| #290–#296 PRD 5 guardian notes | Reconcile against merged PR #297: close tickets whose fixes landed and keep any residual work as non-blocking follow-up. #289, the blocking restore-outcome defect, is already closed. | They no longer belong to an active feature branch and do not reopen the completed cleaner-only milestone. |
| #313–#316 PRD 5 ship-gate notes | Non-blocking follow-ups recorded by the final architecture and PM reviews. | Triage independently after merge; they do not reopen PRD 5 or pull deferred #92 into the completed scope. |

Not scheduled from the same field notes: raising the negotiation round cap,
adding a provider watchdog from one stalled stream, automating host-branch
merge-forward, or filtering self-run fixture text out of the launcher log.
The observations stay evidence; another incident or a measured recurring
cost must justify permanent machinery.

### 2e. Post-PRD 5 operational retrospective additions (2026-09-14)

These are the critical/high-importance additions accepted after PR #297
merged. Each issue preserves the observed operator pain separately from the
suspected cause and proposed solution; the table keeps that evidence visible
in the roadmap so implementation does not optimize for a theory while missing
the failure the operator actually experienced.

| Issue | Observed pain to remove | Disposition | Sequence |
|---|---|---|---|
| #317 `afk finalize` | Post-merge closeout required hand-proving merge reachability, ordering worktree/branch deletion, recovering from Windows `Directory not empty` plus stale worktree metadata, and separately inventorying helper branches that did not match the PRD slug. | Critical direct pipeline-safety command. Consume terminal handoff evidence, default to dry-run, reuse the core Windows-aware worktree remover, and delete only explicit proven candidates. Distinct from `clean-failed` (#19/#168). | After #275; pair with #318 so successful finalization writes the durable completion fact. |
| #318 durable PRD completion scope | “Is PRD 5 complete?” required reconstructing selected PASS slices, deferred #92, PR #297, issue states, and roadmap prose. A stale sentence could incorrectly reopen the milestone or erase deferred work. | High-priority correctness/observability work. Persist merge-confirmed selected-versus-deferred completion and expose it through status/JSON; roadmap prose cites that record. | Design with #317 and land alongside it or immediately after. |
| #319 stable ticket/contract anchors | The QA suite split made four prepared tickets stale without changing behavior; one used moved line numbers. A stale locked #87 contract would have required stopping rather than routine repair. | High-priority extension to ADR 0049 lint/preflight: require semantic test/symbol anchors, verify them before lock/resume, and refuse rather than auto-edit a stale lock. | Before the next relaunch of a long-lived prepared PRD. |
| #320 guardian issue reconciliation | Final review marked earlier architecture findings resolved while #290–#296 remained open, forcing manual artifact-to-issue comparison and overstating remaining defects. | High-priority guardian lifecycle work. Reconcile linked findings across rounds; close only identity-safe, explicitly resolved findings and surface unresolved ones in handoff. | Independent direct work after the PRD 5 ticket reconciliation; does not reopen PRD 5. **In flight 2026-09-14** on `fix/320-guardian-finding-reconciliation`, and now carrying a second case it must cover: PRD 8's #326 (architect `A-02`, class `DESIGN`) and #330 (PM `P-01`, class `PRODUCT`) were filed as two issues for one defect, both from review round 1. That is *not* round re-filing, and no identity match can catch it — `alreadyFiledRecord` requires `record.guardian === draft.guardian` in both branches, and the fingerprint differs on both of its terms. Guardian notes are also filed unlabeled by construction (`FindingIssueDraft` has no labels field), which is the same-module fold-in that would put them in the triage queue. |
| #321 `afk explain --latest` | Several quality-loop attempts, cross-repo AFK contention, and a git-process failure had to be reconstructed from multiple large launch logs whose copied prompts/source made text search noisy. | High-priority structured diagnostic view across attempts. Report first cause, consequences, process ownership, liveness, and safe next action without transcript scraping. | After #275 provides authoritative host process ownership. |
| #322 guarded git-process baseline recorder | Wave A measurement required four quiet-host suites run manually and sequentially, report-by-report copying, and a surgical edit that must not capture traced seconds or change any budget. Starting AFK first would invalidate the host-sensitive evidence for hours. | PRD 12 manual measurement tooling. One resumable command validates fresh reports and updates only `gitProcesses` in the named measured block. | With #239/#250 in PRD 12's next quiet-host measurement wave. |
| #323 slim always-loaded steering | `AGENTS.md` plus `CLAUDE.md` load roughly 18 KB on every turn; live launch rules compete with duplicated historical incidents and can drift between files. | High-priority manual context-efficiency work. Retain commands and hard guardrails; move—not delete—history/rationale behind tested trigger-based links. | After the immediate lifecycle commands settle, so the compact files point at final behavior. |

### 2f. What the 2026-09-14 self-run night established

Three PRDs escalated for a maintainer decision on the same day, and the
post-mortems turned up two pipeline defects that caused most of the cost. This
subsection records the systemic findings, because each of them makes an
escalation cheaper next time and none of them is derivable from the tickets.

**The re-cut is the remedy, and the reason is a bug.** PRD 9's slice #277
escalated for size, was re-cut into #277 plus #332–#335, and then #335 escalated
for size again with F-02, F-03 and F-06 open. In both cases the planner narrowed
`contract.md` and left `acceptance-manifest.json` declaring the surplus, so each
deferred behavior was demanded by one half of the pair and forbidden by the
other. The round-2 feedback names it exactly: *"So the pair is not narrowed; it
is inconsistent."* That is not planner carelessness —
`restoreAcceptanceManifestRevisionScope` rebuilds `behaviors` by mapping over the
previous revision's array, so a behavior the planner deletes is always
resurrected, and a finding whose clear condition is "remove these behaviors from
the manifest" is **unsatisfiable in any revision round**. A rerun works only
because round 1 is unconstrained. Filed as a bug; until it lands, the operator
remedy is to re-cut the ticket so the planner's round-1 pair is already small,
and the ticket — not one round's contract prose — is where the cut has to live.

**A decision recorded as an issue comment reaches nothing.** The pipeline never
reads a GitHub issue. Issue content arrives through one local file read
(`<prd-dir>/issues/<NN>-*.md`), and when that file is absent — it is absent for
every PRD in this repo — the pipeline substitutes the literal instruction
`gh issue view <n>`, with no `--comments`. So the issue **body** is the only
channel, while this repo's own triage workflow records maintainer decisions as
comments and reads them with `--comments`. All three of 2026-09-14's decisions
were therefore written into issue bodies, with the comment kept as the
timestamped provenance trail a body edit does not leave, and PRD 11's decision
additionally committed into its `prd.md`, which the planner reads by path from
its worktree. Filed as a bug, with the undocumented local-manifest convention.

**A host suspension is counted as agent runtime.** The host entered Modern
Standby 38 seconds after an evaluator was dispatched and stayed suspended for
6h51m; the agent's wall-clock ceiling is a bare `setTimeout`, so it fired on
resume and killed a healthy evaluator 3.8 seconds later, having counted 25,226
seconds of suspension against a 3,600-second budget — roughly 42 seconds of
actual agent runtime, 1.2% of the ceiling. `runSliceExecute` then special-cases
the ceiling message as terminal by design, so the slice ended `ERROR` with no
infrastructure retry, and the next launch restarted from base and deleted the
ACCEPTed, LOCKED contract pair it had just restored — archiving `contract.md` but
not `acceptance-manifest.json`, which `sliceArtifactNames` omits, so the
manifest's only copy was destroyed. Cost: about $17.60 and nine hours of run
wall-clock for zero code, plus a false ESCALATE on a slice whose contract had
already been agreed. Three issues filed: the sleep-blind ceiling (same class as
#220, different surface), AFK holding the wake lock itself, and the discarded
pair (adjacent to #147). The operator mitigation in the meantime is a reversible
wake lock held for the duration of every run; do not reach for
`powercfg /change`, which changes the machine rather than the run.

**#340 is the single most expensive defect this night found, and it fired three
times.** Beyond PRD 9's two cuts, it ended PRD 10 slice #300: round 2 added
`[behavior:B-09]`, `[behavior:B-10]` and `[behavior:P-06]` to `contract.md` and
bound exactly what the evaluator asked for — its own words, *"the revision's
substantive half is now in place"* — and every one of the three was discarded,
because `restoreAcceptanceManifestRevisionScope` admits a **new** behavior only
when its id is already in `allowedBehaviorIds`, which is derived from the routed
findings, and a finding cannot name an id that does not exist yet. So the defect
has two faces, not one: a removal never survives a revision round, and an addition
survives only for an id already under discussion. The manifest's `fileScope`, by
contrast, is not guarded at all — it passes straight through the spread — which is
the asymmetry that produced #335's inconsistent pair. The evaluators have started
routing around it: every clear condition PRD 10's wave 2 wrote offers
"a behavior **or an explicit non-goal with its reasoning**", which is a machine
learning to ask only for what the machinery permits.

**Two other classification defects surfaced, both on the "a non-zero exit is not a
verdict" theme.** PRD 10 slice #301's generator died on a transient provider API
error — `terminal_reason: "api_error"`, the provider's own text reading "Try your
request again" — and AFK reported `Agent generator exited with code 1`, ended the
slice, and thereby suppressed the pre-ship gate and the draft PR for the whole PRD
(#358). The retry that should have fired is not the infrastructure retry but ADR
0022's `withTransientRetry`, which already wraps every dispatch and never triggers
because `src/claude.ts` supplies no `classifyExit` at all, while `src/kiro.ts`
implements exactly that. Separately, the bounds banner advertises those
infrastructure retries "per invocation" while in the execute phase the count
governs gate attempts only (#359), which is how a babysitting session came to
expect a retry that could not happen.

**One live AFK run per host still serializes the reruns**, so three prepared
PRDs cost a night rather than an evening. That is the cost #275 removes, and #275
is finished and unmerged — see the §2d row.

**The round cap is now worth revisiting on evidence, which §2d declined to
schedule on argument.** PRD 11's second run is the case: three rounds, each one
clearing real findings and surfacing a deeper one, ending with a fresh blocking
finding and no rounds left. Nothing about it looks like non-convergence — the
final finding was a genuine defect in the declared design, and the ticket answered
it in minutes. Whether that argues for a higher cap, for a fresh-finding
allowance broader than the existing final-contract-response rule, or for nothing at
all is a decision for the next measurement; the observation is recorded here so it
is not re-derived.

---

## 3. The agreed hardening set (debate consensus, priority order)

Replaces the previous §3.1–§3.10 wholesale. Ratings are L/C/E/R
(Leverage / Cost, higher = costlier / Evidence / Reversibility, each 1–5) —
justifications and the losing arguments are in `afk-v2-plan-debate.md`.
Nothing on this list adds minutes to the happy path.

| # | Item (former §) | Placement | L/C/E/R | Recurring cost | Failure mode |
|---|---|---|---|---|---|
| 1 | **Classifier fix, narrow form** (§3.5 + #120, one ADR): non-zero exit from a lifecycle script during gate `prepare` is candidate-owned, keyed on exit code, replacing the one-marker whitelist at `gate-runner.ts:202`. The full inversion was rejected — it converts transient network faults into burned rounds. | wave, ships first | 5/1/5/5 | zero | an env fault inside a lifecycle script burns one recoverable round — vs today's deterministic slice death |
| 2 | **Derived generator verification command** (§3.2): generator loop derived from the gate catalog (required cheap-on-changed-tree gates in gate order, `test:full` excluded); a flag may narrow, never omit; numeric cheapness threshold. Corrects `AGENTS.md`, which still prescribes the typecheck-less command. | PRD 4 | 4/2/5/4 | seconds/iteration | a gate misdeclared "cheap" taxes every iteration — hence the numeric threshold |
| 3 | **`afk stop` sentinel** (new; both debaters independently): orchestrator polls a run-namespaced sentinel file, routes through the existing `AbortSignal` path so ADR 0040 records fire. *Shipped variant (ADR 0043): the preflight sweep of stale sentinels was dropped as unnecessary — run-dir names are never reused, each run clears its own directory at launch, and the poller ignores a sentinel naming another run, so a stale sentinel is structurally inert.* | wave | 5/1/5/5 | one `existsSync`/tick | sentinel unseen if the tick loop is wedged — fallback is today's status quo |
| 4 | **Crash records** (§3.6): `uncaughtException`/`unhandledRejection`/fatal stream errors → cancellation bookkeeping, cause `CRASHED`, best-effort (ENOSPC may defeat it; no reserved-space machinery), item 11's clear-on-dispatch as backstop. | wave | 5/1/5/5 | zero | the handler may be unable to write under the very condition it records — accepted |
| 5 | **Change-summary-first candidate-evaluator envelope** (new): PRD 4's final-evaluator change-summary artifact gets a second consumer — one manifest entry leads the candidate evaluator's envelope with the slice diff summary + manifest; worktree stays available. Attacks the largest measured recurring cost. **Rider:** if item 13's metric shows no material drop in evaluator nonCommandTime within two PRD runs, the leverage claim was wrong and the ordering is revisited. | PRD 4 artifact, PRD 3 manifest entry | 5/2/4/5 | ms/round | diff-anchoring under-reads preservation — bounded by the full-suite gate and the explorer's preservation catalog |
| 6 | **Ticket lint** (§3.1, narrowed): checks 2 (criterion names a state/field/artifact absent from the referenced schemas) and 3 (recording obligation without a named channel) gate with recorded waive-with-reason; check 4 (summarised field lists) warns via lexicon lint; check 1 (compound predicates) is an authoring-checklist item, not a lint — free-prose detection is NL parsing and the structural rescue (a mandatory ticket field) was cut as a forever-tax. **Must run against every prepared PRD ticket before it enters AFK.** | pre-AFK tool | 4/2/5/5 | zero per slice | waive-with-reason decays into a rubber stamp — the waiver is recorded text |
| 7 | **Preflight — detection + report + fail-fast only** (§3.7, narrowed): disk floor, leftover registered worktrees, live handles/processes holding run-namespace paths (named PID list for the operator), empty-shell sweep. Auto-kill in *both* debated forms is cut (see debate §2); so is the launch-time state↔branch audit. | wave | 4/2/5/5 | seconds/launch | a false "leftover" report delays a launch — operator-visible and overridable |
| 8 | **Role-cost governance** (new rider): cleaner + hardener default off until #73 story 17 ROI evidence; any enable/disable recorded in run evidence and the draft PR; #72 story 13 makes the final evaluator free while they are off. | PRDs 5–6 policy | 4/1/3/5 | one config line/run | useful cleaner passes forgone until evidence exists — the point |
| 9 | **QA-dedup resequenced** (new): before #96 lands, the orchestrator injects base-gate evidence + exact tree sha into the QA prompt as a citable skip authorization (recovery plan Phase D step 14). Exact-sha match else re-run, fail closed; the verdict artifact records the citation; the ADR 0012 amendment lands *with* it. ~13 measured min back per QA round, starting with PRD 2's run. | wave | 4/2/5/3 | one sha compare/round | sha mismatch falls closed to today's behaviour — strictly no worse |
| 10 | **`afk adopt`, thin** (§3.8): verify the branch merges and gates pass, merge, write the state entry, record who/why; refusal names *which* check failed; the adoption record surfaces in the run summary and draft PR. Carries the write-time state↔branch verification (the launch-time audit died because advisory-forever scanning is unfalsifiable; the check lives where writing state is refusable and the operator is present). | PRD 2 | 4/2/4/4 | zero per slice | adopt becomes a bypass valve — the gate run + surfaced record is the guard; more ceremony was rejected |
| 11 | **Provenance, narrowed** (§3.3): slice-state records carry run ID (tree identity alone cannot discriminate #121's two-runs-stale error); readers report mismatches; stale error text cleared at dispatch. Gate-evidence provenance is already PRD 4 story 1 and is not re-proposed; the keyed measurement store is cut. | PRD 1 assembly (schema) + wave (clear-on-dispatch) | 4/2/5/3 | bytes/record | provenance written but never checked is decoration — the reader-side half must not be dropped in slicing |
| 12 | **Advisory environment gates, catalog-declared only** (§3.4, narrowed): a gate *declared* environment-sensitive in the policy-owned catalog is advisory in pipeline context — reports, never blocks, never consumes a round; still surfaces at PR review. The general "no actor can act ⇒ not blocking" corollary is cut as agent-certified classification. Ships with the loaded-in-chain budget ADR. | PRD 4 declarations; ADR now | 3/2/4/4 | zero | first *undeclared* env-sensitive gate deadlocks one round before someone declares it — bounded, once per gate |
| 13 | **Reading-time metric** (§3.10): per-invocation nonCommandTime as first-class evidence; a measurement, **never a gate**; harvest scripts already compute it. Scores PRD 3's envelope bet and item 5's rider; feeds #73 story 17. | PRD 3/4 evidence | 3/1/5/5 | one timer/invocation | conflates model/tool latency with reading — name it honestly, never gate on it |
| 14 | **Bounds visibility** (§3.9): remaining resume attempts, rounds, and infrastructure retries at dispatch in `run.log` and `afk status`; carrier for the stage-duration journal event (the watchdog ping's surviving residue — data, never an alarm). | wave | 2/1/3/5 | one log line/dispatch | none worth the name |

Riding items: the **reader-side budget check** (~10 lines in
`check-suite-budgets.mjs`: refuse cross-branch block comparison, warn on
tree divergence — 3/1/5/5, wave) and the **stage-duration journal event**
(2/1/3/5, rides items 13–14).

Cut, with the killing argument recorded in the debate doc: the watchdog
ping, auto-kill (both forms), the launch-time state audit, the mandatory
`rejection-cases` ticket field, the keyed measurement store, the general
finding rule, a durable process supervisor, and plan-interrogation prompt
text. Each carries a re-open trigger where §6 names one; do not re-propose
without it. Agent-eval pass rate is also explicitly non-blocking: it never
gates a merge.

### 3b. Parallelism additions (2026-08-28, outside the debate)

Two items from the PRD 2 lane-collapse discussion. They did not pass
through the debate; the ratings are the proposer's own, recorded in the
same L/C/E/R form for comparability. Both keep the debate's constraint:
nothing here adds minutes to the happy path.

| # | Item | Placement | L/C/E/R | Recurring cost | Failure mode |
|---|---|---|---|---|---|
| 15 | **Merge-resolution round on CONFLICT** (extends ADR 0029): a real git merge conflict at the mutex dispatches one scoped resolution round *before* recording `CONFLICT`. The slice's generator, in its worktree on the current feature-branch tip, receives the conflict hunks plus the already-merged sibling diffs, resolves, and re-runs the slice's QA gates and bindings on the resolved tree; the merge retries inside the same mutex. One round; failure falls back to today's terminal `CONFLICT` with both branches preserved. | PRD 4 slice **#132** | 4/2/3/4 | zero — runs only on CONFLICT | a plausible-but-wrong resolution — bounded by the slice's own gates re-run on the resolved tree and by the pre-ship full suite |
| 16 | **Optimistic lanes, opt-in** (`--optimistic-lanes`, default off): lane-mates run Phase B in parallel from the same base; merges still serialize under the mutex; after each merge the orchestrator re-executes the union of the wave's executable bindings (#76) on the merged tip. A textual conflict routes through item 15. A binding failure on the merged tip demotes the losing slice to today's serial path (re-negotiate on the real base) — worst case is serial behaviour plus one wasted generator run. Fails closed to serial when any wave slice's contract lacks bindings. Enable/disable recorded in run evidence, under item 8's governance pattern. | flag + ADR, after item 15 ships | 3/3/2/5 | zero when off; one binding re-run per merge when on | a semantic duplicate outside binding coverage survives to the pre-ship gate — the ADR 0005 incident class, and the reason for default-off and the §6 trigger |

Evidence base, thin and stated as such: the PRD 076 session discarded
passed-QA work at a merge refusal (ADR 0029's motivating incident); the
PRD 1 reliability wave resolved cross-prompt conflicts with an agent,
attended, and it worked. External: co-active agent PRs conflict textually
at 20–42% measured rates (arXiv:2607.04697) — which argues for default-off,
not for abandoning the idea; advisory self-repair beats discard-and-retry
on cost because agent work-in-progress is expensive to throw away
(CoAgent, arXiv:2606.15376). A survey of shipped agent products
(2026-08-28) found none that documents re-verifying the *merged* output of
parallel agents as a distinct gate — AFK already owns both mechanisms this
needs (the merge mutex and the pre-ship gate), which is the case for
attempting it here at all.

### 3c. Agreed policies from the parallelism discussion (2026-08-28)

Follow-up agreements, same provenance note as §3b: agreed in discussion,
not debate-rated.

1. **Escalation rule — critical judgment only.** An agent decides and
   records, without asking, when the call is inside the locked contract,
   or reversible before merge, or a gap-fill nothing else will build on.
   It escalates when any one of these holds: **spec contradiction** (the
   correct implementation needs a behavior the PRD states differently);
   **load-bearing silence** (the spec says nothing and the choice creates
   something others will build on — a public interface, a data format, a
   security posture); **declared risk class** (a short catalog-declared
   list — schema history, auth, deletion of tests or gates, destructive
   git — structural, not agent-judged, for the same reason item 12's
   corollary was cut). A recorded ADR counts as spec for this rule:
   a slice whose correct implementation contradicts one escalates as a
   spec contradiction rather than silently overriding it. Every
   non-escalated call is recorded in a named
   channel with the alternative and the reversal cost; escalations are
   couriered and never block the DAG — only dependents wait. Placement,
   split three ways: the *plumbing* is PRD 2's in-flight slices (#80
   scope escalation, #81 park-and-continue, #89 resume, #94 courier);
   the *criteria* (the three tests, as prompt text) land with PRD 3's
   prompts v2; the *risk-class catalog* rides PRD 4's item 12
   declarations.
2. **Hub and seam declarations — `afk.config.json`, repo root, new.**
   Project policy, deliberately not the per-PRD `afk.json`: hubs are a
   property of the repository, and two concurrent PRDs must see the same
   lane semantics. Format: `version: 1` required; `resourceKeys` maps a
   key name to a regex matched against the partitioner's normalized path
   form (forward slashes, lowercase, no leading `./`); a `migrations`
   key, when present, **replaces** the built-in default (ADR 0027's
   replace-not-extend rule); every value must compile as a regex;
   optional `architectureDoc` names the architecture file. Two wave
   slices whose declared paths match the same key union into one lane,
   reported via the existing `sharedResources` channel. Extends
   ADR 0027; the partitioner semantics are otherwise unchanged.
3. **`ARCHITECTURE.md` — four sections, each with a named reader.**
   Modules (name, one-line purpose, public seam, internals), Hubs
   (do not grow; extract instead), Seams (extension points), Placement
   rules. Readers: the explorer and planner receive it in their
   envelopes; ticket authors read Hubs when applying the seam-slice
   rule. Two honesty guards: every named path must exist (cheap lint),
   and every listed hub must have a matching `resourceKeys` entry —
   prose and enforcement cross-check each other. Hard cap ~150 lines:
   it rides in every planner envelope and PRD 3 makes envelope cost a
   first-class measurement.
4. **`test:budgets` is declared environment-sensitive under item 12.**
   Wall clock conflates suite cost with machine load; under concurrent
   runs the gate false-fails, and a false red teaches people to raise
   numbers. In pipeline context it reports, never blocks, never costs a
   round; the report surfaces at PR review, where a human distinguishes
   "machine was loaded" from "someone added an expensive test". The
   numbers remain first-class measurements (item 13's pattern). The
   budget stays blocking for plain developer runs of `pnpm test`.
5. **Concurrent AFK runs — four conditions, no suite lock.** Two PRDs
   may run at once when: one clone per run (two orchestrator processes
   hold in-process merge mutexes that cannot see each other; separate
   clones make cross-run git races impossible by construction);
   migration prefixes reserved per PRD at prep time (ADR 0034 claims);
   the second merger pays a rebase — check the two ticket sets'
   file-hint overlap before launch; tickets linted (item 6, unchanged).
   The cross-process suite lock was considered and deferred: with
   budgets advisory (policy 4), its only remaining job is protecting
   per-test timeouts from contention flakes — see the §6 trigger.
6. **Deterministic in-round checks belong in the gate catalog, not in
   provider hook config** — one implementation, three backends, the
   existing evidence trail. Provenance: the 2026-08-29 hooks review
   (`docs/research/2026-08-29-hooks-in-ai-pipelines.md` plus two
   adversarial reviews), which evaluated six in-session hook proposals
   and adopted none — no recorded incident (#111–#121) would have been
   prevented by any of them, and hook enforcement is unreliable under
   the trust flags AFK actually passes to its providers. The named
   first candidate under this policy, if a consuming project ever
   handles credentials: a gitleaks-style changed-tree secret-scan gate
   riding item 2's derivation. The review's one uncovered finding —
   provider processes inherit the operator's full environment under
   trust flags — is filed as #135. Its cheap environment-filtering half
   now ships before PRD 4 under item 21; OS sandboxing and network policy
   stay out of scope.
   Re-opening hooks themselves is governed by the §6 trigger.

---

### 3d. Approved additions from the SDLC playbook review (2026-09-02)

These additions extend the debate set without renumbering items 1–16.
The approved intent files under `docs/intent/` hold the source decisions.
Same provenance note as §3b: approved in the 2026-09-02 founder review,
not debate-rated; the L/C/E/R ratings are the proposer's own, recorded
for comparability.

| # | Item | Placement | L/C/E/R | Recurring cost | Failure mode |
|---|---|---|---|---|---|
| 17 | **Feedback integrity gate:** detect deleted tests and protected-path changes in #84; use project-declared test-skip detection in #86. A structured waive-with-reason record is required. File scope alone never implies a waiver. AFK may ship a TypeScript/Vitest detector, not a universal language regex. | PRD 4, extends #84 and #86 | 5/2/4/4 | one changed-tree check | a project lacks a skip detector, so the gate fails closed until policy declares one or records a waiver |
| 18 | **Agent-behavior eval harness:** separate `afk eval` runner; versioned scenario-pack schema; one case kind, `prompt-plus-expected-verdict`, with a required `source` naming the issue, run or artifact the case came from; AFK owns the runner and consumers own packs. The AFK-owned pack is seeded from #192, #194, run 5's steering defect and PRD 4's archived evaluator verdicts; the count is what those sources yield, and the pack grows from incidents. Run weekly and manually on relevant changes; weekly runs are operator-invoked — CI scheduling waits for item 21's filtered-environment pattern. Compare exact structured verdicts in v1, enforce a model-call cap, and report `INCOMPLETE` when the cap stops a run. Results are measurements and never gate merges. The runner does **not** define the learning-proposal schema — that is a hand-landed module (§2 PRD 6 row). | new PRD 7, after PRD 4 | 4/4/4/4 | scheduled model calls | noisy or incomplete results mislead maintainers — exact outputs and non-gating reports bound the risk |
| 19 | **Recurring-finding proposal loop:** on the second exact stable finding class, write `learning-proposals.json`, then render it in the run summary and draft PR. Each proposal carries class, count, target asset, and proposed diff. The proposal shape is shared with rumo-app's Close learning pass (rumo-app #809); changing its fields requires cross-repo coordination. Commit proposals; never edit steering files automatically. Classifier similarity is out of scope for v1. | PRD 6, after the learning-proposal module lands on `main` | 3/2/3/4 | one history scan/run | exact classes miss semantically similar repeats — accepted for deterministic v1 |
| 20 | **Structured guardian review policy:** named review passes, a concrete Important definition, evidence-bound blockers, at most three non-blocking notes, and a do-not-report list. Add this to the deferred guardian-convergence follow-up after PRD 3's measured guardian run, not to live PRD 3. | guardian-convergence follow-up | 4/1/4/5 | prompt text only | an over-tight list hides a useful note — the three-note allowance preserves bounded judgment |
| 21 | **Provider environment minimization:** #135 inventories inherited keys, then passes a provider-specific filtered environment. Record allowed key names, never values. This cheap half excludes OS sandboxing, network allowlists, and role-specific environment policy. | manual security work after PRD 3, before PRD 4 | 4/2/3/4 | one environment projection/invocation | a needed key is omitted — provider-specific tests and a named allowlist make the failure visible |

PRD 3 also ships one approved delivery-order change from
`prd3-test-gate-sequencing.intent.md`: run cheap or related checks, then
candidate QA, then the full slice suite. A full-suite failure returns to the
bounded repair loop. The aggregate full suite remains. Candidate-tree
authorization uses the orchestrator's tree ID, not `HEAD`. The 8 GB launch
floor applies only to the remaining PRD 3 launches; the global 5 GB default
does not change.

---

## 4. Sequencing — pay the next runs first, in parallel tracks

Ordering principle: **an item's priority is how soon the *next* AFK run
collects its benefit.** Everything in Track 2 pays from the very next run
onward; PRD-embedded items pay from their PRD's run onward. Parallelism is
real for manual sessions (separate worktrees, the proven #113/#114
pattern). AFK runs may also run concurrently under §3c policy 5's four
conditions — this revises the earlier one-suite-at-a-time rule, which
existed for the `test:budgets` gate that §3c policy 4 makes advisory in
pipeline context.

```
NOW, three tracks in parallel (Track 1 — PRD 1 / PR #125 — DONE, merged 2026-08-28):
├─ Track 1 DONE               PR #125 merged (ab0e25a); #69 closed
│                             (run-ID fields, item 11's schema half, now ride the wave)
├─ Track 2 (manual wave, parallel worktrees — every item pays from the next run)
│    item 1  classifier fix + ADR        item 9  QA-dedup + ADR 0012 amendment
│    item 3  afk stop sentinel           item 4  crash records
│    item 7  preflight (detection-only)  item 11 clear-on-dispatch + run-ID fields
│    item 14 bounds + journal event      reader-side budget check
│    #112 contract-amendment gap (as filed)
│    All sessions base on main — PRD 1 is merged, so the s5/s7 base-branch
│    checks in their prompts now resolve to main.
│
├─ Track 3 (manual)           item 6 ticket lint tool → lint each prepared PRD ticket, fix what it flags
└─ Track 4 (manual, docs)     loaded-in-chain budget ADR (item 12's half) · AGENTS.md
                              launch-command correction — DONE (interim command until item 2)

GATE: PRD 1 closed + wave merged + tickets linted
  → AFK: PRD 2 (item 10 afk adopt; story 14 deferred)
  → AFK: PRD 3 (item 5 manifest entry, item 13; story 16 deferred, assembly fence kept)
       PRDs 2 and 3 are contract-independent but serialize in practice
       (ticket inputs + maximal file overlap — see §2): prep PRD 3 during
       PRD 2's run, then launch it when PRD 2 merges.
       During PRD 3, ship the approved early #86 test sequence without
       adding the rest of PRD 4's scope. Remaining PRD 3 launches use
       the 8 GB disk floor (§3d); the global 5 GB default is unchanged.
  → MANUAL: guardian-convergence policy (item 20, after measured guardian evidence)
            + #135 provider environment filtering (item 21)
  → AFK: PRD 4 (item 2, item 5 artifact, item 12 attribute, provenance story 1;
                item 15 merge-resolution round (#132), item 17 tamper guard;
                stories 9 and 15 deferred)
  → AFK: PRD 5 (cleaner only, default-off, story 17 ROI experiment)
       COMPLETE via PR #297; #92 hardener remains deferred
       ∥ PRD 7 (item 18 report-only eval harness)
  → AFK: PRD 6 (guardians, remediator, item 19 proposal loop)
       PRD 6 no longer waits on PRD 7; item 19 starts once the hand-landed
       learning-proposal module is on main.
```

Post-plan work (§2b–§2e) continues in this order:

1. **Complete (2026-09-14):** PRD 5's selected cleaner-only scope merged
   through PR #297. #92 remains an open, deferred hardener follow-up under
   parent #73; it is not unfinished work in the completed milestone.
2. Land #275 before intentionally running concurrent AFK processes on one
   host; until then, one live run per host.
3. Land #319 before relaunching another long-lived prepared PRD; it prevents a
   harmless test move from becoming another late ticket repair or locked-
   contract stop.
4. Run PRD 9's preserve-work recovery before another stale-contract or
   additive re-slice incident needs a hand-built recovery.
5. Build #317 and #318 as one closeout/status track, then #320 as the
   finding-lifecycle follow-up. None reopens PRD 5.
6. PRD 8 is unblocked because #270 is merged. PRDs 10 and 11 then launch
   as serial self-runs in either order. PRD 10's flag is exercisable the
   day it merges; PRD 11's flag is exercisable on this repo only after
   operator item O1, and its attribution labels earn weight only after O2.
7. PRD 12 Wave A is complete. Use #322 to profile the merged baseline before
   selecting Wave B; work #239 and #250 inside that measurement track, not
   as new standalone projects. Keep #238 as a direct reporting fix.
8. Land #321 after #275, then slim the always-loaded steering under #323
   after the lifecycle commands and their exact operator guidance settle.

What each stage banks for the runs after it:

- **The wave** removes the three run-killer classes (misclassification,
  unrecorded exits, resource surprises) and saves ~13 min per QA round —
  before PRD 2's run ever starts.
- **The lint** protects the scarce round cap: #77 and #78 each lost rounds
  to lintable defects in tickets that looked fine to a human.
- **PRD 4** lands the two big recurring-cost attacks (items 2 and 5,
  ~35–43 min/round combined with item 9), the advisory-gate attribute,
  and the feedback-integrity gate.
- **PRD 5's run** was itself the cleaner experiment: story 17 produced the
  initial ROI evidence. Cleaner/hardener remain default-off unless that
  evidence supports a separate policy decision; it did not silently select
  or complete hardener #92.
- **PRD 7** makes prompt and role changes replayable without turning a
  noisy eval result into a merge gate.

### Per-wave discipline, learned the hard way (unchanged, one update)

- Budget a prep-chain refresh as its own task, not a step; expect conflicts
  whenever main restructures a file a slice branch touches.
- One full test suite at a time per *manual* session remains the norm;
  concurrent AFK runs may overlap suites once `test:budgets` is advisory
  in pipeline context (§3c policies 4–5).
- Every launch passes the verification command explicitly **including
  typecheck** until item 2 lands — and Track 4 corrects the stale
  `AGENTS.md` guidance now, since a document that misleads the next
  operator is exactly the defect class this plan exists to kill.
- A stopped run is recoverable; verify the CANCELLED records landed and
  record the commit the slice branch is left at.
- Review findings below blocker level are filed as issues and scheduled
  against §3's priorities. They are not worked in the next free session —
  a MINOR archive gap does not outrank a run-killer fix, however fresh the
  review is.

### Early PRD 4 delivery during PRD 3 (2026-09-02)

Before PRD 3 slices #90, #95, and #99, the slice test sequence shipped the
minimum useful part of M6 early: cheap typecheck/lint checks run before
candidate QA; the full slice suite runs only after candidate QA accepts; a
full-suite failure returns to the next bounded repair round; changed candidates
repeat the cheap checks and QA; exact-tree QA authorization identifies a Git
tree object rather than a `HEAD` commit. The aggregate pre-ship full suite is
unchanged.

PRD 4 still owns the complete policy-owned gate catalog, automatic
`test:related` selection, the derived generator verification command,
mechanical behavior-ID coverage, exact-tree result reuse/cache policy,
structured prerequisites and advisory attributes, and project-level policy.

---

## 5. What runs through AFK, and what stays in normal agent sessions

The rule of thumb the debate converged on:

> **If the pipeline must survive the change failing, or the change is
> smaller than one round's overhead, do it by hand. If it is
> contract-sized feature work whose evidence trail matters — and whose run
> doubles as the next dogfood experiment — run it through AFK.**

| Work | Mode | Why |
|---|---|---|
| Reliability wave (items 1, 3, 4, 7, 9, 11-wave-half, 14, reader-side check, #112) | **Manual**, parallel worktrees | Pipeline-safety fixes are precisely the changes not to depend on the pipeline to deliver — a wave item failing inside AFK could take down the run that was delivering it. Each item is also smaller than one round's overhead (base gates alone are 12.4–14.8 min/round); a run per 10-line fix is negative ROI. Wave 1 (#113/#114) already proved the parallel-manual pattern. |
| Ticket lint tool + linting prepared PRD tickets (item 6) | **Manual** | It must run *before* AFK ingests each ticket; it is a small deterministic tool with no contract worth negotiating. |
| ADRs (classifier, loaded-in-chain budget, ADR 0012 amendment), the `AGENTS.md` correction, and the learning-proposal schema module (§2 PRD 6 row) | **Manual** | Documents and one validator smaller than a round's overhead. Zero benefit from the pipeline. |
| Hand-finishing stuck slices (until item 10 exists) | **Manual, documented procedure** | Verify with the full suite, merge, then edit state — and prefer waiting for `afk adopt` over fresh JSON surgery on `isSliceComplete` (`run-state.ts:416`). |
| PRDs 2–7 | **AFK** | Multi-slice, contract-sized feature work where negotiation, lock validation, and gate evidence earn their cost. |
| PRDs 8–11 (§2b) | **AFK** | Same rule. PRD 9 exercises the recovery path it adds; PRDs 10–11 are additionally the dogfood experiments for their own report-only instruments, so their delivery runs produce the first evidence their §6 triggers consume. |
| PRD 12 test-suite timing reduction (#239, #250, #322) | **Manual**, measured waves | The suite and host are the instrument. Running the optimization through AFK would add the load being measured and make failures depend on the pipeline under repair. Wave A is complete; later waves start only from a quiet-host profile, with #322 guarding the sequential traced-process campaign. |
| Run-derived direct fixes (#272, #275, #284, #286, #317–#321) | **Manual**, isolated worktrees | Each is focused pipeline safety, lifecycle correctness, lint, or observability work. They should not depend on AFK to repair or diagnose AFK; PRD 5's former active-branch exclusion ended when PR #297 merged. |
| Always-loaded steering reduction (#323) | **Manual** | This is a behavior-preserving documentation refactor whose success is measured by retained operational discoverability and lower context load, not by contract negotiation. |
| Mutation operator work O1–O4 (§2c): tool adoption + cost measurement, baseline campaign, Stage A triage sessions, survivor remediation | **Manual** | The instrument must not be built by the process it measures. Mutation results judge the pipeline's tests, so the pipeline must not generate the tests that satisfy them; "mutant killed" is a gameable criterion, so remediation is never unattended; and the cost measurement is host-sensitive work in ADR 0063's class. |
| PRD-embedded hardening (items 2, 5, 10, 12, 13, provenance story 1) | **AFK**, as slices of their PRDs | Each is genuine feature work inside a PRD's contract, not pipeline first-aid; splitting them out would re-create the double-counting the debate removed. |
| Guardian policy (item 20) and provider environment filtering (item 21) | **Manual, between PRDs 3 and 4** | Both changes are small. The guardian change must use PRD 3's measured evidence, and the environment change is security work that should not depend on the pipeline it constrains. Item 21 is sequenced after PRD 3 only to avoid concurrent edits to the provider dispatch files (`src/claude.ts`, `src/codex.ts`, `src/kiro.ts`) while PRD 3's run is live; nothing in it consumes PRD 3's output. |

Boundary case, decided: `afk adopt` (item 10) stays an AFK-built PRD 2
slice, but if #79 or the PRD 2 run itself needs a fifth adoption before it
exists, the documented manual procedure applies — do not pull it forward
into the wave just in case.

---

## 6. Open points

The previous open points are resolved by the debate: the ticket lint is its
own pre-AFK tool (not a PRD 3 slice); the "not the candidate's fault"
class lives in PRD 4's gate declarations only (the finding-schema variant
was cut); `afk adopt` rides PRD 2 with the boundary rule above; PRD 5's
mutation scope is deferred outright rather than left untested.

What remains is not open questions but **standing triggers**:

- **Auto-kill** re-opens only on a second leaked-holder incident in which
  the survivor record was actually present.
- **A stage watchdog** re-opens only when the journal events show a bimodal
  doomed-vs-large duration distribution.
- **Item 5's L5 rating** is falsifiable by construction: no material drop
  in evaluator nonCommandTime within two PRD runs of shipping ⇒ revisit
  the envelope ordering.
- **Cleaner/hardener defaults** are decided by #73 story 17's evidence, not
  by argument. PRD 5 produced the cleaner evidence; hardener #92 stays
  default-off and deferred until a later decision explicitly selects it.
- **Deferred stories** (#70 s14, #71 s16, #72 s9, #72 s15, #73 s9–15+19)
  re-enter only when an incident or the ROI evidence demands them; the
  PRD 3 assembly fence (provider-agnostic envelope interface) holds
  regardless.
- **Optimistic lanes (item 16)** stay opt-in until at least two opted-in
  waves show zero merge regressions that only the pre-ship gate caught,
  plus a wall-clock win worth the extra compute. Default-on is decided by
  that run evidence, not by argument.
- **The cross-process suite lock** (cut from §3c policy 5) builds only
  after a per-test timeout flake attributable to cross-run contention.
- **Per-tool-call gating (in-session hooks)** — all six proposals from
  the 2026-08-29 hooks review were cut — re-opens only when *all* of
  these hold: (a) an observed in-session incident (destructive git,
  guardrail/config tamper, secret exposure) that reached a merge or
  burned a round; (b) at least two active backends guarantee deny
  semantics under AFK's actual invocation flags
  (`--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--trust-all-tools`);
  (c) policy and hook scripts can live outside the agent-writable
  worktree; (d) the mechanism verifiably fails closed; (e) measured
  happy-path overhead is below an agreed threshold. If reopened,
  prefer structural options — command allowlist, sandbox, the
  ADR 0016 action-space-reduction pattern — over hooks, and start
  deterministic deny-only: no `ask`, no LLM-evaluated policy, no stop
  loops, no per-edit test runs.
- **PRD 7 and PRD 5's selected cleaner-only scope are complete.** PRD 6 is
  unblocked because PRD 4 and the hand-landed learning-proposal module are
  on `main`; it waits on neither PRD 7 nor deferred hardener #92.
- **Agent-eval merge gating** stays rejected. Re-open it only after
  repeated evidence shows stable results with an agreed false-positive rate.
- **`--self-audit` default-on (PRD 10)** is decided by the recorded
  `AUDIT_CHANGED` rate against the added invocation cost across opted-in
  runs, not by argument. The trigger is falsifiable in both directions: a
  near-zero changed-rate over several opted-in runs deletes the gate; a
  material rate at acceptable cost defaults it on and retires the
  prompt-prose self-audit section it supersedes.
- **`--mutation-report` escalation (PRD 11)** — anything beyond a report —
  requires recorded evidence that new-in-run survivors pointed at real
  defects caught at the draft PR; absent that across several opted-in
  runs, delete the flag. A blocking mutation gate, any kill-rate or score
  threshold, and mutation in the generator's verification command stay
  refused, with the killing arguments recorded in PRD 11's ADR.
- **PRD 12 structural work** re-opens one item at a time from a quiet-host
  profile. A timing regression does not authorize raising
  `suite-budgets.json`; first move the assertion toward a unit test or an
  existing spawned fixture, then remeasure.
- **Automated survivor-killing** stays refused outright: the writer of a
  killing test must never be its accepter. Triage autonomy (Stage B/C) is
  earned per category via eval-pack agreement with the recorded Stage A
  corpus (§2c O5), never granted wholesale; ACCEPT-and-record remains the
  default under low confidence.
- **Durable process supervision** stays cut. The approved plan keeps the
  journal and restart evidence but does not auto-restart a vanished process.
