# Wave — 2026-09-08 triage batch

Plan of record for the 19 `ready-for-agent` issues from the 2026-09-08
triage batch. Approved 2026-09-08. Work from this file, not from the
session that produced it.

Triage decided *whether* these items happen. This document records
*when* and *how* each one rides: its vehicle, its batch gate, its branch
name, and its verification command. Execution ordering (the concurrent
tracks, the serialized pairs, #162 last) was decided at triage and is
consumed here unchanged.

Ratings are the plan's L/C/E/R scale (`afk-v2-plan.md` §3 — Leverage /
Cost, higher = costlier / Evidence / Reversibility, each 1–5). Vehicle
assignment follows §5's rule: pipeline-safety fixes and anything smaller
than one round's overhead go by hand; contract-sized feature work
attached to a named PRD's ticket set rides AFK.

---

## 1. Vehicles

| # | Vehicle | L/C/E/R | Pays first | Why |
|---|---|---|---|---|
| 207 | MANUAL WAVE | 5/2/5/4 | PRD 4 already carries it; main from next launch | Already built — see §2 |
| 206 | MANUAL WAVE | 5/1/5/5 | next rumo-app kiro run | 5-line stdin swap mirroring claude/codex; unspawnable slices today |
| 133 | MANUAL WAVE | 5/2/5/4 | PRD 5's first multi-slice lane | #113 class, destroys committed work |
| 138 | MANUAL WAVE | 4/2/4/4 | next re-entered ship gate | a gate that cannot run must refuse |
| 161 | MANUAL WAVE | 3/3/3/5 | PRD 5 launch | leftover PRD 3 follow-up; fits no PRD 5 story, so no rider home |
| 144 | MANUAL WAVE | 3/2/4/5 | next full-suite run | tests only; a run per fixture is negative ROI |
| 143 | MANUAL WAVE | 2/1/3/5 | PRD 5 pre-launch lint | one script, item 6 family, far below a round |
| 147 | MANUAL WAVE | 4/1/5/5 | next amendment refusal | `finally` + atomic archive; ADR 0055 Seam 1 invariant |
| 148 | MANUAL WAVE | 3/2/4/5 | next STUCK diagnosis | presentation/provenance only; record the verdict once |
| 140 | MANUAL WAVE | 3/1/4/5 | next park (PRD 5) | bucket move; "what needs me vs what broke" |
| 61 | MANUAL WAVE | 4/2/5/5 | every babysat run after merge | the operator's primary instrument is actively wrong |
| 164 | MANUAL WAVE | 3/2/3/5 | next reused context file | swallowed catch → recorded refusal |
| 167 | MANUAL WAVE | 4/3/4/4 | next pre-ship gate | flake on the gate that decides shipping |
| 130 | MANUAL WAVE | 3/2/4/4 | next negotiation exhaustion | classification + remedy text; keeps its chain on one vehicle |
| 131 | MANUAL WAVE | 4/3/4/4 | next wave with a cross-slice prerequisite | DAG correctness hole; chained behind #130 |
| 142 | MANUAL WAVE | 3/1/4/5 | next stale-lock park | one predicate + announcement |
| 162 | MANUAL WAVE | 3/4/4/3 | every PRD 5+ hub edit | biggest item, still manual: a broken hub extraction kills the run delivering it |
| 203 | PRD RIDER — PRD 5 | 3/3/2/5 | PRD 6/7 waves that opt in | plan §3b item 16 verbatim, flag + ADR; #132 has merged by PRD 5 launch |
| 152 | PARKED | 4/4/4/4 | PRD 7's own run | PRD parent, not implementable; ticket its slices when PRD 4 merges |

