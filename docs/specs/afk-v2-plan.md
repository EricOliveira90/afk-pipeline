# AFK v2 — the single plan

One document: where the work stands, the six PRDs in dependency order, and
the findings from running AFK on itself that should change v2's content.

Two companion documents, both still authoritative for their own scope:

- `afk-v2-agent-roles.md` — the role-by-role design and cross-cutting
  mechanisms M1–M7. This plan sequences that design; it does not restate it.
- `afk-v2-recovery-plan.md` — the historical record: Phases A–D of
  stabilising the pipeline, plus run-by-run evidence (runs 3–6). Read it for
  *why* a decision was made; read this document for *what happens next*.

---

## 1. Where the work stands

### PRD 1 — Evidence backbone (#69), five slices, effectively complete

| Slice | State | How |
|---|---|---|
| #75 Undeclared scope cannot lock | PASS, merged `1540c9b` | AFK, after a hand-amended contract |
| #76 Every behavior locks with an executable binding | PASS, merged `ab18bc2` | Hand-finished |
| #77 Contract review fails closed | PASS, merged `d86b8f6` | Hand-finished |
| #78 Negotiation converges on open findings | PASS, merged `2b8eaa6` | AFK |
| #79 QA verdicts and retries run on the same rails | 12 commits on branch; QA verdict outstanding | AFK, in flight |

Remaining path: `#79 → assemble PRD 1 into a draft PR → close #69`.

Three of five slices needed human hands. That is the headline fact for
planning PRDs 2–6: **the pipeline could not yet deliver its own evidence
backbone unattended**, and every failure that stopped it was an
infrastructure or governance defect, not a coding one. Section 3 is the
list.

### Pipeline defects found by running AFK on itself

| Issue | Defect | State |
|---|---|---|
| #113 | A from-base restart destroyed unmerged commits and unarchived artifacts | Fixed, merged |
| #114 | Windows stop bypassed the abort path; no cancellation record | Fixed, merged |
| #111 | Run killed mid-round keeps the previous run's error message | Open |
| #112 | Contract-amendment gap: QA boundary findings satisfiable only by reverting work | Open |
| #120 | Gate prepare step classifies a candidate's own compile failure as INFRASTRUCTURE | Open |
| #121 | A process-fatal crash bypasses cancellation bookkeeping | Open |

All six are one class: **the pipeline records or classifies something that
misleads the next actor.** Four were found in the last week of self-runs.

---

## 2. The six PRDs, in dependency order

Unchanged in substance from #69–#74; restated here so the ladder is legible
in one place.

