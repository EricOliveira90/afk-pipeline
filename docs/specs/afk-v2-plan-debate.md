# AFK v2 plan — debate review

A structured, refereed debate on hardening `afk-v2-plan.md`, held 2026-08-28.
Two sub-agents argued from assigned stances — **Debater A: governance and
correctness** (verifiable, auditable, safe unattended overnight; suspicious
of anything agent-certified), **Debater B: throughput and simplicity**
(slices that finish; suspicious of per-slice-forever costs against defects
seen once). Four rounds: independent openings, cross-examination, costing on
a fixed four-axis scale, convergence. The orchestrator refereed for evidence
discipline and did not vote. This document is a **recommendation for the
human to decide on**; it changes nothing by itself.

Rating scale used throughout: **L**everage (1–5, failure prevented in the
currency of the measured incidents), **C**ost (1–5, higher = more costly:
implementation slices plus recurring per-slice/per-run wall-clock),
**E**vidence (5 = measured run-ending incident … 1 = hypothesis),
**R**eversibility (5 = deletable in an afternoon, 1 = other mechanisms grow
to depend on it).

Both debaters read the plan, the roles doc, the runbook, the recovery plan's
run 3–6 evidence, the superseded gauntlet, PRDs #69–#74 with their slices,
defects #111/#112/#120/#121, the grounding source files
(`gate-runner.ts`, `run-state.ts:416`, `resume.ts:62`, `suite-budgets.json`,
`AGENTS.md`), and the cited ADRs. Several claims were settled by a debater
re-reading a file mid-round rather than by assertion — the two decisive ones
are noted where they occur (§2 auto-kill, §2 provenance store).

---

## 1. Consensus revised §3 — the agreed proposal set, in priority order

All ratings are jointly reconciled; no pair ended more than one point apart
and every gap was closed by argument, not averaging.

