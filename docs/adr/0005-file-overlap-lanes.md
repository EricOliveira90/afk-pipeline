# File-overlap-aware lane scheduling

The orchestrator partitions each DAG wave into **lanes** so siblings
that touch the same file run serially while genuinely disjoint slices
keep their parallelism. Lanes were introduced after a real run produced
a silent semantic duplicate.

## Failure mode

Three sibling slices (no DAG dependency between them) all modified the
same file. The pipeline ran them in parallel: each spun up a worktree
branched from `featBranch` as it stood at wave start, each independently
re-applied a shared `cli.py` rename + `recipe` CLI group, each passed
its own QA in isolation. Sequential 3-way merges happily concatenated
non-overlapping line ranges, producing a file where the second slice's
edits silently shadowed the first's. The DAG never declared a
dependency because the coupling was at the file level, not the
behaviour level — and `issues.md` doesn't carry file metadata.

## Construct: lane

A **lane** is a serial chain of slices whose declared file lists
overlap (transitive closure on shared files). One wave → one or more
lanes; lanes run in parallel; **within** a lane, each slice runs to
completion and merges into `featBranch` *before* the next lane-mate
starts. So a lane successor's explorer + planner read the
predecessor-merged code rather than the stale wave-start base.

The lane partitioner is a pure function in `src/lanes.ts`:

1. Each slice begins in its own union-find component.
2. For every declared path, the *first* slice that mentions it
   becomes the path's anchor; later slices declaring the same path
   union with the anchor.
3. Slices whose `files === undefined` (planner produced no usable
   list) union with **every** other slice in the wave —
   conservative fallback, see "Limitations" below.
4. Group by component root, sort each lane by ascending slice number,
   sort lanes by their lowest slice number. Determinism is observable.

## Two-phase `runSlice`

Lane partitioning needs each slice's `contract.md`'s "Files expected
to change" — written by the planner. So the per-slice pipeline splits:

- **Phase A — `runSliceNegotiate`**: explorer + planner ↔
  evaluator-contract. Writes `contract.md`. Boundary: contract LOCKED.
- **Phase B — `runSliceExecute`**: generator ↔ evaluator-qa + commit.
  Does **not** merge — the orchestrator merges under a mutex.

A `SliceContext` value object carries the slice-scoped paths, branch
name, `invoke` closure, and rendered prompt fragments between phases.
The legacy single-call `runSlice(...)` is preserved as a thin wrapper
(`negotiate → execute`) for callers that don't need the split.

## Hybrid Phase A — and the trade-off

Phase A runs in parallel for **all** ready siblings (lane leaders +
non-leaders). The contracts feed the partitioner. Then, for each
non-leader inside a lane, Phase A runs **again** on the new base
(`recreateWorktreeFromBase` → tear down + recreate from `featBranch`'s
new tip → drop stale `context.md` / `contract.md` → re-run negotiate).

**Trade-off accepted**: a redundant negotiate phase per non-leader.
The alternative — partitioning *before* contracts exist (e.g. from
`issues.md` metadata) — was rejected because file lists in static
metadata go stale and get under-declared. The planner already does
the work of figuring out scope for its own contract. Re-running it is
the price of getting the partitioner accurate input.

Lane leaders see no extra cost: they negotiate once and run.

## Cross-lane merge contention: async mutex

Lanes run in parallel. Each lane's merges happen at the end of each
member's Phase B. Multiple lanes can finish their Phase B
simultaneously and race on the shared feat-branch checkout that
`mergeSliceBranch` uses (see `src/git.ts`'s `findWorktreeForBranch`
fast path). Two concurrent `git merge` invocations on the same
checkout race on `.git/index.lock` and may apply against an unexpected
parent.

Solution: an orchestrator-level async mutex (`makeAsyncMutex`)
around `mergeSliceBranch` *and* `removeWorktree`. Single-process
orchestrator → no need for a lockfile.

```ts
function makeAsyncMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
}
```

## Conservative undeclared rule

When a planner doesn't declare a usable file list, `readContractFiles`
returns `undefined`. The partitioner then unions that slice with every
other slice in the wave. One undeclared slice collapses the whole
wave into one lane.

**Why**: an undeclared slice could touch any file. Treating it as
disjoint risks the duplicate-merge failure mode this ADR is fixing.
Treating it as conflict-with-everything serialises potentially
unnecessary work but is provably safe. The planner prompt now offers
a structured `<unknown>` opt-out; that opt-out is honest about the
fact that the orchestrator will serialise — which is the correct
incentive for the planner to enumerate when it can.

## `LANE-CANCELLED` status

If any slice in a lane fails (STUCK / ESCALATE / ERROR / CONFLICT),
the remaining lane-mates are marked **LANE-CANCELLED** and the lane
stops. Other lanes continue. Rationale: a successor would either
re-derive the predecessor's missing work (the original duplicate-code
bug) or build on top of code that isn't there.

`LANE-CANCELLED` is a distinct status, not a re-use of `CANCELLED`:

- `CANCELLED` is user-initiated (SIGINT) — see ADR 0003.
- `LANE-CANCELLED` is auto-deferred — the orchestrator chose not to
  attempt the slice yet because its lane predecessor needs human
  attention first.

Resume semantics: lane-cancelled slices are tracked in a separate
in-memory `laneCancelled` set (not `failed`). They're filtered out of
`dag.ready` for the rest of the current run — the whole point of the
status is that the predecessor needs human attention before the
successor should run again. On a fresh pipeline invocation,
`laneCancelled` starts empty; the persisted state has
`mergedToFeature: false` so the slice isn't in `completed` either.
`dag.ready(completed)` returns it and the orchestrator re-evaluates it
naturally — once the human has fixed the predecessor.

## Limitations

- **Exact-path overlap only.** Two slices that both touch *anything*
  under `src/auth/` but no specific shared file look disjoint to the
  partitioner.
- **No glob expansion.** A planner that declares `src/auth/*.ts`
  doesn't union with sibling slices that declare specific files in
  that directory. The path is treated as a literal string.
- **Case-insensitive comparison.** `src/Cli.py` and `src/cli.py` are
  considered the same file — Windows + git-on-Windows are
  case-insensitive, and we'd rather over-merge than miss a real
  overlap.
- **Trust the planner.** A planner that lies about its file list (or
  forgets a file) won't be caught here; it'll be caught later by the
  evaluator or by a real merge conflict.

## Considered alternatives

- **Always-serialise siblings** — eliminates the failure mode but kills
  parallelism. Disjoint slices pay the same cost as overlapping ones.
- **File metadata in `issues.md`** — the static list goes stale the
  moment the codebase changes; planners under-declare in pre-filled
  tables. The planner already discovers scope; the contract is the
  freshest source of truth.
- **Detect duplicates after merge by re-running QA on `featBranch`** —
  reactive: by the time the duplicate is on disk, the slice
  artifacts have all said PASS. Recovering means re-running the
  whole tail of the pipeline. Better to prevent than detect.
- **Single feature-branch worktree, sequential everything** — kills
  parallelism for genuinely independent work. The whole reason the
  pipeline runs slices in parallel is throughput on long planner +
  generator invocations.
