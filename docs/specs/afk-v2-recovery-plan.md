# AFK v2 recovery plan — stabilize, speed up, resume the ladder

Successor plan to the PRD 1 run stoppage (runs `run-20260825-185429`,
`run-20260825-203430`). Companion to `afk-v2-ladder-runbook.md`, which
stays the master sequence for PRDs 1–6; this document is what re-enters
it safely. Evidence citations reference the two run log dirs under
`.afk/logs/afk-v2-evidence-backbone-codex/` and the timing inventory
reproduced by `C:\tmp\afk-timing.mjs`.

Organizing principle: **hand-fix what makes runs fail, hand-measure
what makes them slow, and let AFK implement its own ladder.** The
pipeline cannot be used to repair the bugs that make its runs fail;
everything else — the PRDs, and the architectural speed work — is
sliced, ticketed feature work, which is exactly what AFK is for.

## State at time of writing

- Host worktree `C:\Code\afk-v2-run` clean at `cf0fa47` (gate fix,
  unmerged to main). `main` at `fa85a10`.
- Slice #75: `ERROR`, resumable with plain `--only-failed`; branch
  holds 11 commits at `bcbfd7d`; tip has 7 failing tests in
  `src/resume-integration.test.ts` (round 2 stripped test support to
  satisfy a QA boundary finding instead of amending the contract).
- Slice #77: `ESCALATE`, awaiting adjudication
  (`.afk/artifacts/afk-v2-evidence-backbone-codex/slice-03/stuck.md`);
  gates #78 and #79.
- `feat-codex/afk-v2-evidence-backbone` stale at `b22a715` (pre-#105,
  #106, #107); slice worktrees branch from it, so agents read files
  three PRs older than the code orchestrating them.
- Measured on this machine: full `pnpm test` 711s (737 tests),
  `test:fast` 85s, heavy suites 620s serial. Roughly half of run
  elapsed time was test execution, much of it the same tests on the
  same tree.

## Phase A — stabilize the pipeline (blocking; direct work, not AFK)

1. **Ship `cf0fa47` to main.** Before opening the PR, amend two
   defects:
   - The comment claiming a prepare failure is "recorded against the
     first declaration" — the `checkpointError` path records it
     against every declaration.
   - Classification: `pnpm install --frozen-lockfile` failing from
     lockfile drift is deterministic and generator-caused; it must not
     land in INFRASTRUCTURE, where the retry re-runs the identical
     install against the identical tree (the ADR 0036 anti-pattern).
     Route lockfile-mismatch to the generator as a gate FAIL;
     reserve INFRASTRUCTURE for genuine environment failures; align
     vocabulary with the pre-ship path's CONFIGURATION kind (ADR 0012
     amendment section).
2. **Launch guard: the feature branch must contain the host worktree's
   HEAD.** `git merge-base --is-ancestor <host HEAD> <featBranch>` at
   wave launch (near `featureBranch()`, `orchestrator.ts:~2324`).
   Auto-fast-forward when the branch is a plain ancestor; refuse with
   a clear message on divergence. Keyed on host HEAD, **not main** —
   hosts run from prep branches ahead of main by design, so a
   behind-main check recreates the bug on every prep cycle.
3. **Fast-forward `feat-codex/afk-v2-evidence-backbone` to the host
   HEAD** once `cf0fa47` is on the prep chain. Not to `9579fe6`: that
   leaves the branch stale against the gate-fix code immediately.
4. **File as issues (no fix now):**
   - Stale persisted error text ("exceeded 100 tool calls") on
     runs killed mid-round.
   - The contract-amendment gap (systemic; lands in Phase D):
     QA boundary findings + a generator with no authority over the
     locked file list produced the run's most expensive failure — a
     ~90-minute round whose remedy reverted its own test support and
     broke 7 tests.

## Phase B — test-suite time, cheapest first (direct; measure each step)

Strict effort-to-payoff order. Nothing here has been benchmarked;
every step records numbers before the next is decided.

5. **AV exclusions — CLOSED, not available on this machine.**
   Investigated 2026-08-25: Defender is dormant (`WinDefend` stopped);
   the active scanner is CrowdStrike Falcon (productState 266240),
   whose exclusions are IT-managed. No local action possible. If the
   idle-machine baseline (below) plus the fixture-pilot numbers show
   scanning is still a dominant cost, file an IT exclusion request for
   `C:\Code\afk*` and `%LOCALAPPDATA%\Temp\afk-*` — do not block on
   it. Replacement action: measure one full `pnpm test` on an idle
   machine (no agent sessions running) and use that as the reference
   baseline; the original 711s was measured on a busy host.