| # | Item | Origin | Placement | L/C/E/R | Recurring cost | Failure mode |
|---|---|---|---|---|---|---|
| 1 | **Classifier fix, narrow form**: non-zero exit from a lifecycle script during gate `prepare` is candidate-owned, keyed on exit code, replacing the one-marker whitelist at `gate-runner.ts:202`. One ADR, merged with defect #120 (the plan double-counted them). | plan §3.5 | Reliability wave, ships first | 5/1/5/5 | zero | A genuine environment fault surfacing inside a lifecycle script (disk full mid-`tsc`) burns one recoverable generator round — vs today's deterministic slice death. |
| 2 | **Derived generator verification command**: generator loop derived from the gate catalog (every required cheap-on-changed-tree gate in gate order, `test:full` excluded); an operator flag may narrow, never omit. Needs a numeric cheapness threshold. Corrects `AGENTS.md`, which still prescribes the typecheck-less command today. | plan §3.2 | PRD 4 | 4/2/5/4 | seconds per generator iteration (typecheck measured 3.3–3.8 s) | A gate misdeclared "cheap" taxes every generator iteration forever — hence the numeric threshold, not a judgment call. |
| 3 | **`afk stop` sentinel**: orchestrator polls a run-namespaced sentinel file and routes through the existing `AbortSignal` path so ADR 0040's cancellation records actually fire. Preflight sweeps stale sentinels. | new (both, independently) | Reliability wave | 5/1/5/5 | one `existsSync` per scheduler tick | Sentinel unseen if the tick loop itself is wedged — fallback is today's status quo (hard kill). |
| 4 | **Crash records**: `uncaughtException` / `unhandledRejection` / fatal stream errors routed through cancellation bookkeeping with cause `CRASHED`, best-effort write (ENOSPC may defeat it — accepted; no reserved-space machinery), item 11's clear-on-dispatch as backstop. | plan §3.6 | Reliability wave | 5/1/5/5 | zero (dormant handlers) | The handler itself cannot run under the very condition (ENOSPC) it most needs to record — accepted as best-effort by design. |
| 5 | **Change-summary-first candidate-evaluator envelope**: PRD 4 already builds a change-summary artifact for the *final* evaluator; give it a second consumer — one manifest entry in PRD 3's assembly machinery leads the *candidate* evaluator's envelope with the slice diff summary and manifest; the worktree stays available for pursuit. Attacks the largest measured recurring cost (22.7–30.3 min reading/round, 65–98 % of QA wall-clock). | new (A, improved by B) | PRD 4 artifact, PRD 3 manifest entry | 5/2/4/5 | one diff-stat-class artifact write per round | Diff-anchoring under-reads preservation context — bounded by the full-suite gate and the explorer's preservation catalog. **Rider**: L5 carries a falsifier — if item 13's metric shows no material drop in evaluator nonCommandTime within the first two PRD runs, the L5 was wrong and the envelope ordering gets revisited. |
| 6 | **Ticket lint**, pre-AFK, once per ticket: checks 2 (criterion names a state/field/artifact absent from the schemas the issue references) and 3 (recording obligation without a named channel) ship as the deterministic gate with a recorded waive-with-reason; check 4 (summarised field lists) ships as a warn-only lexicon lint; check 1 (compound predicates) goes to the authoring checklist (see §2). Must run against PRDs 2–6 before they enter AFK. | plan §3.1, narrowed | Own pre-AFK tool, before PRD 2 | 4/2/5/5 | zero per slice (seconds per ticket) | Waive-with-reason becomes a rubber stamp — mitigated by the waiver being recorded text; false positives training authors to phrase around it is why checks 1/4 were narrowed. |
| 7 | **Preflight family — detection + report + fail-fast only**: launch preflight fails fast on a disk floor, leftover registered worktrees, and live handles/processes holding paths in the run namespace (reported as a named PID list for the operator); sweeps empty directory shells. No auto-kill of any form and no launch-time state audit (both cut — see §2). | plan §3.7, narrowed | Reliability wave | 4/2/5/5 | seconds per launch, zero per slice | A false "leftover" report delays a launch — operator-visible and overridable; launch-time checks give no mid-run protection (items 3–4 cover that). |
| 8 | **PRDs 4–6 role-cost governance**: cleaner and hardener **default off** until #73 story 17's per-stage ROI evidence exists; any enable/disable recorded in run evidence and the draft PR (the rider); per #72 story 13 the final evaluator runs only when a post-approval writer changed the tree, so off-by-default silences it for free. This is #73's own text ("optional until configured") made explicit and auditable. | new rider on existing PRDs | PRDs 5–6 policy | 4/1/3/5 | one recorded config line per run | Useful cleaner passes forgone until ROI evidence exists — which is the point. |
| 9 | **QA-dedup resequenced**: before PRD 4's #96 lands, the orchestrator injects base-gate evidence plus the exact tree sha into the QA prompt as a citable skip authorization (recovery plan Phase D step 14). Guards: exact-sha match else re-run, fail closed; the QA verdict artifact records the citation (evidence ID + sha); the ADR 0012 amendment lands *with* it. Saves the measured ~13 min per QA round across the whole PRD 2 and PRD 3 runs. | new (B, guards by A) | Reliability wave | 4/2/5/3 | one sha comparison per QA round (removes a ~13-min suite run) | Sha mismatch falls closed to today's behaviour — strictly no worse; loose matching would make QA a rubber stamp, hence exact-sha. |
| 10 | **`afk adopt`**, thin, now carrying the write-time verification (see §2, state-audit cut): verify the branch merges and its gates pass, merge, write the state entry, record who adopted and why; refusal message names *which* check failed (merge unconfirmed vs gates unrun); adoption record surfaces in the run summary and the draft PR. Hand-finishing was the majority mode of PRD 1 (used 4×) and today is JSON surgery on the exact predicate `isSliceComplete` (`run-state.ts:416`) trusts. | plan §3.8 | PRD 2 | 4/2/4/4 | zero per slice; per adoption, the gate run the manual procedure already pays | Adopt becomes a bypass valve for failing gates — the gate run plus the surfaced adoption record is the guard; more ceremony was explicitly rejected. |
| 11 | **Provenance, narrowed**: slice-state records carry run ID everywhere (tree identity alone cannot discriminate #121's two-runs-stale error); reader-side mismatch is reported, never silently tolerated; stale error text cleared when a slice is dispatched. Gate-evidence provenance is **already covered** by PRD 4 story 1 verbatim and is not re-proposed. Two halves of one invariant with item 4; tickets should cite each other. | plan §3.3, narrowed | PRD 1 (schemas), wave (clear-on-dispatch) | 4/2/5/3 | bytes per record | Provenance written but never checked is decoration — the reader-side half is the enforcement half and must not be dropped in slicing. R3: record-consuming clients (item 9's citation) grow to depend on the fields. |
| 12 | **Advisory environment gates, catalog-declared only**: a gate *declared* environment-sensitive in the policy-owned catalog is advisory inside a pipeline context (reports, never blocks, never consumes a round); it still reports in evidence and surfaces at PR review. Ships with the loaded-in-chain budget ADR (three raises already recorded; stop the fourth rediscovery). The plan's general corollary is cut (§2). | plan §3.4, narrowed | PRD 4 declarations; ADR now | 3/2/4/4 | zero | Accepted residual: the first *undeclared* environment-sensitive gate deadlocks one run-4-style round before someone declares it — bounded, once per gate, and the declaration is itself the fix. |
| 13 | **Reading-time metric**: per-invocation nonCommandTime (wall minus command time) as first-class evidence; a measurement, **never a gate**; the harvest scripts already compute it. Scores PRD 3's envelope bet and item 5's rider; feeds #73 story 17. | plan §3.10 | PRD 3 / PRD 4 evidence | 3/1/5/5 | one timer per invocation | Over-interpretation — the number conflates model latency, tool latency and reading; name it honestly and never gate on it. |
| 14 | **Bounds visibility**: remaining resume attempts (`MAX_RESUME_ATTEMPTS`, `resume.ts:62`), rounds, and infrastructure retries reported at dispatch in `run.log` and `afk status`. Also the carrier for the stage-duration journal event (§3). | plan §3.9 | Reliability wave | 2/1/3/5 | one log line per dispatch | None worth the name — kept because the cost is genuinely nothing. |

Companion items that ride the above (rated in §3): the reader-side budget
check (3/1/5/5, wave) and the stage-duration journal event (2/1/3/5, rides
items 13–14).

---

## 2. What was cut, and the argument that killed it

- **The soft per-stage watchdog ping** (B's own proposal; both cut it in
  round 3). A's argument, which B accepted as its own §3.4 standard turned
  on itself: an advisory ping into an unattended run at 3 a.m. has no
  receiver who can act, and nothing in the record shows the 109.6-minute
  generator round was *doomed* rather than *large* — a watchdog tuned on one
  data point either never fires or fires on healthy long rounds. The useful
  residue — stage duration vs history — survives as a run-journal event
  feeding #73 story 17. Re-proposal requires future bimodal
  (doomed-vs-large) evidence.
- **Leaked-holder auto-kill, both forms.** B's scan-based form (kill
  processes holding namespace paths) died in round 2: ADR 0020's own text
  says `taskkill /T` cannot enumerate children of a dead root, so the scan
  is new unverified kill machinery whose cwd guard both under-matches (file
  handles without cwd inside) and over-matches (an operator shell cd'd into
  the namespace). A's record-based replacement (kill only PIDs the previous
  run recorded) died in round 4 when **A checked the code and conceded**:
  `TerminationReport.survivors` is populated only by post-kill polling in
  the orderly-teardown path — the crash classes that produce leaks write no
  record at all, so the machinery cannot fire when most needed; and killing
  an hours-old recorded PID would be the first code path to break ADR
  0020's "only snapshot/BFS members are ever force-killed" guarantee, with
  PID reuse by a concurrent sibling run as the correlated collision the
  namespace guard cannot exclude. Detection + report + fail-fast (item 7)
  is the whole cure; the receiver is the operator who just typed the launch
  command. Re-proposal requires a second leak incident in which the
  survivor record was actually present.
