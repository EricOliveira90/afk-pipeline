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

**Superseded by "Run 3 evidence" below** (run `run-20260826-105721`,
harvested 2026-08-26). Every bullet in this section describes the world
before Phase A shipped; #75 is now merged, the feature branch is fresh,
and the guard and gate-prepare step are in the code. Kept as the
starting point the plan was written against, not as current state.

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
7b. **Heavy-suite diagnosis session — DONE (two sessions, 2026-08-26).**
   Fresh idle baseline 844.4s (857s reference confirmed). Round 1:
   consolidation (one spawned pipeline per describe block) took it to
   765s; both anti-compounding guards shipped (`suite-budgets.json`
   gate at the end of `pnpm test`, AGENTS.md assertion-placement
   rule). Round 2 found the real wave cost: the machine-wide
   git-defender `core.hooksPath` ran `post-commit`/`post-checkout`
   hooks on every fixture git call (~750ms per commit). Hermetic git
   (`GIT_CONFIG_NOSYSTEM=1` + unreadable `GIT_CONFIG_GLOBAL` in
   vitest.config.ts) plus env-based committer identity and shared
   git.test.ts fixtures landed the suite at **421s**. This also
   explains step 7's null result: hook cost swamped fixture cost.
   Write-ups: afk repo, `docs/slow-test-consolidation-2026-08-26.md`
   and `docs/slow-test-consolidation-round2-2026-08-26.md`.
   Discovery beyond tests: real AFK runs pay the same hook tax —
   `--no-verify` skips only `pre-commit`/`commit-msg`, so
   `post-commit` fires on every slice commit and `post-checkout` on
   every worktree add. Known pipeline overhead, quantified; not
   bypassed in production (git-defender is credential safety on real
   repos).
8. **Concurrent heavy suites: five-way REJECTED (benchmarked
   2026-08-26).** Three runs against the 844.4s serial baseline:
   584/706/798s (gains shrank 31% → 5.5%) with one hard flake (qa
   kill-timing assertion). Two-group concurrency (orchestrator alone
   vs the rest) remains unmeasured and is only worth revisiting if
   421s is still too slow; same trial protocol as before.
9. **No hand-built gate caching.** Tree-identity caching keyed
   `(treeId, command set)` and the related-tests split are PRD 4's
   charter (#86), and the QA-dedup half requires an ADR 0012
   amendment regardless. Goes into PRD 4's tickets (Phase D).

## Phase C — unblock and resume PRD 1 (AFK)

10. **Adjudicate #77** (`stuck.md` above). Highest fan-out: gates #78
    and #79, three of five slices. **Still open after run 3.** The
    operator's type-strictness amendment landed on the issue but was
    never exercised: #77 died on EBUSY worktree teardown before its
    explorer ran, so it did not negotiate. Now doubly blocked — the
    held `…-s03` directory handle must clear first.
    **DONE 2026-08-27, by hand (session S4), not by AFK.** The held
    handle never cleared on its own, so the slice was rebuilt in a
    fresh worktree (`C:\Code\afk-s4`) on the same slice branch,
    fast-forwarded to the feature tip. Merged at `d86b8f6`; run state
    `"77"` set to PASS. The amendment was consumed as written, and the
    slice shipped a duplicate-JSON-key scanner because `JSON.parse`
    keeps the last of a repeated key — "two verdicts" is only
    detectable by scanning the bytes.
11. **Amend #75's contract** to add `src/resume-integration.test.ts`
    to the locked file list. Without this the next round faces the
    same contract and the same finding, and repeats round 2's
    destructive revert. **DONE, and it worked** — run 3 skipped
    negotiation entirely and both QA rounds reported boundary
    compliance PASS. #75 merged at `1540c9b`.
12. **Refresh the prep chain** (runbook Phase 0 step 3): merge main
    (now carrying the gate fix and the guard), push, fast-forward the
    host worktree, `pnpm install`, `pnpm build`, `pnpm test:fast`,
    update the babysit prompt's verified commit.
    **DONE 2026-08-27, and it was not a step — it was hours.** Merging
    main into the host branch was clean; merging the host branch into
    the feature branch produced **seven conflicting files**, because
    main had split the orchestrator/wave/resume suites into
    fixtures-plus-two-file pairs while #76 and #77 edited the old
    monoliths. Resolution adopted main's structure and ported the slice
    work into it: version-2 manifests and contract-review stubs into
    the shared fixture providers, the reworked describes replaced from
    the feature side, and #77's new describe transplanted verbatim
    (main had moved those describes unchanged, which is what made a
    wholesale transplant safe). Merge `d5b07a6`; `tsc` clean; full
    suite 883 passed. **Every future refresh should budget for this
    class of conflict rather than assuming a fast-forward** — the
    trigger is main restructuring a file a slice branch is editing.
13. **Resume:** `--only-failed` for #75 (ERROR, not STUCK — no
    `--resume-stuck`), with `--test-command "pnpm test:fast"`, one
    live run, babysitter attached. **DONE as run 3**, with the compound
    form `"pnpm test:fast && pnpm run test:heavy:resume"`. #75 merged;
    #76 and #77 did not finish. Before the next resume, clear the four
    blocking items at the end of "Run 3 evidence" — #76's missing state
    entry is the issue-#113 setup all over again.
    **Superseded by runs 4–6** (see "Runs 4–6 evidence" below). All
    four blocking items were cleared, and the launch command grew a
    `pnpm typecheck &&` prefix that runs 4–6 proved necessary.

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

