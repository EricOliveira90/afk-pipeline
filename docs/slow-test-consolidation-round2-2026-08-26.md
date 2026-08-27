# Slow test consolidation, round 2 — 2026-08-26

Recovery plan step 7b, second pass. Round 1's results are in
`docs/slow-test-consolidation-2026-08-26.md`; read that first for the
consolidation shapes that worked and the one that did not.

Starting number of record: **765s** for `pnpm test`, idle machine, commit
9542cb6, 765 tests passing.

Finishing number: **415.9s** (6m56s), same machine, same 765 tests, budget
gate green. 410.5s of that is inside the six `test:*` suites. A second
full run measured 442.9s / 437.2s of suite time — see "Variance" below.

| Suite | Round 1 | Round 2 | Change |
|---|---|---|---|
| fast | 114.8s | 60.7s | −47% |
| orchestrator | 242.3s | 168.8s | −30% |
| wave | 153.6s | 97.0s | −37% |
| resume-integration | 61.5s | 39.8s | −35% |
| qa-orchestration | 38.2s | 35.4s | −7% |
| clean-failed | 14.1s | 8.8s | −38% |
| **suite total** | **624.5s** | **410.5s** | **−34%** |

## The finding: the suite was running someone else's git hooks

The session plan expected the wave lever to be "reduce `git worktree add`
churn". Profiling said otherwise. Every subprocess in `wave.test.ts` was
timed and totalled by subcommand:

```
36022ms   38 calls   948ms avg   git commit      <-- 24% of a 152s suite
17560ms   93 calls   189ms avg   git worktree add
 8061ms  173 calls    47ms avg   git rev-parse
 6309ms   32 calls   197ms avg   git merge
 5243ms  107 calls    49ms avg   git worktree list
```

A `git commit` in a one-file temp repo costing 948ms is not git working.
The cause was in the system gitconfig:

```
core.hooksPath = C:\Program Files/GitDefender/lib/git-defender/hooks
```

A corporate git wrapper had installed a hook directory machine-wide, so
every fixture commit, checkout and merge ran a third-party hook. AFK
passes `--no-verify` when it commits, which is why this was never
noticed: `--no-verify` skips `pre-commit` and `commit-msg` and nothing
else. `post-commit` fired on every commit, and `post-checkout` on every
`git worktree add`, `post-merge` on every merge.

Measured in isolation on this machine: ~750ms per commit, ~120ms per
`worktree add`. Those two calls are what the heavy suites are made of.

The fix is hermeticity, not speed. `GIT_CONFIG_NOSYSTEM=1` plus a
`GIT_CONFIG_GLOBAL` pointed at an unreadable path, both set in
`vitest.config.ts`, make every git the suite spawns — directly or through
a child — read only the fixture's own local config. Whether the suite
passes should not depend on what is installed on the host.

Paired runs, whole file, back to back:

| | before | after |
|---|---|---|
| `wave.test.ts` | 151.2s | 98.4s |
| `git.test.ts` | 89.7s | 57.0s |

This one change is essentially the whole round-2 delta. It also explains
a puzzle left over from round 1: the wave-packing merge measured
break-even because ~35% of every wave's cost was hook execution that
packing could not remove.

## Two smaller changes

**Committer identity from the environment.** Each fixture spent two `git
config` calls setting an identity no assertion reads. A git process costs
~185ms to start here regardless of what it does. `GIT_AUTHOR_*` /
`GIT_COMMITTER_*` in the vitest environment replace all 52 of them.
`git.test.ts` 57.0s → 51.5s (mean of three runs); `wave.test.ts` 98.4s →
96.4s, inside the noise floor, because wave builds one repo per test
rather than sixty.

**Shared fixtures in `git.test.ts`.** Six blocks built a fresh repo per
`it` for assertions that only add distinctly-named branches and
worktrees. One repo per block: 51.5s → 49.0s, still green under
`--sequence.shuffle`.

## Where the fixture lever stops

Sharing 14 fixtures bought 2.5s, so a warm-repo fixture is worth about
180ms — not the ~500ms a shell microbenchmark suggested. The remaining
49s of `git.test.ts` is the worktree, clone and merge work the tests
exist to exercise, spread flat: after the hook fix no test in the file
exceeds 3.6s.

So the blocks that would need their branch names rewritten to share a
repo (`resume git primitives`, `git.hasCommitsAhead`,
`git.mergeBranchIntoWorktree`, `feature-branch launch guard`) were left
alone. Twelve more fixtures is ~2s against a real ordering risk, and
those blocks move `main` or observe the absence of refs a sibling would
create — the two things that make sharing unsafe. The rule is written
into the block comments so the next reader does not have to re-derive it.

## Variance: measured alone is not measured in the chain

The first cut of the new budgets was red, and the gate was right. It set
`qa-orchestration` to 46s from a single 35.4s in-chain reading; the next
full run put the same suite at 51.8s. Run on its own three times it is
35.3 / 35.8 / 35.8s.

So there are two different numbers, and they differ by much more than the
5% per-suite noise floor round 1 recorded:

| Suite | alone (3 runs) | in-chain (2 runs) |
|---|---|---|
| qa-orchestration | 35.3 / 35.8 / 35.8 | 35.4, 51.8 |
| resume-integration | 40.8 / 41.5 / 43.1 | 39.8, 48.2 |

Measured alone a suite is stable to about 2%. The same suite inside
`pnpm test` can land 45% higher — plausibly Windows Defender working
through the temp repos the earlier suites left behind, though that was
not chased down.

`scripts/timed-suite.mjs` reads the in-chain number, so that is the one a
budget has to cover. Use paired alone-runs to *decide* whether a change
helped, which is what every measurement above does, and the in-chain
maximum to *set* the budget.

## The ratchet

`suite-budgets.json` is re-cut ~30% above the slowest observed in-chain
run, and records both rounds' numbers plus the alone-vs-in-chain gap. It
also carries a warning the numbers now need: they assume no machine-wide
git hook runs. A host that never had one was always faster and still
meets the budgets.

## Not done

- Two-group concurrency (orchestrator alone vs the rest) is still
  unmeasured, as after round 1.
- Gate caching remains PRD 4's charter (#86).
- `qa-orchestration` barely moved (−7%). It is the one heavy suite whose
  cost is not fixture git work; worth a profile of its own if 35s starts
  to matter.
