# Dispatching a slice clears its persisted record

Completes ADR 0018 (immediate outcome persistence; RUNNING is never
persisted). Evidence: issue #111, and run 6 of the AFK v2
evidence-backbone run. The wave half of §3 item 11 in
`docs/specs/afk-v2-plan.md`; the run-ID schema field is the other half
and lands with PRD 1 assembly, deliberately not here.

## What happened

ADR 0018 says a slice's outcome is persisted the moment it is decided,
and that `RUNNING` never reaches disk. Both halves are true. Together
they leave a state nobody designed: while a slice runs, the state file
holds **the previous attempt's** record, and nothing in the file says so.

Run 6 crashed mid-round. The next launch read `.afk/state/<slug>.json`,
found `#79: ERROR — <a typecheck failure>`, and announced it:

```
  Retrying #79 ... (previous run: ERROR — <typecheck failure>)
```

The typecheck failure was real, but it came from run 4 and had been fixed
two runs earlier. The round that actually stopped #79 was killed
mid-flight and produced no failure at all. So the retry announcement, the
post-mortem, and the babysitter's triage all inherited a failure story
about an already-closed defect, and the operator went looking for it.

Resume behaviour was never affected — `--only-failed` reads "not
complete", not "recorded failed", and only the phase gates eligibility.
The whole cost was in what humans and readers believed.

## Decision

**A slice going RUNNING clears its persisted record.** The clearing lives
in `RunJournal.trackSlice`, which is the dispatch moment in the journal's
own vocabulary and the one place every dispatch path passes through.

The **whole record** goes, not only the `error` text: the phase, the
branch it was decided on, `mergedToFeature`, and the `collidingPrefixes`
that refused a merge (ADR 0029). Every one of them is a claim about a
previous attempt's tree, and a reader shown three honest fields plus one
cleared one is being misled more carefully, not less.

Absence is the honest state, and it is not a new one. ADR 0018 already
made "no record" mean "no decided outcome" by refusing to persist
RUNNING, so removal lands the file in the state the schema already had a
meaning for. This is what makes the fix small: no new phase, no
`INTERRUPTED` enum value rippling into `--only-failed`, `afk status` and
the run summary.

### What is deliberately not cleared

`resume` bookkeeping. Its `attempts` counter is the poison-tree cap
(#36), the dispatch this clearing accompanies is about to increment it,
and resetting it would hand an unattended launcher an unlimited supply of
resumes onto a tree that has already killed two. `scope`, `migrations`
and `reviewPhase` stay for the same reason in general form: none of them
is a per-attempt outcome claim.

Also not cleared: a record for a slice **this run has already decided**.
`recordTerminal` marks the slice terminal, and a re-dispatch after that
must not wipe a record this run is entitled to.

### Best effort, and why that is the right failure mode

A failed clear warns and the slice dispatches anyway. The cost of
proceeding is the misleading record we already lived with; the cost of
refusing is a slice that will not run because of a bookkeeping write.
The first is strictly smaller.

### The reader-side half

Provenance written but never checked is decoration, so the enforcement
half ships here too.

`afk status --run <dir>` post-mortems one run directory, and folds its
events together with `.afk/state/<slug>.json` — which is **cumulative
across every run of that slug**. `foldEvents` uses a persisted record to
fill an event-stream gap, and that is right; what was wrong is doing it
silently. Given clear-on-dispatch, a record for a slice *this* run
dispatched cannot be this run's: the dispatch removed whatever was there,
and a decided outcome emits a `slice-outcome` event. So the record was
written afterwards — most often by a later run sharing the file.

`foldEvents` therefore still adopts such a record (it is the only outcome
on offer) and additionally lists it in `snapshot.outcomeMismatches`.
`afk status` renders those above `Present:`, because they qualify the
outcomes those sections read, and `--json` carries them structurally.

One exclusion, and it is not a loophole: a stop writes provisional
CANCELLED records straight to run state without a per-slice event
(#114 / ADR 0040), so on a run whose stream contains
`cancellation-requested` or `stop-requested`, cancellation-bucket records
are this run's own and are not reported. Without that exclusion the line
would fire on every interrupted run, and a warning that always fires is a
warning nobody reads.

## What this does not change

Nothing about resume eligibility: `decideResume` reads git state, never a
recorded death cause, and that is unchanged (spec #33). Nothing about
`--only-failed`, which selects on "not complete" and so keeps a cleared
slice eligible exactly as before. Nothing about the retry announcement at
run start — it reads the state file before any dispatch, so what it
prints is genuinely the previous run's record, which is now the only kind
of record it can find.

And this is a backstop, not a substitute, for writing an honest record
when a run dies: that is §3 item 4's crash records. Clear-on-dispatch
guarantees the file holds nothing misleading; item 4 makes it hold
something true. `taskkill /F`, power loss and `SIGKILL` still leave
whatever is on disk at that instant — which, after this, is silence
rather than a lie.
