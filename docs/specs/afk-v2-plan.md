# AFK v2 — the single plan

One document: where the work stands, the six PRDs in dependency order, the
agreed hardening set from the plan debate, and a sequencing that pays the
next runs first.

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
planning PRDs 2–6: **the pipeline could not yet deliver its own evidence
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

---

## 2. The six PRDs, in dependency order — with the agreed deferrals

| PRD | Theme | Depends on | Slices | Debate changes |
|---|---|---|---|---|
| 1 (#69) | Evidence backbone | — | #75–#79 | run-ID provenance fields land at assembly (§3 item 11) |
| 2 (#70) | Routing and adjudication | 1 | #80, #81, #82, #89, #94 | carries `afk adopt` (§3 item 10); **defer story 14** (babysit-skill packaging) |
| 3 (#71) | Context envelopes and prompts v2 | 1 | #83, #90, #95, #99 | carries the candidate-evaluator manifest entry (§3 item 5); **defer story 16** (cross-provider parity matrix) with the fence: envelope *assembly* stays provider-agnostic at the interface (ADR 0002; story 17's determinism requirement depends on it) |
| 4 (#72) | Acceptance and scope gates | 1, 3 | #84, #85, #91, #96, #86 | carries §3 items 2, 5 (artifact), 12; **defer story 9** (probe-as-evidence) and **story 15** (final-evaluator code attribution — moot while cleaner/hardener are off) |
| 5 (#73) | Quality loops | 4 | #87, #92, #97 | cleaner + hardener **default off** until story 17 ROI evidence (§3 item 8); **defer stories 9–15 and 19** (all hardener/mutation machinery), keeping 3/4/5/16/17/20 |
| 6 (#74) | Aggregate: guardians and remediator | 4 | #88, #93, #98 | under item 8 governance; final evaluator is free while cleaner/hardener are off (#72 story 13) |

Why this order holds, unchanged: PRD 1 makes control-plane facts
machine-readable; PRD 3 shapes what each role receives before PRD 4 adds
roles; PRD 4 establishes the baseline PRDs 5–6 preserve. Note PRDs 2 and 3
depend only on PRD 1 and are **dependency-independent of each other**, and
PRDs 5 and 6 both hang off PRD 4 — §4 exploits both facts.

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
| 6 | **Ticket lint** (§3.1, narrowed): checks 2 (criterion names a state/field/artifact absent from the referenced schemas) and 3 (recording obligation without a named channel) gate with recorded waive-with-reason; check 4 (summarised field lists) warns via lexicon lint; check 1 (compound predicates) is an authoring-checklist item, not a lint — free-prose detection is NL parsing and the structural rescue (a mandatory ticket field) was cut as a forever-tax. **Must run against PRDs 2–6 before they enter AFK.** | pre-AFK tool | 4/2/5/5 | zero per slice | waive-with-reason decays into a rubber stamp — the waiver is recorded text |
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
finding rule. Each carries a re-open trigger; do not re-propose without it.

---

## 4. Sequencing — pay the next runs first, in parallel tracks

Ordering principle: **an item's priority is how soon the *next* AFK run
collects its benefit.** Everything in Track 2 pays from the very next run
onward; PRD-embedded items pay from their PRD's run onward. Parallelism is
real for manual sessions (separate worktrees, the proven #113/#114
pattern); AFK runs themselves serialize on this machine (one full suite at
a time), so "parallel" for PRDs means *prep in parallel, run whichever is
ready*.

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
├─ Track 3 (manual)           item 6 ticket lint tool → lint PRDs 2–6 tickets, fix what it flags
└─ Track 4 (manual, docs)     loaded-in-chain budget ADR (item 12's half) · AGENTS.md
                              launch-command correction — DONE (interim command until item 2)

GATE: PRD 1 closed + wave merged + tickets linted
  → AFK: PRD 2 (item 10 afk adopt; story 14 deferred)
  → AFK: PRD 3 (item 5 manifest entry, item 13; story 16 deferred, assembly fence kept)
       PRDs 2 and 3 are dependency-independent: prep both, launch in order,
       and if one stalls on a human decision, start the other.
  → AFK: PRD 4 (item 2, item 5 artifact, item 12 attribute, provenance story 1;
                stories 9 and 15 deferred)
  → AFK: PRD 5 (cleaner only, default-off, story 17 ROI experiment)  ∥  PRD 6
       both depend only on PRD 4 — parallel-eligible, serialized only by the machine.
```

What each stage banks for the runs after it:

- **The wave** removes the three run-killer classes (misclassification,
  unrecorded exits, resource surprises) and saves ~13 min per QA round —
  before PRD 2's run ever starts.
- **The lint** protects the scarce round cap: #77 and #78 each lost rounds
  to lintable defects in tickets that looked fine to a human.
- **PRD 4** lands the two big recurring-cost attacks (items 2 and 5,
  ~35–43 min/round combined with item 9) plus the advisory-gate attribute.
- **PRD 5's run** is itself the experiment: story 17 produces the ROI
  evidence that decides whether cleaner/hardener ever default on.

### Per-wave discipline, learned the hard way (unchanged, one update)

- Budget a prep-chain refresh as its own task, not a step; expect conflicts
  whenever main restructures a file a slice branch touches.
- One full test suite at a time on this machine; prefer the pipeline's
  gates to own it.
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
| Ticket lint tool + linting PRDs 2–6 (item 6) | **Manual** | It must exist *before* AFK ingests the tickets it gates; it is a small deterministic tool with no contract worth negotiating. |
| ADRs (classifier, loaded-in-chain budget, ADR 0012 amendment) and the `AGENTS.md` correction | **Manual** | Documents. Zero benefit from the pipeline. |
| Hand-finishing stuck slices (until item 10 exists) | **Manual, documented procedure** | Verify with the full suite, merge, then edit state — and prefer waiting for `afk adopt` over fresh JSON surgery on `isSliceComplete` (`run-state.ts:416`). |
| PRD 2 (routing, `afk adopt`), PRD 3 (envelopes), PRD 4 (gates), PRD 5 (cleaner + ROI), PRD 6 (guardians) | **AFK** | Multi-slice, contract-sized feature work where negotiation, lock validation and gate evidence earn their cost — and every run is also the measurement the plan needs (items 13–14 evidence, story 17 ROI). These are the runs the wave exists to protect. |
| PRD-embedded hardening (items 2, 5, 10, 12, 13, provenance story 1) | **AFK**, as slices of their PRDs | Each is genuine feature work inside a PRD's contract, not pipeline first-aid; splitting them out would re-create the double-counting the debate removed. |

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
  by argument — the run that produces it is PRD 5's.
- **Deferred stories** (#70 s14, #71 s16, #72 s9, #72 s15, #73 s9–15+19)
  re-enter only when an incident or the ROI evidence demands them; the
  PRD 3 assembly fence (provider-agnostic envelope interface) holds
  regardless.