- **The launch-time state↔branch truth audit** (A's own proposal; A cut it
  in round 3, B accepted in round 4). An advisory declared advisory-forever
  — because squash/rebase permanently breaks its ancestry heuristic — is an
  unfalsifiable warning whose false-positive rate only rises: the same
  shape as the watchdog ping. The invariant is enforced instead at **write
  time**, inside `afk adopt` (item 10), where refusing to write state is
  falsifiable and the operator is present with evidence. A launch scan asks
  "was this ever broken by anyone?"; the adopt check asks "am I about to
  break it right now?" — only the second has a decidable answer.
- **The mandatory `rejection-cases` ticket-format field** (A's structural
  rescue of lint check 1; A cut it itself in round 3). A format imposition
  taxes every future ticket author forever and rates Reversibility ~1 —
  templates and tooling grow to depend on a required schema field within
  weeks — against a defect shape observed twice. Check 1 in free prose is
  NL parsing (a judgment gate wearing a lint costume, conceded by A in
  round 2); it lives on the authoring checklist.
- **The keyed measurement store** (plan §3.3 part 3; A withdrew in round
  2). PRD 4 story 1 already covers gate-evidence provenance verbatim, and
  `suite-budgets.json` is a hand-edited ratchet file — schema machinery for
  it is decoration. Replaced by the reader-side budget check (§3), which is
  the enforcement without the build.