## Run 3 evidence — `run-20260826-105721`, harvested 2026-08-26

Source: `.afk/artifacts/afk-v2-evidence-backbone-codex/stop-harvest-20260826/`
(`report.md` plus `04-command-inventory*`, `05-gates-warns-events.txt`,
`06-qa-verification-vs-reading.txt`, `07-slice-77-blocker.md`,
`08-slice-75-arc.md`, `09-run-totals.txt`). Launch:

```
node dist/afk-codex.js --prd-dir .kiro/specs/afk-v2-evidence-backbone --only-failed \
  --test-command "pnpm test:fast && pnpm run test:heavy:resume"
```

4 h 38 min, stopped by operator SIGINT. #75 PASS and merged (`1540c9b`),
#76 unfinished mid-generator, #77 dead on INFRASTRUCTURE, #78/#79 never
dispatched.

### The compound `--test-command` holds; the "22 full suites" figure was wrong

The comparison the flag was justified on stands, at a smaller
magnitude. **Prior worst round = 3 real full-suite starts; this run = 0
inside every generator round.**

| Round | Real full-suite starts |
|---|---|
| `run-20260825-203430` 01-generator-r2 (prior worst) | **3** |
| `run-20260826-105721` 01-generator-r1 / r2 / 02-generator-r1 | **0 / 0 / 0** |

The 22 came from counting every occurrence of the string `pnpm test`
anywhere in the log — agent prose, echoed output, and `package.json`
reads included. `04-command-inventory.mjs` counts only
`item.started` events whose `item.type === "command_execution"`, i.e.
commands the provider actually launched:

```js
if (!it || it.type !== "command_execution") continue;
if (e.type === "item.started") { cmds++; ... }
```

That method is sound, and re-derived independently against the raw
codex JSON streams: naive string matching returns 23 hits in
`slice-01-generator-r2.log` and 22 in `slice-01-evaluator-qa-r11.log`,
while `item.started` command starts return 3 and 1. The 22 was a
count of *mentions* in a QA log, attributed to a generator round.
Two residual blind spots, both checked and clear on these runs:

- Longest-key-first matching attributes each compound run to
  `test:heavy:resume` (77 s) alone, so generator verification cost is
  understated by ~85 s per compound run. Counts are unaffected;
  only the modelled minutes are.
- A full suite launched as bare `vitest run` would not match any COST
  key. Grepping every `item.started` command in both runs for
  `vitest run` with no path argument returns nothing, so no full suite
  escaped the count this way.

**Verdict: the compound `--test-command` is confirmed and stays.** Run
verification total fell from ~65 min to ~31 min, and the one full suite
this run ran inside `evaluator-qa` r1, where it belongs. The generator
used the compound command as given (twice in r1, twice in r2) and its
own additions (`test:heavy:orchestrator`, `test:heavy:wave`) were
targeted suites, not the full set.

### What blocks #77: the same falsifiability gap — CONFIRMED

#77 never negotiated this run. It died at worktree refresh, before its
explorer started, on `EBUSY … rmdir` against
`.afk/worktrees/afk-codex-afk-v2-evidence-backbone-s03` after 30
removal attempts — classified INFRASTRUCTURE, 0 commits, branch
identical to `adbbbd6`. **The operator's issue-#77 amendment was
therefore never exercised**, and the newest negotiation evidence is
still round 4 of `run-20260825-185429`.