6. **`--test-command "pnpm test:fast"` for self-runs.** Zero code —
   ADR 0038 shipped the flag; the PRD 1 run didn't use it and its
   generator r2 spent ~35 min on three full-suite runs. Write it into
   the babysit prompt template. The base gate and QA still run the
   full suite; nothing ships on the fast subset.
7. **Fixture pilot — DONE, null result (PR #110).** `wave.test.ts`
   refactored to template-repo fixtures; baseline 235.2s vs
   241.2s/227.7s after — ±7s run noise swamps any effect. Diagnosis:
   fixture construction was only ~4 git processes per test; the
   suite's cost is dominated by the git work `runWave` itself spawns
   (worktrees, merges). Consequence: do NOT ticket the rollout to the
   other heavy suites. Surviving suite-time levers, aligned with the
   diagnosis: relocating pure-function assertions off the
   spawned-pipeline seam, reducing `git worktree add` churn, and
   step 8's concurrency option.
8. **Concurrent heavy suites: deferred, conditional.** The birpc
   failure is per-process, so separate vitest processes do escape it —
   but five processes × 2 workers is the Windows process contention
   `maxWorkers: 2` exists to bound, and a flaky timeout inside a gate
   reads as a candidate failure. Revisit only if steps 5 and 7 leave
   the full suite too slow; trial as a `test` script change with one
   benchmark run before it ever runs inside a gate.
9. **No hand-built gate caching.** Tree-identity caching keyed
   `(treeId, command set)` and the related-tests split are PRD 4's
   charter (#86), and the QA-dedup half requires an ADR 0012
   amendment regardless. Goes into PRD 4's tickets (Phase D).

## Phase C — unblock and resume PRD 1 (AFK)

10. **Adjudicate #77** (`stuck.md` above). Highest fan-out: gates #78
    and #79, three of five slices.
11. **Amend #75's contract** to add `src/resume-integration.test.ts`
    to the locked file list. Without this the next round faces the
    same contract and the same finding, and repeats round 2's
    destructive revert.
12. **Refresh the prep chain** (runbook Phase 0 step 3): merge main
    (now carrying the gate fix and the guard), push, fast-forward the
    host worktree, `pnpm install`, `pnpm build`, `pnpm test:fast`,
    update the babysit prompt's verified commit.
13. **Resume:** `--only-failed` for #75 (ERROR, not STUCK — no
    `--resume-stuck`), with `--test-command "pnpm test:fast"`, one
    live run, babysitter attached.

## Phase D — the ladder continues; AFK implements the systemic work

Fold review findings into the runbook's reconcile step (ticket edits),
not side quests:

14. **PRD 4 tickets absorb the speed architecture:** gate caching
    keyed `(treeId, command set)`; QA dedup as an explicit, citable
    skip authorization (orchestrator passes gate evidence + sha into
    the QA prompt) with the amending ADR to 0012; the fixture-template
    rollout from step 7; relocation of pure-function assertions
    (verdict parsing, event shapes, declaration projection) off the
    spawned-pipeline seam into unit tests.
15. **The contract-amendment gap lands in PRD 2 or 3** (whichever owns
    finding states and adjudication in the design record): QA findings
    distinguish "amend the contract's file list" from "revert the
    change," with amendments routed through the orchestrator or
    evaluator-contract, never left to the generator.
16. **Per-PRD hygiene per the runbook stands.** Additionally: check
    `C:\Code\afk-gauntlet-run`'s feature-branch ancestry against its
    host HEAD before that run is ever resumed — it likely shares the
    staleness class.

## Standing corrections to prior analyses

Recorded so stale figures stop propagating:

- Generator r2 (run-20260825-203430) ran the full suite **three**
  times (~35.5 min), not twice; total verification ~40 min.
- QA r1 spent 12.3 min in verification and 20.4 min in agent reading —
  test-scope changes target the smaller half.
- An orchestrator-side gate cache alone recovers almost nothing on
  this run's numbers: of the three full-suite runs per round, only the
  base gate is orchestrator-executed, and a new round implies a new
  treeId. The QA saving requires the evidence-in-prompt design (step
  14).