| PRD | Theme | Depends on | Slices |
|---|---|---|---|
| 1 (#69) | Evidence backbone: finding schema, machine manifest, lock validation | — | #75–#79 |
| 2 (#70) | Routing and adjudication: escalation, impasse, human decisions in live runs | 1 | #80, #81, #82, #89, #94 |
| 3 (#71) | Context envelopes and prompts v2 | 1 | #83, #90, #95, #99 |
| 4 (#72) | Acceptance and scope gates: coverage, isolation, two evaluators | 1, 3 | #84, #85, #91, #96, #86 |
| 5 (#73) | Quality loops: cleaner, hardener, quality policy | 4 | #87, #92, #97 |
| 6 (#74) | Aggregate: notes-first guardians and the remediator | 4 | #88, #93, #98 |

Why this order holds: PRD 1 makes control-plane facts machine-readable, so
everything downstream can be deterministic. PRD 3 shapes what each role
receives before PRD 4 adds roles. PRD 4 establishes the approved behavior
baseline that PRDs 5 and 6 preserve and repair against.

**Recommended insertion: a reliability wave between PRD 1 and PRD 2** (see
§4). It is small, it is entirely in the pipeline's own machinery, and every
later PRD runs on top of it.

---

## 3. What the self-runs teach that the PRDs do not yet cover

Each item below is a proposal, with the PRD that should absorb it. Ordered
by leverage. Items already covered by an existing PRD are marked so and not
re-proposed.

### 3.1 Ticket quality is the highest-leverage gate, and nothing gates it

**PRD 3, or its own slice.** PRD 3 governs *prompts*. Nothing governs
*issues*, and the issue is the actual input to negotiation.

Two rounds were lost to the same defect shape, in two different issues:

- #77's in-scope line packed cardinality, uniqueness and type into one
  sentence (`behaviorIds` is a non-empty unique-string array). The planner
  covered the two conjuncts that had named example shapes and dropped the
  one with none. The evaluator checks falsifiability conjunct by conjunct,
  so **a paraphrase of a compound predicate always loses the conjunct with
  no example value.**
- #78 required a `held` finding state that its own enum omitted, then —
  after that was fixed — required the evaluator to *record* WITHDRAWN while
  the artifact schema had no channel to express it. **A criterion that
  requires recording something must name where it is recorded.**

Proposal: a deterministic ticket lint, run before a PRD enters AFK, that
flags

1. a compound predicate in an acceptance criterion without one rejection
   case per conjunct,
2. a criterion naming a state, field, or artifact absent from the schemas
   the issue itself references,
3. a criterion that requires recording an outcome without naming the
   channel,
4. summarised field lists ("all other strings") where enumeration is
   possible.

None of that needs an LLM. All four are checkable against the issue text
plus the referenced schema files. This is cheaper than any negotiation
round it prevents, and it runs once per ticket rather than once per round.

### 3.2 The generator's verification command should be derived, not passed

**PRD 4** (it owns the gate catalog and the test-cost split).

ADR 0038 shipped `--test-command`, an operator string. Run 5 showed the
failure mode: the string contained only vitest suites, and **vitest strips
types without checking them**, so the generator drove its loop to green
across 8 commits over code that did not compile. The base gate then failed,
and because `package.json`'s `prepare` script runs `tsc`, it failed during
*environment preparation* and was classified INFRASTRUCTURE — burning both
retries and killing the slice with two of three rounds unused (#120).

Proposal: the generator's loop is **derived from the gate catalog** — every
required gate that is cheap on a changed tree (format, lint, typecheck,
`test:related`), in gate order, with `test:full` excluded. An operator flag
may narrow it, never omit a required cheap gate. Then a generator cannot
reach a gate that will fail on something it never ran.

This subsumes the current AGENTS.md self-run guidance, which still
prescribes a typecheck-less command and needs correcting either way.

### 3.3 Records must carry provenance, or they mislead

**PRD 1** (it owns artifact schemas and evidence).

Two incidents, one root cause — a record that does not say which run or
which tree produced it:

- After run 6's crash, `#79`'s persisted `error` named a typecheck failure
  from two runs earlier, already fixed, in a run whose gate had since
  passed. An operator reading state is pointed at the wrong defect (#121,
  and #111 before it).
- The babysitter compared a gate's suite times against the wrong baseline
  block in `suite-budgets.json` and concluded a worker had been lost,
  inventing a scheduling mystery. The numbers were fine; the baseline
  belonged to a different branch.

Proposal, three parts:

1. Every persisted record — slice state, gate evidence, measurement block —
   carries the run ID and the tree/branch identity that produced it.
2. A reader that compares two records must compare like-for-like; a
   mismatch is reported, not silently tolerated. Cheap version: stale
   records are cleared when a slice is dispatched, so a previous run's
   reason cannot survive into this one.
3. Measurements are keyed by tree identity rather than appended as prose
   blocks. `suite-budgets.json` now carries five stacked blocks and picking
   the wrong one is the default failure.

Every numeric claim in a report should name the artifact it came from. Both
babysitter errors in this session were provenance errors, not reasoning
errors.

### 3.4 Some gates measure the environment, not the candidate

**PRD 4** (gate declarations) with a consequence for **PRD 1** (verdicts).

Run 4's wall-clock budget gate went red — `fast` at 130.5s against a 110s
budget — with **zero failing tests**, because QA, the orchestrator, a
generator and a babysitter were all resident. QA was literally correct that
the command exited non-zero, so it raised a blocking Major finding. But no
code change could clear it, and the generator's only escape would have been
editing the ratchet from inside a slice whose contract said nothing about
budgets.

Proposal: a gate declaration attribute for environment-sensitive gates.
Inside a pipeline context such a gate is advisory: it reports, it never
produces a blocking finding, and it never consumes a round. Corollary for
PRD 1's finding schema: **a finding that no writing role can act on is not
a blocking finding.** A judge needs a way to say "this failed, and it is
not the candidate's fault" without stalling the slice — QA already has
FAIL/INFRASTRUCTURE for whole-verdict cases, but not per finding.

Related standing decision, worth an ADR either way: during an AFK run the
resident agents *are* the environment, so a wall-clock budget must cover
the loaded in-chain number. Three raises so far, each with recorded
measurements; recording the rule stops a fourth rediscovery.

### 3.5 A classifier that decides "who fixes this" must default to the actor who can act

**Cross-cutting; an ADR, applied first in PRD 4.**

`gate-runner.ts` treats a prepare failure as the candidate's fault only
when it matches `ERR_PNPM_OUTDATED_LOCKFILE`; everything else becomes
INFRASTRUCTURE and is retried identically. A compile error in the
candidate's own `prepare` script is equally deterministic and equally the
generator's to fix, so it looped and then killed the slice (#120).

The general rule: **when classification is uncertain, choose the branch
that cannot loop.** Blaming an actor who can change the input costs at most
a wasted round; blaming the environment for a deterministic failure costs
every retry plus the slice.

One tension to settle before implementing, not during: inverting the
default means a transient network failure during install would burn a
generator round where today it correctly retries. The narrower move — treat
a non-zero exit from a lifecycle script as candidate-owned, keyed on exit
code rather than message text — sidesteps it.

### 3.6 Every exit path writes its record

**Reliability wave; mechanism belongs beside PRD 2's routing.**

#114 fixed signal-based stops, verified live: a Ctrl-Break wrote CANCELLED
records within 2.4s for the in-flight slice and its never-dispatched
dependent. But the fix hangs off the `AbortSignal`, so run 6's unhandled
ENOSPC on a WriteStream terminated the process with nothing recorded
(#121).

Proposal: route `uncaughtException`, `unhandledRejection` and fatal stream
errors through the same bookkeeping, with a distinct cause (`CRASHED`, with
the error text), then re-throw. "Died of ENOSPC mid-QA" is recoverable; a
record naming a stale, already-fixed failure is worse than no record,
because it invites the wrong fix.

### 3.7 Preflight the resources a run consumes

**Reliability wave.**

Run 6 died with 200 KB free. Run 3's #77 died on a leaked directory handle
that blocked a worktree refresh for an entire run, and the handle outlived
the run that created it. Neither is detected before dispatch.

Proposal: a launch preflight that fails fast on free disk below a
configured floor, on leftover registered worktrees from a previous run, and
on live processes holding paths inside the namespace this run will use.
Cheap, and each condition has already cost a multi-hour run.

Sweep the run's own namespace at start, too: teardown leaves empty
directory shells on Windows (467 of them accumulated), which cost a
diagnosis cycle by *looking* like a space leak. Measured, they held 0.02 GB
— there is no space leak, and that correction belongs in the record so it
is not re-chased.

### 3.8 Hand-finishing is a supported mode; give it a command

**PRD 2** (human decisions in live runs).

Used successfully four times: #76, #77, and twice to unblock #79. The
procedure is always the same — work the slice branch in a fresh worktree,
verify with the full suite, merge into the feature branch, then hand-edit
run state to `{ "phase": "PASS", "branch": ..., "mergedToFeature": true }`
so `--only-failed` stops selecting it and `priorCompleted` unblocks its
dependents.

The hand-edit is the weak link: it is JSON surgery on the file the
orchestrator trusts, and `isSliceComplete` is exactly
`phase === "PASS" && mergedToFeature === true` (`src/run-state.ts:416`), so
a typo silently either re-selects the slice or falsely satisfies a
dependency. Proposal: `afk adopt <slice>` — verify the branch merges and
its gates pass, merge, write the state entry, record who adopted it and
why. Hand-finishing stops being off-road.

### 3.9 Make the resume cap and other bounds visible before they bite

**Reliability wave; small.**

`MAX_RESUME_ATTEMPTS` is 2, and the counter is invisible until the run
refuses. During #79's recovery the difference between "one attempt left"
and "none" changed the recommendation, and it took reading the state file to
know. Report remaining attempts, remaining rounds, and remaining
infrastructure retries at dispatch, in `run.log` and `afk status`.

### 3.10 Measure agent reading time, not just command time

**PRD 3** (envelopes) and **PRD 4** (evidence).

The harvest of run 3 found QA r2 spent **30.3 of 30.9 minutes reading** —
it ran 34 seconds of commands and passed the slice on the base gate's
evidence. That is the intended design, and it means suite-selection work
has hit diminishing returns while *reading* is now the dominant cost. Run 6
priced the remaining duplication too: QA r1 ran the full suite at 772.5s on
the same tree the base gate had just tested at 739.3s — about 13 minutes
per round, which PRD 4's exact-tree reuse (#96) already targets.

Already covered: envelope discipline for writing roles (PRD 3), change
summaries for the final evaluator (PRD 4). Not covered: the *measurement*.
Proposal: record reading time versus verification time per invocation as
first-class evidence, so envelope changes can be judged by their effect on
the dominant cost rather than argued.

Also unaddressed by anything: generator round 1 alone was 109.6 minutes in
run 5 — 44% of that run. PRD 3's focused envelope is the hypothesis for
reducing it; this metric is how we would know.

---

## 4. Sequencing

```
#79 → assemble PRD 1 → close #69
        │
        ├── reliability wave (#111, #112, #120, #121 + §3.6, §3.7, §3.9)
        │     parallel manual sessions, separate worktrees
        │
        ├── ticket lint (§3.1) — before any PRD enters AFK
        │
        └── PRD 2 ──┬── PRD 3 ── PRD 4 ──┬── PRD 5
                    │                     └── PRD 6
                    └── (§3.8 afk adopt rides with PRD 2)
```

**The reliability wave runs by hand, not by AFK.** Pipeline-safety fixes
are precisely the changes not to depend on the pipeline to deliver, and
wave 1 already proved the pattern works: #113 and #114 were fixed by
parallel manual sessions on separate worktrees, reviewed and merged in one
gate.

**Grill §3.5 before ticketing #120.** It carries a real tradeoff, and a
naive inversion trades one wasted round for another.

**Run the ticket lint against PRDs 2–6 before they enter AFK.** #77 and #78
both lost rounds to defects the lint would have caught, in issues that
looked fine to a human reader.

### Per-wave discipline, learned the hard way

- Budget a prep-chain refresh as its own task, not a step. Merging main
  into the feature branch produced seven conflicting files because main had
  restructured test files that slice branches were editing. Expect that
  whenever main restructures a file a slice branch touches.
- One full test suite at a time on this machine, and prefer the pipeline's
  gates to own it.
- Every launch passes the verification command explicitly, and it includes
  typecheck until §3.2 makes the flag unnecessary.
- A stopped run is recoverable; verify the CANCELLED records landed and
  record the commit the slice branch is left at.

---

## 5. Open points

- Does the ticket lint (§3.1) become a slice of PRD 3, or its own small
  PRD? It has no dependency on the envelope work and could ship first.
- §3.4 needs a decision on where the "not the candidate's fault" finding
  class lives: PRD 1's finding schema, or PRD 4's gate declarations, or
  both.
- Whether `afk adopt` (§3.8) is worth building before the reliability wave;
  it is the only proposal here that adds a command rather than closing a
  hole.
- PRD 5's mutation scope and PRD 6's remediator write scope remain as
  recorded in `afk-v2-agent-roles.md`; nothing in the self-runs touched
  them, so they are untested by evidence rather than settled.
