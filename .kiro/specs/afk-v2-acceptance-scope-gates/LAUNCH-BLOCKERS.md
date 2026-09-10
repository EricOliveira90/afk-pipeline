# PRD 4 run status — 2026-09-08 morning

Supersedes the 2026-09-07 version of this file, which covered the three Codex
attempts only. Read this before relaunching.

## Where the run stands

**Slice 01 (#84, Gate policy reader) shipped.** Contract ACCEPT on round 1, one
generator round, clean deterministic QA, merged into
`feat-claude-code/afk-v2-acceptance-scope-gates`:

```
1028254 feat(#84): add the gate policy reader, validator and glob matcher
7fba600 feat(#84): declare this repository's own gatePolicy in afk.config.json
d7cb19b docs(#84): record the slice 01 gate policy reader handoff
        src/gate-policy.ts       335 ++++
        src/gate-policy.test.ts  353 ++++
```

**Everything else is blocked behind #195**, which is the critical path for six of
the eight slices. #195 wrote an accepted-quality contract, drew a `REVISE` with
three findings, and then died on the revision round at
`CONFIGURATION: Contract evaluator prompt exceeds inline-size budget: actual
151315 bytes, allowed 65536`.

No draft PR. Nothing merged to `main`. Nothing stranded: every non-passing slice
branch is empty, and `#84`'s work is on the feature branch.

## The blocker is an AFK defect, not a PRD problem — #196

A contract **revision round** can be structurally unreachable. Measured on #195,
`run-20260908-073124`, from `prompt-assembly` events:

| Role | Round | Assembled bytes |
|---|---|---|
| planner | 1 | 34,990 |
| evaluator-contract | 1 | 45,862 |
| planner | 2 | 58,646 |
| evaluator-contract | 2 | **151,315** |

Same slice, same contract. Round 1 fit comfortably; round 2 was 2.3× the whole
budget. A slice can therefore be blocked not by its contract's quality but by
having drawn *any* revision round.

Worse, **the overflow throws before the `prompt-assembly` event is emitted**, so
the per-artifact breakdown that would name the offending revision artifact is
never recorded. The total and the ratio are knowable; the cause is not.

Until #196 lands, the only lever is "get an ACCEPT on round 1". That worked for
#84 and is not something a babysitter can guarantee.

## Two more product defects this run exposed

- **#192** — the planner escalates `LOAD_BEARING_SILENCE` for details the
  repository already decides. Eight escalations across the night; at least two
  offered two candidates where a constraint already in the repo eliminated one
  (AFK has no runtime dependencies, so "minimatch-compatible" was never free).
- **#194** — the contract evaluator raised a **blocking** finding on a false
  premise, twice: that a `fileScope` casing mismatch could cause a false
  out-of-scope report. `normalizePath` (`src/acceptance-manifest.ts:64-71`)
  lowercases and the parser stores the normalized form (`:269`), so manifest path
  comparison is case-insensitive by construction and the predicted failure cannot
  happen.

All three are the same shape: a role reasoning from an assumption where the
codebase holds the answer.

## Decisions settled overnight — do not re-ask these

Recorded in `prd.md` (D1, D5, D6, D22, the split notes) and in
`anchors/<NN>-<slug>.md`. Fifteen in total. The load-bearing ones:

| Where | Decision |
|---|---|
| D1 | `protectedPaths` is an object of `gatePolicyPaths` + `testGlobs` arrays; `riskClasses` a flat string array; unknown members refuse the launch |
| D5 | a waiver `path` is one exact repo-relative path, never a glob |
| D6 | the glob dialect is a narrow hand-rolled subset, case-sensitive on every platform; AFK adds no runtime dependency |
| D22 | `GateDeclaration.run` for in-process gates; a **required** declaration with neither `command` nor `run` is a configuration failure, an **optional** one keeps `SKIPPED`; `GATE_EVIDENCE_VERSION` 1 → 2 |
| D22 | `evidenceArtifactId` is the repo-relative evidence path, per `candidate-gate-phase.ts:111-116` — not a sha256 |
| anchors/02 | `gatePolicy.acceptance` is `{command, args, matcher}` with a literal `{behaviorId}` placeholder required in `args` |
| anchors/05 | `gatePolicy.cost` is a hybrid: records only for `skipDetectors` and `relatedTests`; `expectedCostMs` and prerequisites stay code |
| anchors/08 | the `scope` gate runs on the final candidate before merge, **not** pre-QA, because binding ADR 0048's amendment warrant is an independent evaluator finding and a red pre-QA gate never dispatches one |
| prd.md | **every content-derived gate declares through D22's `run` seam and so depends on #195** |

## Slice 01 was split twice, and why

| Overflow | Bytes | Response |
|---|---|---|
| contract pair | 75,419 | split off #193 (feedback integrity, `GATE-SCOPE`) |
| revision-round planner | 70,398 | moved the code anchors out of the issue bodies into `anchors/*.md` |
| evaluator prompt | 68,241 | split off #195 (file-scope gate, D22 plumbing) |

The 65,536 budget was never raised. It is the same kind of ratchet as
`suite-budgets.json`, an override can only lower it (`Math.min` at
`context-envelope.ts:1103`), and raising a context-discipline limit to fit an
oversized slice is the defect rather than the fix.

Waves are now 1:#84 ✅, 2:#195, 3:#85/#86/#193, 4:#91/#132, 5:#96.

## Recommendation

**Do not relaunch before #196 is fixed.** Every remaining slice is one `REVISE`
away from the same death, and six of eight sit behind #195. The cheapest useful
fix is #196's revised point 1 — emit `prompt-assembly` before the budget check, or
attach the byte breakdown to the error — because it is a few lines and it converts
this from a guessing game into a diagnosis. Then apply the existing by-reference
pattern (`context-envelope.ts:1612`) to whichever revision artifact turns out to
carry the mass.

That work is AFK product code, outside PRD 4's file scope, and belongs to a
separate branch and PR.

## Launch mechanics worth keeping

- **The globally linked `afk-claude`/`afk-codex` is not this worktree** — it
  resolves through `PNPM_HOME` to a git-installed copy. A self-run must invoke
  `node <repo>/dist/afk-claude.js` after `pnpm build`.
- **`scripts/min-env.sh` cannot be invoked from a bare `cmd.exe`.** It resolves its
  clean shell with `type -P bash`, which on an unmodified Windows PATH finds
  `C:\Windows\System32\bash.exe` (WSL) and deadlocks with
  `get_proc_lock: Couldn't acquire sync_proc_subproc`. `.afk/launch-prd4.cmd` puts
  Git's `usr\bin` first. Worth hardening in the script — prefer `/usr/bin/bash`.
- **Widening `selectedSlices` mid-run is refused**, correctly. Archive the state
  file (`.afk/state-archive/` holds two) when a split adds a slice.
- **Retitling an issue changes its branch slug**, so preflight refuses until the
  old worktree is removed. Expected; it caught it cleanly.
- **After any spec commit, the feature branch must be reconciled** or the
  divergence guard refuses. Merge host HEAD into it from a temporary worktree so
  the primary checkout never moves.
- `claude` authenticates fine under `min-env.sh` — auth lives under
  `USERPROFILE`/`HOME`, both forwarded.