Appetite: PRD 5 carries one rider (#203) against a cap of two. PRD 7
carries none. No item in this batch launches through AFK while PRD 4
runs, so §3c policy 5's four conditions never bind — every manual item
runs in its own worktree, which policy 5 does not govern.

## 2. #207 — already built, closing condition recorded

`506afc3` (2026-09-07, branch `fix/188-defect-4-resume-charge-at-dispatch`)
already charges the resume attempt at generator dispatch. It was merged
into `integration/pre-prd4` at `c1197c6` and is an ancestor of both
`feat-claude-code/afk-v2-acceptance-scope-gates` and
`feat-codex/afk-v2-acceptance-scope-gates`, so it reaches main when
PRD 4's feature branch merges. **No manual adoption, no pre-merge.**

The closing condition is the ancestry check, not a PR title:

```bash
git merge-base --is-ancestor 506afc3 main && echo "on main"
```

`integration/pre-prd4`'s *tip* is not an ancestor of either feat branch
(it carries later spec-only commits), and PR #197 targets
`integration/pre-prd4` rather than main — which is why the check is on
the commit and not on a merge event.

## 3. Batch gates

**Batch A — startable now.** File-disjoint from PRD 4's live diff.

**Batch A′ — after PRD 4 merges.** PRD 4 is actively restructuring
`orchestrator.ts`, the gate catalog, `ship-gate.ts`, `wave.ts`'s merge
path (#132) and the `afk.json` gatePolicy shapes (`fe2628a`). Starting
these earlier buys a rebase against exactly that diff.

**Wave B — hub lanes, branched from post-PRD-4 main.** Four chains run in
parallel, serial inside each chain. Merge one branch at a time and
refresh the other chains after each merge.

**Tail — #162, solo, after every hub lane has merged.**

The parallel structure is permission, not a target: 2–3 concurrent
worktrees is the intended pace.

## 4. Schema reservations

Three lanes touch persisted shapes. Reserved the way §3c policy 5
reserves migration prefixes (ADR 0034 claims), one per lane:

- **#61 owns the sole `RunState` version bump.** Its run-ID criterion
  needs plan §3 item 11's schema half, which is *not* on main —
  `PersistedSliceState` carries no `runId` today. Fold that field in
  here.
- **#138** — review-phase record: optional field only, no version bump.
- **#140** — bucket vocabulary in the slice-lifecycle traits table:
  optional/presentation only, no version bump.

Two lanes must not bump `RunState.version` in the same wave.

## 5. Checklist

Iterate with the command listed. Then run the full `pnpm test` (~7 min)
before merging — nothing checks the suite behind you, so the definition
of done is the full suite, not `test:fast` (CLAUDE.md).

### Batch A — now

**Parked 2026-09-08: implemented, verified, not merged.** All three are
complete and committed in worktrees, held because the machine was loaded
(the #195 run) and the pre-merge full chain produced false-red budgets
(§6 note 1 — every suite moved with load, all tests pass, alone-runs
green). Resume condition: after the #195 run finishes, one quiet full
`pnpm test` per branch, then merge serially **#206 → #143 → #144**,
close each issue naming the merge commit, tick these boxes. Watch
`fast`: it ran 236.8s on pristine-main content against a 258s budget on
a loaded machine — if it straddles on a *quiet* machine, report it as a
finding (measured, `@main`-labelled block); do not raise the number.

| # | branch | commit | worktree |
|---|---|---|---|
| 206 | `fix/206-kiro-prompt-via-stdin` | `0560134` | `C:\tmp\afk-206` |
| 143 | `feat/143-lint-mixed-impasse-outcome` | `b249ce9` | `C:\tmp\afk-143` |
| 144 | `test/144-estate-audit-assertion-gaps` | `719cf69` | `C:\tmp\afk-144` |

All three branch off `2fc0379`; diffs are file-disjoint from each other,
so no cross-rebase is needed unless main moves first. `suite-budgets.json`
is untouched on all three.

- [x] **#206** kiro prompt via stdin — `fix/206-kiro-prompt-via-stdin`
      `pnpm vitest run src/kiro.test.ts src/invocation-runtime.test.ts`
      *(merged 2026-09-10 as `1e32a4b` via PR #227, rebased onto `b0b4548`
      as `d197ff3`. `kiro.test.ts` 17/17; `test:fast` 1698/1698 on its own
      run; all five heavy suites green. The one chained `pnpm test` failed
      three git tests in `git.test.ts` / `gate-runner.test.ts` on
      `fatal: not a git repository` against vanished temp repos — the same
      loaded-machine environment flake as §6 note 1, and both files pass
      108/108 alone. `test:budgets` not run: suite wall clocks ran 2-3x
      inflated under the concurrent AFK run, so it would be the same false
      red #143 recorded. Budgets untouched.)*
- [x] **#143** mixed-IMPASSE outcome lint — `feat/143-lint-mixed-impasse-outcome`
      `pnpm vitest run src/lint-tickets.test.ts && pnpm run lint:tickets`
      *(merged 2026-09-10 as `2d0f1ba`, rebased onto `b0b4548`, out of the
      #206 → #143 → #144 order because the three diffs are file-disjoint.
      Every suite green — `fast` 1710, `orchestrator` 216 — but `test:budgets`
      was red on all six suites at once (total 3399s / 1877s, `clean-failed`
      55.7s / 46s included, and this diff adds no spawned scenario): the
      loaded-machine false red of §6 note 1, not a measurement. Budgets
      untouched. One `fast` run also died on a git `index.lock` collision and
      passed on a rerun.)*
- [x] **#144** estate-audit assertion gaps — `test/144-estate-audit-assertion-gaps`
      `pnpm vitest run src/adopt-command.test.ts src/orchestrator-runs.test.ts`
      *(merged 2026-09-10 as `744b688` via PR #229, rebased twice — onto
      `b0b4548`, then onto `a54853d` after #206 and #143 landed; the diff is
      the same three files either way and `tsc --noEmit` is clean on the
      final base. The checked files above are the ones the commit actually
      touches; the planned list named `adjudication*.test.ts`, which it does
      not. Touched files 83/83, then one full `pnpm test`: every suite green,
      1698 tests in `fast` plus all five heavy suites, zero test failures.
      `test:budgets` red on five of six suites (3164.5s / 1877s) — the third
      recorded false red of §6 note 1's kind, after #206 and #143. This run
      pinned the attribution instead of asserting it: an alone-run of the
      untouched `qa-orchestration` suite took 345.0s against the 241.7s it had
      just taken inside the same chain, and nothing this repo controls makes a
      suite slower alone than in-chain. Budgets untouched, and #232 filed to
      make the check warn on host load rather than fail. The one spawned run
      this diff adds was measured directly rather than left as a claim —
      scenario-scoped and interleaved against main's version of the same
      files, 34.9s vs 27.5s by per-variant minimum, ~+7.4s, ~0.9% of the
      orchestrator suite's 842s budget. Recorded in the commit message; no
      `_measured…@<branch>` block added, since the number does not move a
      budget.)*

### Batch A′ — after PRD 4 merges

- [ ] **#133** lane successor keeps its commits — `fix/133-lane-successor-preserves-commits`
      `pnpm run test:heavy:wave`
      *(moved out of Batch A: it rebases against #132's wave.ts merge path, and its payoff is not collected before PRD 4 merges)*
- [ ] **#138** cached verdict artifact restore — `fix/138-cached-verdict-artifact-restore`
      `pnpm vitest run src/ship-gate.test.ts src/run-state.test.ts`
- [ ] **#161** stricter envelope budgets via CLI/`afk.json` — `feat/161-stricter-envelope-budgets-cli`
      `pnpm vitest run src/afk-manifest.test.ts src/cli-options.test.ts src/preflight.test.ts src/context-envelope.test.ts`

### Wave B — hub lanes, from post-PRD-4 main

Chain 1 — contract transaction / stuck diagnosis:

- [ ] **#147** accepted-pair restore on archive failure — `fix/147-accepted-pair-restore-on-archive-failure`
      `pnpm vitest run src/contract-transaction.test.ts src/artifacts.test.ts`
- [ ] **#148** refused escalation is not valid evidence — `fix/148-refused-escalation-not-valid-evidence`
      `pnpm vitest run src/escalation.test.ts src/planner-escalation.test.ts src/artifacts.test.ts`

Chain 2 — presentation / status projection:

- [ ] **#140** `AWAITING-ADJUDICATION` out of the failed bucket — `feat/140-awaiting-adjudication-presentation-bucket`
      `pnpm vitest run src/slice-lifecycle.test.ts src/status.test.ts src/status-present.test.ts`
- [ ] **#61** active retry is not a stale outcome — `fix/61-active-retry-not-stale-outcome`
      `pnpm vitest run src/run-snapshot.test.ts src/status-pipeline.test.ts src/status-web.test.ts src/run-state.test.ts`
      *(owns the `RunState` version bump + item 11's run-ID field — §4)*

Chain 3 — gate catalog / cancellation:

- [ ] **#164** explorer evidence-map as a declared gate — `feat/164-explorer-evidence-map-gate`
      `pnpm vitest run src/gate-runner.test.ts` then `pnpm run test:heavy:orchestrator`
- [ ] **#167** base-gate cancellation ordering — `fix/167-base-gate-cancellation-ordering`
      `pnpm run test:heavy:qa`, then full `pnpm test` to reproduce under load
      *(no suite budget is raised for this)*

Chain 4 — negotiation / adjudication:

- [ ] **#130** unanswerable-finding exhaustion shape — `fix/130-unanswerable-finding-exhaustion-shape`
      `pnpm vitest run src/contract-convergence.test.ts src/artifacts.test.ts`
- [ ] **#131** refuse an undeclared cross-slice prerequisite — `fix/131-refuse-undeclared-cross-slice-prerequisite`
      `pnpm vitest run src/contract-review.test.ts src/lanes.test.ts` then `pnpm run test:heavy:wave`
- [ ] **#142** missing decision log reopens the lock — `fix/142-missing-decision-log-reopens-lock`
      `pnpm vitest run src/adjudication.test.ts src/adjudication-estate.test.ts`

### Tail — solo

- [ ] **#162** extract PRD 3's hub growth — `refactor/162-extract-prd3-hub-growth`
      Re-verify the line count and extraction targets first (the brief's
      numbers are stale by design — the hub grows while this waits).
      Verify with the full `pnpm test`.

### Not in the wave

- [ ] **#203** optimistic lanes — ticket into PRD 5's set once #132 is on
      main; needs its own ADR. Parks if #132 is deferred out of PRD 4.
- [ ] **#152** PRD 7 — parked. Ticket its slices when PRD 4 merges.
- [ ] **#207** — no work. Close on the §2 ancestry check.

## 6. Standing notes

- `test:budgets` blocks a plain `pnpm test` (§3c policy 4 makes it
  advisory only in pipeline context). PRD 4's concurrent runs load the
  machine, so expect false reds during Batch A. **Do not raise a
  budget** to clear one — re-run alone, or move the assertion up
  AGENTS.md's placement ladder.
- Two items explicitly forbid a new spawned scenario (#161, #164) and
  two explicitly require extending an existing one (#133, #167). Honour
  those; they are acceptance criteria, not advice.
- Budget a prep-chain refresh as its own task whenever a merge
  restructures a file another lane touches (plan §4, per-wave
  discipline).