- **The general finding rule** ("a finding no writing role can act on is
  not a blocking finding", plan §3.4 corollary; B withdrew in round 2,
  persuaded by A). Per-finding actionability classification by the QA judge
  is agent-certified classification — the same failure class as run 5's
  agent-certified green and #120's misclassification. Only the
  deterministic, catalog-declared form survives (item 12).
- **Double-counting of §3.5 and #120** in the plan's own §4: they are one
  fix and one ADR, not two work items.

---

## 3. New proposals the debate produced (not in the starting ten)

| Proposal | Origin | Placement | L/C/E/R |
|---|---|---|---|
| **`afk stop` sentinel** (item 3). Independently proposed by both debaters from the same recovery-plan evidence (CTRL_C reported success twice while the orchestrator kept running; the delivery that worked left no cancellation record) — the strongest consensus in the debate. | both, round 1 | Reliability wave | 5/1/5/5 |
| **Change-summary-first candidate-evaluator envelope** (item 5). Proposed by the *governance* debater as an attack on the largest measured recurring cost; improved by B to reuse PRD 4's final-evaluator artifact so nothing new is built. | A, round 1 | PRD 4 + PRD 3 | 5/2/4/5 |
| **QA-dedup resequenced** (item 9). Proposed by B; adopted by A once the skip authorization was recognised as orchestrator-asserted deterministic evidence, not agent self-certification. | B, round 1 | Reliability wave | 4/2/5/3 |
| **Reader-side budget check**: ~10 lines in `check-suite-budgets.mjs` — refuse to compare a measurement block whose branch label doesn't match the current branch; warn on tree divergence; warn/refuse only, never blocks a gate. Grounded in the run-3 babysitter error, which happened *with labels present* because no reader checked them, and in a live reproduction during the debate itself (A found `fast: 90` in one tree vs a recorded raise to 170 in the other and could not tell which governs). | A, round 2 | Reliability wave | 3/1/5/5 |
| **Role-cost governance rider** (item 8): enable/disable of cleaner/hardener recorded in run evidence and the draft PR, so a reviewer knows which quality stages the code did *not* pass through. | A, round 2 | PRDs 5–6 | 3/1/4/5 |
| **Stage-duration journal event**: the watchdog's residue — stage duration vs recorded history as a run-journal event under items 13–14, feeding #73 story 17's ROI dataset. Emits data, never acts. | A's counter to B's watchdog, round 2 | Rides items 13–14 | 2/1/3/5 |

---

## 4. Unresolved disagreements — decisions for the human

**None remain open.** Every dispute closed on evidence or explicit
concession, not compromise. Three closures carry conditions the human
should know about, because they are the re-open triggers:

1. **Auto-kill (was D1)** — resolved to detection-only after A verified
   ADR 0020's record mechanics against the code and conceded. *Re-open
   trigger*: a second leaked-holder incident in which the survivor record
   was actually present (i.e., the orderly-kill-with-stragglers class —
   the only class where the record exists).
