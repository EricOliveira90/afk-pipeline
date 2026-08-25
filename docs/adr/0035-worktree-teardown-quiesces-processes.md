# Worktree teardown quiesces the processes inside the tree, and reports what it could not

**Date:** 2026-08-25

## Context

ADR 0010 established the worktree-validity invariant and left one thing
open, in its own words:

> Reworking `removeWorktree` to surface failures structurally — left as
> an architecture follow-up. […] structural error returns from
> `removeWorktree` would let the orchestrator refuse to start at all,
> which is a stronger guarantee but a bigger change.

Issue #102 is that follow-up, plus the cause underneath it. AFK spawns
agents (`invocation-runtime.ts`) and gate/QA commands
(`command-runtime.ts`) with `cwd` inside a slice worktree. On Windows a
live `cwd` is itself an open handle, so the directory cannot be deleted
while such a process runs — and neither can it while an *orphaned
descendant* runs, which is the common case: natural-exit settlement
verifies nothing about the process tree. Only kills do (ADR 0020).

Teardown then raced those handles. `removeWorktree` retried `rmSync` for
about 600ms, swallowed every failure, pruned git's admin state anyway,
and returned `void`. That is precisely the ADR 0010 partial-tree
signature — directory on disk, admin state gone — manufactured by the
cleanup path itself, and invisible to every caller. `clean-failed` and
`mergeSliceBranch` each re-derived the outcome with a post-hoc
`existsSync`; the other four call sites did not ask at all.
`recreateWorktreeFromBase` was worse than silent: it deleted the slice
branch *after* a failed removal, then failed in `createWorktree` with a
misleading "stale directory" error, having already destroyed the branch.

The first attempt at #102 raised the `rmSync` retry budget to 10s and
returned a structured result. That fixed the reporting but not the race:
retrying `rmSync` only ever *infers* handle release from a filesystem
side-effect, and it inferred it with a blocking `Atomics.wait` on the
pipeline's main loop — starving the abort listener (ADR 0003), the
wall-clock ceiling (ADR 0019), the idle watcher (ADR 0021) and the
heartbeats of every sibling lane still running an agent, for up to ten
seconds per failing slice, inside the merge mutex.

## Decision

Teardown asks the process layer, waits, and only then touches the disk.

**1. Every spawn inside a worktree is registered.**
`src/worktree-processes.ts` keeps one small record per spawned process —
`{ cwd, ChildProcess, pid }` — added at both spawn sites. Registrations
are *kept after the root exits*: an orphan holds handles the dead root
does not, and Windows never rewrites its recorded parent PID, so a BFS
from the retained root PID still finds it (ADR 0020). Records are
discarded when the worktree containing them is quiesced.

**2. `quiesceWorktree` waits, then terminates and confirms.** Phase one
lets everything AFK started inside the tree finish on its own
(`DEFAULT_QUIESCE_WAIT_MS`, 15s) — teardown is not a kill path by
intent, and a gate command still writing its report deserves to finish.
Phase two terminates whatever outlived the wait and verifies it died,
through `terminateProcessTree` for a live root and the new
`terminatePidTree` for a settled invocation whose descendants survived
it. A fired `AbortSignal` skips phase one entirely: hard-stop, not drain
(ADR 0003). The report names what was terminated and what survived;
survivors stay registered so a later attempt sees them again.

**3. `removeWorktree` is asynchronous and returns
`RemoveWorktreeResult`.** Quiesce, then `git worktree remove`, then the
on-disk delete, then `prune`. The `rmSync` retry loop stays as the
backstop for locks that are not ours to wait for (antivirus, a pending
Windows delete, a foreign process), and every exit from it is bounded:
the deadline and the abort signal are checked at the *top* of the loop,
so a directory that survives a *successful* `rmSync` is retried on the
same budget as a thrown `EBUSY` rather than spun on forever. Sleeps are
awaited timers, never `Atomics.wait` — the loop must not block.

**4. Only the git-admin steps take the merge mutex.** Callers pass
`gitAdminMutex`, and it wraps `worktree remove` and `worktree prune`
alone. Waiting out a live handle can take seconds; it must not hold the
mutex against another lane's merge.

**5. One idiom for "did teardown succeed?", one voice for the answer.**
Every call site reads `result.removed` — no more post-hoc `existsSync`.
Post-merge and post-gate teardown go through `removeWorktreeOrWarn`,
which composes the survivor warning once (`formatWorktreeSurvivorWarning`)
and lets each site supply only its own log prefix.

**6. A refused refresh is a classified, retryable condition.**
`recreateWorktreeFromBase` throws `WorktreeBusyError` (`retryable: true`)
*before* the destructive `deleteBranch`, so the branch and its committed
work survive. `wave.ts` records the slice `ERROR` — the run genuinely
cannot proceed on a partial tree — but labels the message as a retryable
infrastructure condition, so the operator is not sent hunting for a code
fault, and `isSliceComplete` already guarantees the next run retries the
slice.

## What this deliberately does not do

Post-merge teardown still records `PASS` when the directory survives.
That is the truth: the slice's work is merged, and the leftover
directory is host hygiene, not a verdict on the slice. "Rather than
proceeding on a partial tree" binds the *reuse* path, and that is
enforced where it belongs — `createWorktree`'s ADR 0010 assertion
refuses the stale directory at the next run, which the warning says
out loud.

Nor does teardown chase processes AFK never spawned. It cannot wait for
what it cannot enumerate as ours, so a foreign lock is waited out on the
`rmSync` budget and then reported by PID-less warning. Naming it beats
guessing at it.

## Consequences

- The `EBUSY` cascades from the slice-01 self-runs close at the cause:
  teardown no longer races handles it could have waited for, and the
  handles it cannot wait out are named rather than swallowed.
- Teardown costs a process-table listing or two per worktree (~100ms
  each via PowerShell CIM, per ADR 0020's measurements), and up to
  15s of waiting when something really is still running. It no longer
  costs the event loop, and it no longer costs the merge mutex.
- `removeWorktree`, `mergeSliceBranch`, `attemptMerge`,
  `recreateWorktreeFromBase`, `prepareSliceWorktree` and
  `runCleanFailed` became asynchronous. Mechanical for callers; the
  `clean-failed` CLI awaits its exit code.
- A worktree that will not go away is now three separate honest
  statements — which processes survived, how many delete attempts were
  made, and what the next run will refuse — instead of silence.
- ADR 0010's "Out of scope" item is closed. Its other two remain open.

## Verification

`src/worktree-processes.test.ts` drives the wait / terminate / sweep /
survivor / unverifiable-table paths over fabricated process tables.
`src/worktree-teardown.test.ts` mocks `node:fs` to drive the loop exits a
real filesystem will not reproduce on demand — chiefly the `rmSync` that
returns while the directory survives, which used to spin forever — plus
the abort exit and the mutex-scope assertion. `src/git.test.ts`'s
win32-gated suite covers the real thing end to end: a registered holder
waited out without a kill, a long-lived registered holder terminated and
confirmed, and a refused refresh that leaves the branch intact.
