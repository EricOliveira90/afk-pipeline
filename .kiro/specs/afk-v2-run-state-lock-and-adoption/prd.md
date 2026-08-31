# PRD: One cross-process lock for run state, and `afk adopt` on top of it

**GH issue:** TBD (parent). Slice 02 is the existing #129.
**Parent design:** `docs/specs/afk-v2-plan.md` (SS3 item 10, `afk adopt`)
**Split from:** `.kiro/specs/afk-v2-routing-adjudication/` (PRD 2) on
2026-08-31, after `afk adopt` blocked that PRD's guardian gate in three
consecutive rounds. See PRD 2's "Slice 06 excision note".

## Problem Statement

Every run-state writer in `src/run-state.ts` is an unlocked read-modify-write.
`saveSliceState`, `saveRunState`, `saveReviewPhase`, `recordRetryDecision` and
`clearSliceStateForDispatch` each load `.afk/state/<run-slug>.json`, mutate one
field of the parsed object, and write the whole file back. ADR 0018's
Concurrency section establishes only that this cannot interleave *within one
Node process's event loop*. Nothing stops a second process — a concurrent
pipeline run, or an operator command — from writing between another writer's
read and its write, and the loser's mutation is silently discarded because the
winner rewrites the entire state object it read earlier.

That was tolerable while the pipeline was the only writer and owned the slice it
was writing. It stopped being tolerable when a command appeared that reads a
record, spends *minutes* running base gates, and then writes: `afk adopt`. PRD
2 tried to make adoption's write conditional with a compare-and-swap helper and
the sixth-round architect blocked it, because a CAS with no lock around it is
still a race.

### The blocking finding, verbatim

This is architect finding A1 from the sixth guardian round of PRD
`afk-v2-routing-adjudication`, reproduced exactly as written. It is this PRD's
problem statement.

> ### A1. The adoption state "CAS" is an unlocked read-check-write
>
> **Convention:** ADR 0055 section 11 requires adoption's state write to be a
> compare-and-swap against the record observed before verification, and states
> that a concurrent run touching the slice must make adoption refuse rather than
> win by last writer. ADR 0018's Concurrency section only establishes that a
> synchronous read-modify-write cannot interleave on one Node process's event
> loop; it does not protect this command from a separate pipeline process.
>
> **File and location:** `src/run-state.ts`,
> `saveSliceStateIfUnchanged` (lines 484-498), especially the load at line 493,
> comparison at line 495, and unconditional `writeFileSync` at line 497.
> `src/adopt-command.ts:894-968` moves the feature ref and then relies on this
> helper to report a lost state CAS.
>
> **Evidence read/run:** I read both production call sites and searched
> `src/run-state.ts` and `src/adopt-command.ts` for any file lock, mutex, atomic
> conditional replacement, or generation check spanning that sequence; none
> exists. The helper loads the file, compares one slice record, and later
> overwrites the whole state file. I also read
> `src/run-state.test.ts:518-590` and `src/adopt-command.test.ts:1447-1493`.
> The former places the competing record before the helper starts; the latter
> injects a fake `persistSliceState` that reports `{ ok: false }`. Neither test
> creates an update between the production comparison and write.
>
> Another process can therefore persist `AWAITING-ADJUDICATION` after line 495
> and before line 497. Adoption then overwrites that park with `PASS`, returns
> success, and strands the live adjudication estate. A concurrent update to any
> other slice can also be lost because the helper rewrites the full previously
> loaded state object. This is the corruption ADR 0055 section 11 says the CAS
> must make impossible.
>
> **Required before ship:** Make the state mutation genuinely cross-process
> conditional. For example, serialize every run-state writer on a shared
> inter-process lock and perform load, expected-record comparison, mutation, and
> commit while holding it; a lock used only by adoption is insufficient. An
> equivalent generation-based or transactional store is also acceptable. Add a
> deterministic test that pauses the production primitive after comparison,
> writes a competing park through another writer, then proves adoption refuses
> and rolls the feature ref back without losing either record.

Note the line and file references above describe the PRD 2 branch at the time
of the review. `saveSliceStateIfUnchanged`, `sameSliceRecord` and
`src/adopt-command.ts` were all removed from that branch by the excision, so
this PRD reintroduces adoption on top of a lock rather than repairing code in
place. The removed implementation is recoverable from git history (PRD 2's
branch `feat-codex/afk-v2-routing-adjudication`, the commits under 66596a4 plus
round-5 fixes ee82e30, 94c7877 and 8bdc0f1) and its negotiated contract and
three rounds of QA reports are preserved under `slices/02-*/` in this
directory.

