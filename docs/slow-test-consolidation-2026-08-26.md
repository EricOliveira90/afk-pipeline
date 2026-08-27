# Slow test consolidation — 2026-08-26

Recovery plan step 7b. Goal: cut `pnpm test` wall clock without losing
coverage, by merging scenarios that reach the same fixture state onto one
spawned run.

Input profile: `docs/slow-test-profile-2026-08-26.txt` (139 tests at 2s or
more, 773s between them; serial full-suite baseline 844.4s, 745 tests).

## What changed

Each block was measured alone, before and after, back to back on the same
machine. Those paired numbers are the evidence; the full-suite total is
noisier.

| Block | Before | After | Tests |
|---|---|---|---|
| orchestrator — post-merge guardian review phase (ADR 0015) | 130.1s | 71.8s | 11 → 13 |
| orchestrator — merge-only recovery for MERGE-PENDING | 60.9s | 29.6s | 7 → 9 |
| orchestrator — events.jsonl tee (spec #26) | 40.7s | 19.3s | 6 → 11 |
| resume-integration — retried slice resume (spec #33) (whole file) | 132.6s | 88.8s | 16 → 24 |

Sum of the measured deltas: about 154s. The suite has more test cases
than before, not fewer — assertions were split across `it` cases that
inspect a shared result, so the coverage is the same or better read.

Full suite after: **10m30s**, 765 tests, all passing — 624.5s of it inside
the six `test:*` suites (fast 114.8s, orchestrator 242.3s, wave 153.6s,
resume-integration 61.5s, qa-orchestration 38.2s, clean-failed 14.1s).

Against the 844.4s baseline that is about a 25% cut, but treat that
comparison loosely: the baseline came from a previous session, and
re-measuring `orchestrator.test.ts` alone on a busy machine early in this
one gave 578.8s against 242.3s idle at the end — far more than this
session's changes can account for. The paired per-block numbers above are
the honest measurement.

## The three shapes that worked

1. **Same terminal state, different route.** Four guardian tests each
   spawned a pipeline to reach "architect favorable, PM FIX-BEFORE-SHIP,
   no PR". One fixture now reaches it once, with the infrastructure-retry
   and cheap-re-entry paths riding along.
2. **Re-entry instead of re-setup.** Every merge-only recovery test began
   by building the same MERGE-PENDING slice. One fixture is now re-entered
   four times (refused → rechecked narrowed → rechecked ordinary →
   merged), with snapshots captured between runs. The subject is a state
   machine, so repeated re-entry is also closer to what an operator does.
3. **One run, many slices.** The events tee inspected six slices of one
   artifact through seven pipelines. One wave with four slices — a failing
   lane lead, its continuing mate, a DAG-held slice, and a fourth loaded
   with all three recoverable interruptions at once — carries all of it.
   Loading one slice with three interruptions also pins something the
   separate fixtures could not: none of them changes the outcome.

## What did not work: packing slices into a wave

`wave.test.ts`'s `runWave` block was merged the same way (11 tests → 8,
four waves → one for the happy path, and the mock-driven ERROR cases
paired up). Measured twice, whole file, alternating:

| | run 1 | run 2 | mean |
|---|---|---|---|
| merged | 173.5s | 157.0s | 165.3s |
| baseline | 158.1s | 160.5s | 159.3s |

Break-even at best, and the direction flipped between runs. It was
reverted.

The reason the other blocks won and this one did not: the savings come
from removing whole *pipeline* runs, whose fixed cost is feature-branch
setup, the review phase and the pre-ship sanity gate. A *wave*'s cost is
per-slice git work — worktree add, five agent invocations, merge — and
packing slices into one wave keeps all of it while adding lane
concurrency, which this machine does not reward. Same finding as the
five-way concurrent heavy suites benchmark from earlier the same day.

## The ratchet

Merging is a one-off; the growth is continuous. Two guards:

- `suite-budgets.json` + `scripts/check-suite-budgets.mjs`, run as
  `pnpm test:budgets` at the end of `pnpm test`. Each `test:*` script
  records its own wall clock via `scripts/timed-suite.mjs`. Wall clock is
  the metric because vitest's JSON reporter times only test bodies, and
  the consolidated suites deliberately spawn in `beforeAll` — budgeting
  the reporter's number would hand out hook time for free.
- An AGENTS.md rule naming where a new assertion goes: unit test, then an
  existing spawned scenario, then a slice on an existing wave, and only
  then a new spawn.

## Not done

- Two-group concurrency (orchestrator alone vs the rest) is still
  unmeasured. Separate follow-up.
- Gate caching is PRD 4's charter (#86), not this.
- Remaining slow blocks worth a look next: `wave.test.ts`'s contract-lock
  migration prefix gate and migration lane grouping blocks, and
  orchestrator's `runPipeline lane scheduling`. Judge them by whether the
  merge removes pipeline runs, not slices.
