# PRD 4 launch blockers — slice 01 needs an authoring pass

**Written 2026-09-08 after three consecutive launch attempts.** Read this
before relaunching `.kiro/specs/afk-v2-acceptance-scope-gates`.

## Outcome of the three attempts

Every attempt died the same way: slice 01 (#84) reached `planning (round 1/2)`,
the planner wrote `planner-escalation.md` with criterion `LOAD_BEARING_SILENCE`
instead of a contract, the slice landed `ESCALATE`, and all five siblings went
`NOT-RUN` behind it. **No contract locked, no code written, nothing merged.** The
slice branch `afk-codex/afk-v2-acceptance-scope-gates-slice-01-file-scope-gate`
is empty; AFK restarted it from base each time and archived the prior attempt to
`.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/pre-restart-N`.

| Run | Base | Escalated on | Explorer | Planner | Total | Planner tool calls | input_tokens |
|---|---|---|---|---|---|---|---|
| `run-20260907-223720` | `c58e9e2` | D1's `gatePolicy` JSON shapes | 154s | 56s | 209s | 35 | 1,020,172 |
| `run-20260907-225023` | `fe2628a` | D5's waiver `path` matching | 206s | 57s | 263s | 34 | 1,372,267 |
| `run-20260907-231823` | `3cbf09c` | D6's `testGlobs` matcher dialect | 268s | 53s | 321s | 24 | 690,094 |

Cost of the three: ~13 minutes of pipeline wall-clock, ~3.1M input tokens, and
three operator decision round-trips. No lane partitioning, no generator dispatch,
no merges, so there is no throughput or test-cost evidence to report — the run
never reached a writing round.

Note the explorer cost climbing (154s → 206s → 268s) as `prd.md` grew.

## Why this is an authoring problem, not a run problem

`prd.md`'s opening claim is that it "exists for one reason: **to leave the planner
no load-bearing decision to discover.**" For slice 01 that is not yet true. Three
escalations were raised by the planner. Two more were found by an operator read
pass — and both came from reading the code slice 01 must extend, not from reading
the PRD:

- `src/gate-runner.ts:417` treats a `GateDeclaration` with no `command` as
  `SKIPPED` ("Optional gate has no command"), so the in-process scope gate D2
  specifies **cannot exist** as a declared gate today.
- `GateResult` carries only `detail?: string`. There is nowhere to put the
  violation path list #84 requires as "structured evidence", nor the four waiver
  fields D5 requires in gate evidence.
- `GateEvidenceArtifact` has `evidencePath` and `evidenceSha256` and **no id
  field**, so D12's `gateEvidence.evidenceArtifactId` had no referent.
- `RunState` is `version: 3`, a persisted schema, so the "waiver record" the
  file-scope map assigns slice 01 is a schema bump the PRD never mentions.
- `package.json` has **no `dependencies` key at all**. Neither glob option the
  planner offered acknowledged that "minimatch-compatible" means AFK's first
  runtime dependency.

The pattern: `prd.md` was written against the *plan* and the *ADRs*, and
validated against the integration branch for **file paths** (the file-scope map
says so), but not against the **type signatures and persisted schema versions**
of the modules slice 01 extends. That is where every remaining silence lives.

## Decisions already recorded (do not re-ask these)

Seven decisions were settled by the operator across the three cycles and are
committed to `prd.md`:

| # | Where | Decision |
|---|---|---|
| 1 | D1 | `protectedPaths` is an object of `gatePolicyPaths` + `testGlobs` string arrays; `riskClasses` is a flat string array. Risk-class→path association is code, not config. |
| 2 | D1 | An unknown `gatePolicy` member is malformed and refuses the launch, naming the key. Slices 02/05 widen the known set. |
| 3 | D5 | A waiver `path` is one exact repo-relative path after normalization, never a glob. Duplicate `riskClass`+`path` refuses the launch. |
| 4 | D6 | The glob dialect is a narrow hand-rolled subset — literal segments, `*`, `**` — case-sensitive on every platform. No runtime dependency. |
| 5 | D22 | `GateDeclaration` gains an optional in-process `run`; `GateResult` gains a typed `findings` payload; `GATE_EVIDENCE_VERSION` 1 → 2. |
| 6 | D22 | Two gate IDs at stage `deterministic`: `scope` (D2/D3/D4) and `feedback-integrity` (D5/D6). |
| 7 | D22 | `RunState` 3 → 4 with per-slice `appliedWaivers`; `evidenceArtifactId` **is** the existing `evidenceSha256`. |

## What the authoring pass should do before relaunching

1. Open every source file in slice 01's row of the file-scope map and check each
   PRD statement against the actual type signature and schema version. The five
   findings above all came out of that exercise; assume more remain in
   `src/post-qa-gates.ts` and `src/escalation.ts`.
2. Do the same for slices 02–06. Nothing suggests slice 01 is unusual — it is
   just the only one that has run.
3. Confirm the park path: D5 says an unwaived protected change "parks the slice
   through PRD 2's park-and-continue machinery with its risk class and exact
   path." The shape of that park record was not checked.

## Environment notes for whoever relaunches

- **`scripts/min-env.sh` cannot be invoked from a bare `cmd.exe`.** It resolves
  its clean intermediate shell with `type -P bash`, and on a Windows PATH that
  finds `C:\Windows\System32\bash.exe` (WSL), which deadlocks with
  `get_proc_lock: Couldn't acquire sync_proc_subproc`. The launcher must put
  Git's `usr\bin` ahead on PATH first — `.afk/launch-prd4.cmd` does. Worth
  hardening in the script itself: prefer `/usr/bin/bash` when it exists.
- **The globally linked `afk-codex` is not this worktree.** It resolves to a
  git-installed copy of afk-pipeline under `PNPM_HOME`. A self-run must launch
  `node C:/Code/afk/dist/afk-codex.js` after `pnpm build`.
- Launch preconditions 1–6 in `prd.md` all verified on 2026-09-07;
  `AWS_PROFILE`, `AWS_DEFAULT_PROFILE` and `AWS_CONFIG_FILE` were all absent, so
  the #135 waiver's stated condition held.
