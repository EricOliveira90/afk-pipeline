# The launch preflight detects, reports and refuses — it never kills

**Date:** 2026-08-28

## Context

Three of the six AFK v2 self-runs died of host state that was already
observable before the run started, and each one cost hours:

- **Run 3.** Two hard kills each left a `codex.exe` descendant holding a
  slice worktree as its working directory (prime suspect PID 35100,
  `codex.exe __otel-server`). The leaked handle blocked the worktree
  refresh on *every* subsequent run — `#77 cannot run under AFK at all`
  until the process died or the machine restarted. ADR 0035 explains why
  teardown cannot cover this: the run that leaks the handle is the run
  that was hard-killed, so its teardown never executes.
- **Run 6.** The machine filled mid-QA, an unhandled `error` on a
  WriteStream terminated the process, and because #114's cancellation
  bookkeeping hangs off the `AbortSignal`, nothing was recorded — run
  state still named the *previous* run's failure for #79, two attempts
  stale (#121). The disk cause was then misdiagnosed twice: `%TEMP%` held
  467 `afk-*` fixture directories that looked like a leak but measured
  **0.02 GB in total** — empty directory shells left by teardown's
  `Directory not empty` path on Windows. There is no pipeline space leak;
  the machine was simply full.
- **Every stale-directory refusal.** `createWorktree`'s ADR 0010
  assertion refuses a path that exists on disk but is not a registered
  worktree. That refusal is correct, and it arrives mid-run, one slice at
  a time, hours after the operator walked away.

All three are launch-time facts. Nothing about them requires an agent, a
model, or a dispatched slice to discover.

## Decision

A launch preflight runs inside `runPipeline`, after the run scope
resolves (so the exact worktree paths are known) and before anything is
created or mutated. `src/preflight.ts`, ~seconds per launch, zero per
slice.

**1. Two hard conditions refuse the launch.**

- *Free disk below a floor.* `--min-free-disk-gb`, default
  `DEFAULT_MIN_FREE_DISK_GB` = **5**, `0` disables. Read with
  `fs.statfsSync` (`bavail * bsize`), which works on Windows without
  shelling out. The default is a headroom judgement, not a measurement of
  need: the repo including `.afk` is 0.16 GB and a four-slice wave with
  its logs stays well under 2 GB, so 5 GB covers a whole run plus the
  OS/temp churn of an unattended multi-hour session, while a normally
  loaded dev box (10.8 GB free when this shipped) still launches. A run
  that starts with 200 KB free was never going to finish.
- *Leftover registered worktrees.* A registered worktree inside the run's
  namespace that **no live slice of this PRD owns**, or one registered for
  a branch that path does not belong to. The discriminator is deliberately
  *not* "is it in this invocation's scope": a narrowed re-run
  (`--slices 02`) legitimately leaves a MERGE-PENDING or STUCK slice's
  worktree registered, because ADR 0029's merge-only recovery and
  `--resume-stuck` both need that tree on a later run. So the adoptable
  set (`RunNamespace.retained`) is every incomplete AFK slice in the
  *manifest*, accepting either the recorded or the derived branch, and the
  refusal fires only outside it: a completed slice's surviving worktree, a
  slice number the manifest does not have, or a branch mismatch. Scratch
  merge worktrees (`.afk/merge-…`) and the review worktree are created
  *and removed within* a run, so one surviving to the next launch is
  residue by definition and never adoptable.
- A third refusal rides the same family: a namespace path this run needs
  that **exists on disk but is not registered**. That is the exact ADR
  0010 refusal, moved from mid-run to launch, where the operator is
  present.

**2. Live holders are reported with a named PID list, never killed.** The
scan reads each process's executable path and command line
(`listProcessPaths` in `src/kill-tree.ts` — CIM on Windows, `ps -A -o
pid=,args=` on POSIX) and names every process referencing a namespace
path, with the path it matched. Severity `report`: it never refuses.

**3. Empty directory shells inside the run's own namespace are swept at
start.** Only trees that contain no files at all, only further real
directories — a tree holding one file, one junction or one symlink is
left entirely alone, and a registered worktree is never a candidate. The
sweep runs *before* the worktree checks, so a namespace path that is
nothing but teardown residue is gone before anything decides to refuse
over it. This is hygiene, not a space reclaim: run 6's 467 shells held
0.02 GB.

**4. Nothing the preflight cannot observe becomes a refusal.** An
unreadable worktree listing, an unmeasurable volume, an unlistable
process table: each becomes a stated caveat in the report and the launch
proceeds. A check that refused on its own blindness would train operators
to pass the override permanently.

**5. The refusal is overridable and the override is recorded.**
`--preflight-report-only` runs every check, prints every finding, and
launches anyway; the bypass is written to `run.log` and `events.jsonl`
(warn reason `preflight`) naming how many conditions it stepped over.

## What this deliberately does not do

**No auto-kill, in either debated form.** Both were cut in the AFK v2
plan debate (`docs/specs/afk-v2-plan-debate.md` §2), and the arguments
are the reason this ADR exists rather than a kill path:

- The **scan-based** form (kill whatever holds a namespace path) died on
  ADR 0020's own text: `taskkill /T` cannot enumerate the children of a
  dead root, so the scan is new, unverified kill machinery whose cwd
  guard both *under*-matches (file handles with no cwd inside the tree)
  and *over*-matches (an operator's shell `cd`'d into the namespace).
- The **record-based** form (kill only PIDs the previous run recorded)
  died on the code: `TerminationReport.survivors` is populated solely by
  post-kill polling in the orderly-teardown path, so the crash classes
  that actually produce leaks write no record at all — the machinery
  cannot fire when it is most needed. Killing an hours-old recorded PID
  would also be the first code path to break ADR 0020's "only
  snapshot/BFS members are ever force-killed" guarantee, with PID reuse
  by a concurrent sibling run as the collision the namespace guard cannot
  exclude.

Detection, report and fail-fast is the whole cure, because the receiver
is the operator who just typed the launch command. Re-proposing either
form requires a second leak incident **in which the survivor record was
actually present** — the debate doc's trigger, not this file.

**No launch-time state↔branch audit.** Also cut: squash/rebase
permanently breaks its ancestry heuristic, so it is an advisory declared
advisory-forever whose false-positive rate only rises. The invariant is
enforced at write time inside `afk adopt` instead, where refusing to
write state is falsifiable.

**The holder scan cannot see a cwd-only holder.** `Win32_Process` exposes
no working directory; `openfiles` needs a flag and a reboot and emits
localized output (the same reason ADR 0020 rejected `tasklist`), and
`handle.exe` is not present. Native interop for a report-only check is
not worth new fragile machinery. So the run-3 shape — `codex.exe
__otel-server`, holding a worktree as its cwd with no namespace path in
its argv — is structurally invisible to the scan. The report says so, in
its own caveat line, and points at ADR 0035 and the restart-to-clear
step. Naming the gap beats implying that a finding-free scan means a
clean machine.

## Consequences

- The three run-killer classes above become a refusal the operator reads
  at launch, with the remedy in the message (`afk clean-failed`, free
  space, `taskkill /PID <pid> /T /F`).
- A run whose post-merge teardown left a registered worktree behind will
  refuse the *next* launch until it is cleared. That is host hygiene made
  blocking on purpose — ADR 0035 records PASS for such a slice and warns,
  and this is where the warning acquires teeth. It is also the most
  likely false positive, which is what `--preflight-report-only` is for.
- `sliceWorktreeNamePattern` / `scratchMergeNamePattern` /
  `reviewWorktreeDir` are now named exports of `orchestrator.ts`, and
  `clean-failed.ts` uses the first two instead of its own copies. There
  was one copy of the naming per consumer; now there is one definition.
- `listProcessPaths` joins `listPidPpid` in `kill-tree.ts`. Both are
  read-only listers sharing that module's spawn plumbing and platform
  reasoning; neither terminates anything.
- Cost: one `statfsSync`, one `git worktree list`, one process-table
  listing (~100ms per ADR 0020's measurements) and one shallow namespace
  `readdir` per launch. Nothing per slice, nothing on the happy path's
  output — a clean preflight prints no lines at all.

## Verification

`src/preflight.test.ts` drives every check against fabricated inputs — an
injected worktree listing, an injected free-space reading, an injected
process table and a fake filesystem — so there is no git, no spawn and no
new spawned scenario (AGENTS.md's assertion-placement rule: a launch
guard is a pure decision). It covers each refusal and each report, the
resume worktree that must *not* refuse, the three unobservable-input
caveats, the sweep's file/junction/registered-worktree exclusions and its
bottom-up removal order, `--preflight-report-only`, and the run-3 holder
shape asserted as a *limitation*. `src/kill-tree.test.ts` parses the CIM
and `ps` listings, including a command line containing tabs.
`src/cli-options.test.ts` covers the two new flags.