The gap is the same one, not a new one. `feedback-r4.md` (VERDICT
REVISE, GAPS 1, RE_RAISED_GAPS 0):

> Test plan: "fixtures for ... empty/duplicate `behaviorIds`" does not
> falsify the In scope requirement that "`behaviorIds` is a non-empty
> unique-string array, and all other strings are non-empty." A parser
> that accepts `behaviorIds: [1]` or a numeric `id`, `evidence`,
> `expected`, `observed`, or `clearCondition` can pass every named
> fixture. This violates falsifiability; add valid-JSON fixtures with
> non-string `behaviorIds` elements and non-string required string
> fields and assert rejection.

The operator's added acceptance criterion targets exactly those two
classes, field for field:

> Valid JSON that violates field types fails closed: a non-string
> element in `behaviorIds` (e.g. `[1]`, `["a", 2]`), or a non-string
> value in any required string field (`id`, `evidence`, `expected`,
> `observed`, `clearCondition`), is rejected as malformed — with a
> fixture asserting rejection for each case.

**What a planner would have needed in the issue** — this feeds the
PRD 3 prompt work:

1. **One rejection case per conjunct of a compound predicate.** The
   In-scope line packed cardinality, uniqueness, and type into one
   sentence: "`behaviorIds` is a non-empty unique-string array." The
   planner's test plan covered the two conjuncts with named example
   shapes (empty, duplicate) and dropped the one with none
   (non-string). The evaluator checks falsifiability conjunct by
   conjunct, so a paraphrase of a compound sentence loses on the
   conjunct that has no example.
2. **Concrete counterexample values in the issue.** `[1]` and
   `["a", 2]` make the fixture copyable. Without them the planner has
   to invent the violating value, and it invented none.
3. **The field list enumerated, not summarized.** "all other strings
   are non-empty" gave the planner no per-field obligation; the
   amendment's explicit five (`id`, `evidence`, `expected`, `observed`,
   `clearCondition`) does.
4. **The per-case fixture obligation stated in the issue, not
   inferred.** "with a fixture asserting rejection for each case" is
   the falsifiability rule written into the acceptance criterion,
   rather than left for the evaluator to enforce after the fact.

Note what this cost: by round 4 the evaluator's gap text was already a
near-complete test-plan specification, and the planner never got a
round to consume it — the cap plus its one extension were spent. The
loss was rounds, not information. That is direct evidence for the
plan's approach of amending the source issue over granting more
negotiation rounds.

### PR #108, PR #109, ADR 0037

**PR #108 (gate prepare step) — happy path confirmed, failure route
untested.** The prepare step ran inside the candidate checkpoint on
both #75 rounds and QA r1 separately ran
`pnpm install --frozen-lockfile` to exit zero. No gate returned `FAIL`
this run, so PR #108's `FAIL/CONFIGURATION` lockfile-drift route —
the Phase A step 1 amendment, the part that keeps deterministic
install failures out of INFRASTRUCTURE — **was never exercised**. It
remains a design claim, not a measured one.

**PR #109 (launch guard) — confirmed in both directions.** It fired in
the earlier aborted run:

```
run-20260826-014122 | 04:41:22.892Z | feat-codex/afk-v2-evidence-backbone
                      fast-forwarded from b22a715… to host HEAD adbbbd6…
```

and correctly emitted nothing in `run-20260826-105721`, because by then
the branch already contained host HEAD. Both the act-on-stale and the
stay-silent-when-fresh cases are now observed. The `diverged` refusal
path never triggered and stays unexercised.

