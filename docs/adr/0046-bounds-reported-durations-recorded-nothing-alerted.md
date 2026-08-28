# Bounds are reported, stage durations are recorded, and nothing alerts

Extends ADR 0031 (the RunJournal owns a run's observable record) and
ADR 0017 (`run.log` + the per-run log directory). Evidence:
`docs/specs/afk-v2-plan.md` §3 item 14 and its riding stage-duration
journal event; `docs/specs/afk-v2-plan-debate.md` §2, where the per-stage
watchdog ping was cut.

## What happened

Four numbers govern what a struggling slice is still allowed to do:

- resume attempts left on its tree (`MAX_RESUME_ATTEMPTS`, `resume.ts`),
- implementation rounds left under the global cap (ADR 0014),
- contract-negotiation rounds this invocation may spend,
- infrastructure retries each invocation gets.

All four were invisible. During the recovery of slice #79 the difference
between "one resume attempt left" and "none" changed the recommendation —
and the only way to learn which it was involved opening
`.afk/state/<run-slug>.json` and reading a counter by hand, against a cap
that lives in the source. A run that announced `Retrying #4001` did not
say whether the retry was the last one.

Separately, the plan debate wanted a soft per-stage watchdog: notice that
a generator round is running far past what that stage usually takes, and
ping. Both debaters cut it. An advisory ping into an unattended run at
3 a.m. has no receiver who can act on it, and nothing in the record shows
that the 109.6-minute generator round was *doomed* rather than merely
*large* — a watchdog tuned on one data point either never fires or fires
on healthy long rounds. What survived was the observation underneath it:
nobody knows the distribution of stage durations, because nothing records
them next to each other.

## Decision

**The budgets are reported at dispatch. The durations are recorded per
invocation. Neither is allowed to act.**

### Bounds, once per dispatch

`reportSliceBounds` runs once per slice dispatch, immediately after
`prepareSliceWorktree` — after the resume decision, so the numbers are
the ones this dispatch actually runs under rather than the ones it
inherited. It writes one `run.log` line and one typed `slice-bounds`
event, both rendered by `formatSliceBounds` so the human line and
`afk status` cannot drift apart:

```
[afk] Slice #4001 (Resumable): bounds: 1/2 resume attempts left · 3/3 implementation rounds left · 2/2 contract rounds left · 2 infrastructure retries per invocation
```

`afk status` renders the same string twice: in the chronology at the
dispatch's timestamp, and indented under the slice in the Present
section, because "is it dead or just slow?" is usually followed by "and
how many tries does it have left?".

Two things keep the report honest rather than decorative:

- The implementation-round figure comes from
  `implementationRoundsRemaining`, which the Phase B round loop now calls
  too. The number the operator is told at dispatch is the number the loop
  runs on, by construction, not by two sites agreeing today.
- The rounds already spent come from `spentImplementationRounds`, the
  filename scan `loadQAReviewResumeState` uses for its `nextRound`. One
  scan, two callers, no second opinion about what a resume inherited.

It reports and nothing else. Every budget is still enforced exactly where
it was: `decideResume`, the Phase A round loop, the Phase B round loop.

### Stage durations, derived at the journal seam

`RunJournal.event` already sees every `phase-started` and `phase-ended`,
so the duration is derived there and appended as a `stage-duration` event
straight after the `phase-ended` it comes from. No invocation site
changes and none can forget. A stage whose `phase-ended` never arrives —
the run died inside it — produces no event: an unfinished stage has no
duration, and inventing one from the run's end would put a killed
generator's death into the baseline for healthy ones.

History is per *stage*, meaning the agent role with its rounds pooled
("how long does a generator round take on this PRD"), and it spans runs:
on first use the journal recovers prior samples by pairing the phase
events in the PRD's earlier `events.jsonl` files, bounded to the 20 most
recent runs. That is what makes a fresh run's *first* generator round
placeable — the invocation whose duration nobody could previously judge.
Runs that predate this feature contribute their history too, because the
pairing reads events they already wrote.

### Nothing alerts

There is no threshold, no ping, no notification, no cancellation, and no
warn event anywhere in either half. `foldEvents` deliberately does not
project `stage-duration` into any status view. The consumers are the
morning babysitter reading `events.jsonl` and PRD 5 story 17's ROI
dataset.

The watchdog may be re-proposed only through the trigger the debate
recorded for it: the journal events showing a bimodal doomed-vs-large
distribution of stage durations. At that point the proposal arrives with
Evidence 4 instead of Evidence 1 — which is the entire reason to collect
the data first.

## Consequences

`events.jsonl` gains two event types under the unchanged schema version 1
(the union was always open, per ADR 0031). Readers that switch on event
type ignore what they do not know; `afk status` renders `slice-bounds`
and skips `stage-duration`.

The bounds line costs one `appendFileSync` per dispatch. The duration
events cost one line per invocation plus, once per run, a scan of up to
20 sibling run directories — degrading to a thinner history rather than
failing when a log directory or an `events.jsonl` cannot be read.

`spentImplementationRounds` is now the single scan behind both the
dispatch report and `loadQAReviewResumeState`'s `nextRound`, so a change
to the evidence filenames moves both together.

The accepted residual: the reported contract-round figure is the
invocation's whole budget, including for a dispatch whose contract is
already LOCKED and will spend none of it. That is accurate — unspent
budget is remaining budget — but it is the one cell that does not shrink
as a slice struggles.