2. **Watchdog (was C5)** — ping cut, data kept. *Re-open trigger*: the
   journal events someday show a bimodal doomed-vs-large distribution of
   stage durations; then a watchdog can be re-proposed at Evidence 4
   instead of 1.
3. **Item 5's L5 rating** — the one rating the debaters reconciled by
   attaching a falsifier rather than by agreement: if item 13's metric
   shows no material drop in candidate-evaluator nonCommandTime within two
   PRD runs of item 5 shipping, the leverage claim was wrong and the
   envelope ordering gets revisited.

If the human wants a place to disagree with the debate itself, the two
closest calls were: cutting the launch-time state audit entirely (both
sides ultimately agreed the write-time check in `afk adopt` covers the
observed #76 class, but the audit would also have caught hand-edits made
*outside* adopt — the debate judged that residual class small once adopt
exists) and defaulting cleaner/hardener off (the governance debater argued
for off, the throughput debater originally for on; #73's own "optional
until configured" text settled it, but it does mean PRDs 5–6 ship dormant
until someone runs the ROI experiment).

---

## 5. Recommended changes to PRD sequencing and PRDs 2–6 content

**Ladder** (confirms the plan's §4, with insertions):

```
#79 → assemble PRD 1 → close #69
  → ticket lint (item 6) gates every ticket before any PRD enters AFK
  → reliability wave, by hand, parallel worktrees:
      item 1 (classifier ADR + fix), item 3 (afk stop), item 4 (crash
      records), item 7 (preflight, detection-only), item 9 (QA-dedup +
      ADR 0012 amendment), reader-side budget check, clear-on-dispatch
      (item 11's wave half), items 13–14 + journal event
  → PRD 2  (+ afk adopt / item 10, with write-time verification)
  → PRD 3  (item 5's manifest entry; assembly stays provider-agnostic
            at the interface — see the story-16 fence below)
  → PRD 4  (item 2, item 5's artifact, gate-evidence provenance per its
            own story 1)
  → { PRD 5, PRD 6 } under item 8 governance: cleaner + hardener
     default-off until #73 story 17 ROI evidence
```

- **I13 (QA-dedup) belongs in the wave, not PRD 2 run-config**: it is
  hand-applied, the ADR 0012 amendment lands with it, and every subsequent
  PRD run — including PRD 2's own — then banks the ~13 min/QA-round
  immediately.
- **Grill-§3.5-before-ticketing-#120 is resolved by this debate**: the
  narrow form (lifecycle-script exit = candidate-owned, keyed on exit code)
  is the agreed design; the full inversion was rejected by both sides for
  the transient-network cost.

**Deferrals from PRDs 2–6, jointly agreed as the pay-for** (verified
against the issues as filed):

| Deferral | Argument |
|---|---|
| **#72 story 9** (probe-as-evidence) | A whole transport mechanism (probe capture, allowlisting, copy-back) demanded by no measured incident, and it puts agent-authored test material into the evidence chain. Isolation (story 8) ships without it. |
| **#72 story 15** (code attribution of final-evaluator findings to the post-approval role) | Moot while cleaner/hardener are default-off — there is no post-approval writer to attribute to. Lands with PRD 5 enablement. |
| **#73 stories 9–15 and 19** (the hardener and all mutation machinery), keeping 3/4/5/16/17/20 | The largest build in PRDs 4–6, deferred until story 17's ROI evidence exists for the *cleaner* — don't build the second repair loop before the first has a measured ROI. |
| **#70 story 14** (babysit skill relocation + global install) | Packaging, not routing; courier duties (story 5) work from the skill's current home. Re-opens when a skill/pipeline version skew actually bites a run. |
| **#71 story 16** (identical logical envelope across Kiro/Claude/Codex) | Self-runs exercise one provider; no evidence demands parity now. **Fence attached** (A's condition, accepted): deferring the parity *test matrix* must not license provider-*specific* envelope assembly — the manifest → envelope layer stays provider-agnostic at the interface (ADR 0002 draws the line; #71 story 17's determinism requirement is only testable if assembly doesn't branch on provider). Costs one sentence in PRD 3. |

One documentation correction that should not wait: **`AGENTS.md`'s self-run
launch command still prescribes the typecheck-less `--test-command` that
caused run 5's failure**. Until item 2 ships, every launch must add
typecheck explicitly; the plan's §4 already says this, and the debate
flags the AGENTS.md text itself as a record-that-misleads (item 11's
class) worth fixing in the wave.

---

## 6. The balance: where AFK v2 is over-indexed, and the cheapest fix

The debate's most striking dynamic: **both debaters abandoned their
caricatures in round 1 under the same evidence.** The throughput debater
opened by conceding that the throughput bottleneck *is currently bad
governance* — all three run-enders were governance/infrastructure defects,
zero were coding defects. The governance debater closed round 1 by
conceding that the failures were *not* caused by insufficient gating —
negotiation cost 11 % of a run — and that the work needed is "making the
existing records and classifiers tell the truth cheaply", not more
judgment gates. Those two concessions are the same finding from opposite
ends, and everything else followed from it.

Where the measured minutes actually went is rigour re-spent on itself:
22.7–30.3 min of evaluator reading per round, ~13 min of duplicated QA
gates per round, 12.4–14.8 min of base gates per round, ~35 min of
redundant full-suite runs inside one generator round — against ~100-minute
generator rounds doing the actual work. **The pipeline does not lack
checking; it lacks memory of checking already done.** Every headline
saving in this consensus (items 5, 9, 2) is the same move: carry evidence
forward instead of regenerating it, always with a fail-closed fallback to
today's behaviour.

Conversely, the genuine reliability gaps were all truth-on-exit gaps, and
they are almost free to close: item 1 is one classification branch, item 4
is handler registration, item 3 is a sentinel file, item 10's verification
is a check at an existing write point. Nothing on the final list adds
minutes to the happy path. Everything expensive that *claimed* to be
safety — the watchdog ping, the launch-time audit, auto-kill in both
forms, the mandatory ticket field — died in debate because it added
standing cost or standing noise against incidents countable on one hand,
and in two cases could make an incident worse.

**The cheapest change that fixes the balance: ship items 5 and 9 together**
— reuse the final-evaluator change summary for the candidate evaluator,
and cite base-gate evidence into the QA prompt. Roughly 35–43 minutes back
per round, no new machinery, both fail closed, and item 13's metric ships
alongside to prove or falsify the saving. Paired with item 8's default-off
governance, PRDs 4–6 then grow rigour only where the ROI evidence —
which items 13–14 now exist to produce — says it pays.

---

### Appendix: how positions moved (audit trail)

- **A conceded**: gate-evidence provenance already covered by PRD 4 story 1;
  keyed measurement store withdrawn; lint check 1 in free prose is NL
  parsing; the structural rejection-cases field cut (its own round-3
  self-cut); item 2 raised from rank 7 to rank 2; B's QA-dedup adopted with
  guards; the launch-time state audit cut (its own proposal); record-based
  auto-kill conceded in round 4 after verifying ADR 0020's record mechanics
  against the code; item 5's leverage raised to 5 with a falsifiability
  rider.
- **B conceded**: the classifier fix raised to rank 1 (dead slice > wasted
  round; the fault class is larger than the typecheck trigger); the general
  finding rule withdrawn as agent-certified classification; A's state audit
  first adopted, then A's cut of it accepted with relocation into `afk
  adopt`; A's evaluator envelope adopted and improved; "resist ceremony" on
  adopt withdrawn; the reader-side budget check conceded; default-off for
  cleaner/hardener conceded; its own watchdog ping and scan-based auto-kill
  cut.
- **Refused fabrication, for the record**: when a round-3 dispatch failed
  to deliver the referee's state-of-debate, both debaters independently
  refused to reconstruct the canonical item list from the plan documents
  and asked to be re-dispatched — the round was re-run with the record
  delivered. No content in this document rests on an unverified
  reconstruction.