## Solution

Two layers, in order — the lock must exist before adoption can be conditional
on anything.

- **A cross-process lock every run-state writer holds.** One lock per run-state
  file, acquired before the load and released after the commit, so that load →
  compare → mutate → write is atomic against any other process. Every writer
  goes through it — `saveSliceState`, `saveRunState`, `saveReviewPhase`,
  `recordRetryDecision`, `clearSliceStateForDispatch` — because the architect is
  explicit that a lock used by only one caller is insufficient. A
  generation-counter or transactional store is an acceptable alternative shape
  if it gives the same guarantee.
- **A conditional write built on that lock**, and `afk adopt` restored on top of
  it: verify the candidate merged tree with every base gate, move the feature
  ref, then write the slice record only if it is still the one adoption was
  authorized against — with the comparison and the write inside one held lock.
  Adoption's refusal list and provider-qualified run discovery are already
  designed in ADR 0053; §8 and §11 of ADR 0055 carry the estate and CAS
  reasoning. All three currently carry a "deferred to this PRD" banner.

## User Stories

1. As a maintainer, I want every run-state writer serialized on a cross-process
   lock, so that two concurrent processes cannot lose each other's mutations to
   a whole-file rewrite.
2. As a run operator, I want a state write that is conditional on the record the
   caller last observed, evaluated and committed inside one held lock, so that a
   long-running command cannot overwrite a park that appeared while it worked.
3. As a run operator, I want a finished slice branch adopted with the same
   verification the pipeline applies (`afk adopt`), so that hand-finishing a
   stuck slice never bypasses gates or state discipline.
   *(Carried across from PRD 2 as US-17; renumbered here.)*
4. As a run operator, I want adoption to refuse and roll the feature ref back
   when it loses the conditional write, so that a lost race never leaves the ref
   moved and the state stale.

## Implementation Decisions

- The lock is a decision this PRD must take, not one inherited: ADR 0018 covers
  in-process ordering only, and this is the first requirement for cross-process
  exclusion. It needs its own ADR, and that ADR must say what happens to a
  stale lock left by a killed process — AFK runs get Ctrl-C'd, and a lock that
  can wedge the next run is worse than the race it fixes.
- Adoption is reintroduced from the design in ADR 0053 and ADR 0055 §8/§11
  rather than redesigned. Those three banners come off as part of this PRD's
  definition of done, and ADR 0055 §11's "impossible" claim (already corrected
  to "narrowed, not closed") becomes true for the first time.
- `probeAdjudicationEstate`, `RunState.specsDir` and the provider-name branch
  helpers in `src/orchestrator.ts` all shipped with PRD 2 and stay. Adoption
  reuses them; `clean-failed` already does.

## Testing Decisions

- The architect names the required test shape and it is binding: pause the
  production primitive after its comparison, write a competing park through a
  *different* writer, then prove adoption refuses and rolls the feature ref back
  with neither record lost. A test that pre-places the competing record before
  the primitive starts does not prove the property — PRD 2's did exactly that
  and was rejected.
- Prove the lock across real processes, not just across two calls in one. A
  fake that serializes in-process re-tests ADR 0018 and nothing new.
- Per AGENTS.md's "where a new assertion goes" ladder, the lock's edges are unit
  tests on the run-state module. Nothing here needs a new spawned pipeline
  scenario.
- Cover the stale-lock path: a lock file left by a killed process must not wedge
  the next run.

## Out of Scope

- Changing the on-disk state schema beyond whatever the lock or a generation
  counter requires.
- Any other operator command. The lock is general, but this PRD only restores
  `afk adopt` on top of it.
- Reconciling an adjudication estate on the operator's behalf. ADR 0055's
  refusal-not-reconciliation stance holds: adoption refuses and says why.

## Further Notes

`afk adopt` is an operator bypass valve; nothing in the pipeline depends on it.
That is what made it safe to excise from PRD 2 rather than hold four verified
slices behind a persistence-layer fix. It also means this PRD is not urgent —
but the unlocked writers it fixes are shared by the whole pipeline, so the first
slice has value on its own, independent of adoption ever landing.