**ADR 0037 (idle-deferral scoping) — confirmed.** All 10
`idle-deferral` warnings name `generator` (three on #75, seven on
#76). No `explorer`, `planner`, or `evaluator-contract` warning
appeared, which is what the ADR requires; a warning from one of those
roles would have been a scoping failure. Also relevant: no
`INFRASTRUCTURE` classification and no retry event exists in this
run's `events.jsonl` — the only warn reasons are `prior-run-state` (2)
and `idle-deferral` (10). #77's EBUSY death was terminal for the
slice, not retried.

### Base gates still pay the pre-hermetic-git suite cost

Measured this run, with the PR #108 prepare step in place:

| Round | typecheck | lint | tests | total |
|---|---|---|---|---|
| r1 | PASS 3.3 s | SKIPPED | PASS 853.1 s | 14.3 min |
| r2 | PASS 3.8 s | SKIPPED | PASS 752.5 s | 12.6 min |

Base-gate wall-clock across the run: 26.9 min. **Step 7b's 421s suite
has not reached any AFK run yet** — neither `adbbbd6` nor the merge
`1540c9b` carries the `GIT_CONFIG_NOSYSTEM` change in
`vitest.config.ts`, so these are pre-hermetic-git numbers, consistent
with the 711–857s band. Falsifiable prediction for the next run: base
gates should drop from ~13 min to ~7 min per round once the prep chain
carries the hermetic-git commit. If they do not, 421s does not
reproduce under a gate and step 7b needs re-measuring.

### QA reading, not test execution, is now the cost centre

| QA invocation | wall-clock | verification | reading | reading share |
|---|---|---|---|---|
| #75 r1 (IMPLEMENTATION) | 35.1 min | 12.4 min | 22.7 min | 65% |
| #75 r2 (PASS) | 30.9 min | 0.6 min | 30.3 min | **98%** |

QA r2 ran only `pnpm install --frozen-lockfile` and `pnpm run
typecheck` — 34 s of commands — and passed the slice on the
orchestrator-owned base gate's evidence. That is the intended design
and it removed a duplicate ~12-min full suite. It also means a single
QA invocation can now cost half an hour of pure reading, which no
test-command flag addresses. **Scheduler and cost work should now
target QA reading, not suite selection.**

### Newly established, for the plan's own steps

1. **Step 11 worked, and generalizes.** Hand-amending #75's locked
   `contract.md` in the slice worktree, leaving `**Status:** LOCKED`,
   made the run skip negotiation entirely: no explorer, planner, or
   evaluator-contract invocation for #75, straight into a generator
   resume round, and **boundary compliance PASS in both QA rounds**.
   The lock gate did not refuse the hand-amended contract. This is a
   supported recovery move; document it as one.
2. **Issue #113 has a second victim class: untracked slice
   artifacts.** When the resume-attempt cap force-restarts a slice, the
   branch reset is recoverable from a dangling commit, but
   `contract.md`, `context.md`, `feedback-r*.md`, and `qa-report*.md`
   live only in the worktree and are unrecoverable. #75 lost an
   operator-amended LOCKED contract this way. The fix should archive
   the slice artifact dir before any from-base restart, the way the
   ESCALATE/STUCK path already does. All 11 commits under
   `rescue/75-bcbfd7d-11-commits` were verified individually as
   ancestors of `1540c9b` — no code was lost, only artifacts.
3. **A killed run leaks a directory handle that blocks a later
   slice.** Both hard kills left a `codex.exe` descendant holding a
   slice worktree as its working directory (prime suspect PID 35100,
   `codex.exe __otel-server`). PR #104 made teardown fail cleanly
   instead of corrupting state, but the leak blocks the slice on every
   subsequent run until the process dies or the machine restarts.
   **Until it clears, #77 cannot run under AFK at all** — it fails at
   worktree refresh before any agent starts. Wanted: a post-cancel
   sweep that terminates the descendant process tree, or a documented
   "restart to clear" step.
4. **CTRL_C into a detached run is unreliable.** `AttachConsole` plus
   `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` against the node PID
   reported success twice while the orchestrator kept running. Only the
   third attempt, aimed at the parent `cmd.exe` console group with
   CTRL_BREAK, delivered it — and the orchestrator then exited without
   writing a cancellation record, leaving #76 unrecorded in run state.
   A sentinel file the orchestrator polls, or a `--stop` subcommand,
   would remove this class of problem.
5. **Accepted debt shipped into the feature branch.** QA r2 passed #75
   with one open Minor finding: `src/acceptance-manifest.ts:156-157`
   places its Node imports after all interfaces and functions. #76's
   contract also touches that file, so the manual #76 work is the cheap
   place to fix it.

### Blocking before any relaunch on this PRD — #76 is the issue-#113 setup

#76 is being finished outside AFK. Its branch holds **5 unmerged
commits** at `c58a93b`, and run state has **no entry** for it, so
`isSliceComplete` is false. A future `--only-failed` on this PRD
therefore selects #76, finds unmerged commits, and once
`resume.attempts` reaches 2 the resume-attempt cap converts the resume
into a from-base restart that force-resets the branch and deletes the
untracked slice artifacts. In order:

1. Merge #76's manual work into `feat-codex/afk-v2-evidence-backbone`.
2. Write `"76": { "phase": "PASS", "branch": "<slice branch>",
   "mergedToFeature": true }` into
   `.afk/state/afk-v2-evidence-backbone-codex.json`.
3. Do the same for #77 once its manual work lands — otherwise #78 and
   #79 stay blocked, because dependency satisfaction reads run state,
   not the branch.
4. Clear the held `…-s03` worktree handle (machine restart) before #77
   is asked to run under AFK.

Keep `rescue/76-c58a93b` until #76 merges.

## Runs 4–6 evidence — 2026-08-27, and the wave plan's current state

Written while run 6's relaunch is live, so the evidence survives the
session. Runs 4, 5 and 6 all targeted #78/#79. Each died of a different
systemic cause, and none of the three was a code defect in the slice
being built.

### Where PRD 1 actually stands

| Slice | State |
|---|---|
| #75 | PASS, merged (`1540c9b`) |
| #76 | PASS, merged (`ab18bc2`) — finished by hand |
| #77 | PASS, merged (`d86b8f6`) — implemented by hand |
| #78 | PASS, merged (`2b8eaa6`) — by AFK, after one aborted run |
| #79 | Work complete on its branch (12 commits), QA verdict outstanding |

Run state records 75–78 PASS. #79's persisted `error` text is **stale
and wrong** — see the crash finding below. The wave plan's Wave 1,
Gate 1, Wave 2 and Gate 2 are all closed; the remaining path is
`#79 → S5 (assemble PRD 1) → reliability wave`. Note the old plan's
critical path named an "S6" that was never defined; it does not exist.

**Gate 2's trust call resolved in favour of relaunching.** All three
conditions held: #113 merged, #114 merged, and 0 real full-suite starts
inside generator rounds. That last one held in every subsequent run —
the compound `--test-command` is now proven across four runs, not one.

### Three run-ending causes, in order

1. **Run 4: the budget gate tripped on wall-clock variance and became a
   blocking QA finding.** `fast` measured 87.5s → 105.1s → 130.5s across
   two base gates and QA's own run, against an 84.8s idle baseline and a
   110s budget, with **zero failing tests** in all three. QA was literally
   correct — the contract required `pnpm test:fast` to exit successfully —
   but no code change could clear it, and the generator's only escape
   would have been editing the ratchet from inside a slice. The run was
   stopped and the budgets raised by the operator instead.
   **Standing decision: during an AFK run the resident agents *are* the
   environment, so a budget must cover the loaded in-chain number, not
   the idle one.** Raises to date: `fast` 110→170 (`4d18ef7`),
   `orchestrator` 500→560 (`1022dcc`), each with measurements recorded in
   `suite-budgets.json`. Deserves an ADR so it is not rediscovered a
   fourth time.
2. **Run 5: a compile error in the candidate was misclassified as
   INFRASTRUCTURE and killed the slice.** #79's generator emitted a warn
   reason it never added to the union in `src/run-events.ts` (three
   `TS2820`). Because `package.json`'s `prepare` script is
   `tsc -p tsconfig.build.json`, the error surfaced inside
   `pnpm install --frozen-lockfile` during gate *environment
   preparation* — and `gate-runner.ts` only treats a prepare failure as
   the candidate's fault when it matches `ERR_PNPM_OUTDATED_LOCKFILE`.
   Everything else becomes INFRASTRUCTURE, so it burned both retries on
   byte-identical attempts and ended the slice ERROR with two of three
   generator rounds unused. Filed as **#120**. This is also the first
   real exercise of PR #108's `FAIL/CONFIGURATION` route, which run 3's
   harvest had flagged as an untested design claim: exercised, it went
   the wrong way.
   **Root cause of the miss, though, is the launch flag, not the gate:**
   the verification command contained only vitest suites, and **vitest
   strips types without checking them**, so the generator drove its loop
   to green (845 tests) over code that does not compile. #78's generator
   ran `pnpm typecheck` by its own choice; #79's did not, and nothing
   required it. Every launch now uses
   `--test-command "pnpm typecheck && pnpm test:fast && pnpm run test:heavy:resume"`.
   **`AGENTS.md`'s self-run guidance still prescribes the typecheck-less
   form and needs updating.**
3. **Run 6: an ENOSPC crash bypassed cancellation bookkeeping.** The
   machine filled mid-QA; an unhandled `error` event on a WriteStream
   terminated the process. #114's fix hangs off the `AbortSignal`, so
   nothing was recorded, and run state still names the *previous* run's
   typecheck failure for #79 — a failure already fixed, in a run two
   attempts stale. Filed as **#121**. The slice branch was unharmed.
   **The disk cause was misdiagnosed twice and the correction matters:**
   `%TEMP%` held 467 `afk-*` fixture directories, which looked like a
   leak, but measured **0.02 GB in total** — empty directory shells left
   by teardown's `Directory not empty` path on Windows. The whole repo
   including `.afk` is 0.16 GB. **There is no pipeline space leak**; the
   machine was full for unrelated reasons. Recorded so nobody re-chases
   it.

### What the runs proved works

- The compound `--test-command`: 0 full-suite starts inside any
  generator round, across every run since run 3.
- Resume: "resumed from 9 commit(s)", explorer and negotiation skipped
  on a LOCKED contract, base refresh merging the feature branch in.
- The #113 and #114 fixes, both live-exercised. A Ctrl-Break stop wrote
  CANCELLED records within 2.4s for the in-flight slice *and* the
  never-dispatched dependent, and no restart destroyed anything.
- The raised budgets: run 6's base gate came in at 798s/1287s total with
  `orchestrator` at 361.9/560 — green with headroom.

### Hand-finishing is a supported recovery move, not an exception

Used successfully four times now (#76, #77, and twice to unblock #79).
The procedure: work the slice branch in a fresh worktree, verify with
the full suite, merge into the feature branch, then set the slice's run
state to `{ "phase": "PASS", "branch": "<slice branch>",
"mergedToFeature": true }` so `--only-failed` stops selecting it and
`priorCompleted` unblocks its dependents. `isSliceComplete` is exactly
`phase === "PASS" && mergedToFeature === true`
(`src/run-state.ts:416`); `branch` is optional but omitting it makes the
restore path fall back to a derived name.

### The reliability issue family — proposed next wave

#111, #112, #120, #121 are one class: **the pipeline records or
classifies something that misleads the next actor.** Four of the five in
this family (counting merged #113/#114) were found by running AFK on
itself. Recommended after PRD 1 closes, as parallel manual sessions on
separate worktrees — pipeline-safety fixes are precisely the changes not
to depend on the pipeline to deliver.

One design tension to settle *before* ticketing #120: inverting the
classification default (candidate's fault unless a known environment
signature) means a transient network failure during install would be
blamed on the generator and burn a round, where today it correctly
retries. The narrower alternative — treat a non-zero exit from a
lifecycle script as candidate-owned, keyed on exit code rather than
message text — sidesteps the tradeoff. Grill this, don't implement it
naively.

### Two stale plan items corrected

- **S8's scope is superseded.** It was scoped to diagnose heavy-suite
  time; PR #115's two-file splits, hermetic git and the budget gate
  already landed that before Wave 1. The live cost question is
  different: the feature branch's heavy suites cost roughly **2× main's**
  (820s vs 428s in-chain) because #76 gave every fixture repo a sanity
  script, so pipeline scenarios now run real gates. That is an honest
  tradeoff — real gates for per-scenario cost — not a regression, and it
  is the thing worth measuring. Re-scope S8 to it.
- **Every gate estimate in the wave plan was low by roughly an order of
  magnitude,** and the cause was consistent: each gate grew prep-chain
  and conflict work the plan treated as a step. Budget refreshes as
  their own task.

## Standing corrections to prior analyses

Recorded so stale figures stop propagating:

- The **"22 full suites in one round" figure is withdrawn.** The real
  number for the prior worst round is **3**, verified from
  `item.started` `command_execution` events. See "Run 3 evidence"
  above for the method and the independent re-derivation.
- Generator r2 (run-20260825-203430) ran the full suite **three**
  times (~35.5 min), not twice; total verification ~40 min.
- QA r1 spent 12.3 min in verification and 20.4 min in agent reading —
  test-scope changes target the smaller half.
- An orchestrator-side gate cache alone recovers almost nothing on
  this run's numbers: of the three full-suite runs per round, only the
  base gate is orchestrator-executed, and a new round implies a new
  treeId. The QA saving requires the evidence-in-prompt design (step
  14).
