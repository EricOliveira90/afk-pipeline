# One AFK run per host unless the operator overrides

**Status:** Accepted
**Date:** 2026-09-13

Issue #275. AFK relied on operator guidance that only one heavy run may be
live on a machine — §3c policy 5's four-condition allowance even authorized
two, under conditions no code checked. The 2026-09 weeks collected the bill:
concurrent PRD 5, PRD 7, another AFK run and a hand-run suite degraded
execution 3–5× and destabilized the host. Nothing in the launch path knew a
second run was starting, because nothing on the host recorded that a first
one existed.

## Decision

**Every pipeline run acquires a host-wide run lease before its first side
effect; a second run refuses unless the operator passes
`--allow-concurrent-run`.** Implemented in `src/run-lease.ts`, wired
identically into `afk`, `afk-claude` and `afk-codex`.

- The canonical lease is a directory at `os.tmpdir()/afk-pipeline/run-lease`
  — machine-wide for the operator account, independent of cwd, repository,
  PRD, worktree and provider binary. Publication is atomic: the owner record
  is staged in a uniquely-named sibling directory and renamed onto the
  canonical path, so a reader never observes a lease without a complete
  `owner.json` (version, random lease id, PID, process-birth identity,
  hostname, provider, PRD slug/dir, cwd, argv, acquisition time — never
  secrets or environment values).
- Acquisition happens after argument/PRD/dry-run validation and before
  `runPipeline` creates run state, logs, branches, worktrees, agents or
  gates. The `status`, `stop`, `clean-failed`, `adopt` and `eval`
  subcommands and `--dry-run` never acquire it. Refusal prints the lease
  path, owner PID, start time and age, provider, PRD, cwd/command and the
  override instruction, then exits 2 — the "refused before doing anything"
  exit code.
- **Staleness requires a conclusive negative, never age.** A contender
  probes PID liveness and process-birth identity (PowerShell CIM
  `Win32_Process.CreationDate` on Windows — the `src/kill-tree.ts`
  conclusion: never `wmic`, never `tasklist`; `/proc/<pid>/stat` field 22 on
  Linux; `ps -o lstart=` elsewhere). A missing PID, or a live PID whose
  birth identity differs from the recorded one, is conclusively stale: the
  old directory is atomically renamed aside to a uniquely-named quarantine
  path (only one contender's rename wins), the canonical path is
  re-acquired, the recovery is reported, and the quarantined directory is
  removed. A corrupt record, a foreign hostname, an owner that recorded no
  birth identity, or an unreadable identity is *unverifiable*: the launch
  fails closed with diagnostics and requires `--allow-concurrent-run`. A
  live process is therefore never treated as stale while it is alive.
- **Release is compare-before-delete.** The canonical directory is removed
  only after re-reading `owner.json` and matching this acquisition's random
  lease id, so an old owner's cleanup can never remove a successor's lease.
  The release is registered on the process `exit` event by the shared
  acquire-or-exit boundary — which covers normal success, blocked-ship
  `process.exit(1)`, the `PipelineError` handler, the fatal-error catch and
  the second-signal hard exit, none of which run a `finally` — and is also
  called in the entries' `finally` at pipeline wind-down, so clean
  cancellation frees it as soon as the CANCELLED records are written.
  Release is idempotent; the double wiring cannot double-fire destructively.
- **`--allow-concurrent-run` never mutates the other owner's lease.** When
  the lease is free it acquires normally (including stale recovery); when a
  live or unverifiable owner exists it prints a prominent warning naming
  that owner and proceeds *without* the lease — nothing is replaced,
  deleted, or later released.

## What this is not

Three other exclusion-shaped things exist and stay distinct. The **stop
sentinel** (ADR 0043) is a delivery mechanism for a stop request, scoped to
one run's log directory — it holds nothing. The in-run **merge mutex** and
the preview-apply lock serialize phases *inside or between rounds of one
run*. `withFileLock` (ADR 0056) is a spin-waiting, milliseconds-held
critical section around one run-state file. The run lease is none of these:
it is held for hours, contention refuses immediately instead of waiting, and
its staleness rules must survive PID reuse — which is why it records a birth
identity none of the others need. Per-command test-suite locking, AFK's
internal lane parallelism, killing an existing run, and hand-run test
commands are out of scope (the §6 suite-lock trigger is unchanged).

## Consequences

- Two runs launched from different repos, worktrees or provider binaries
  cannot both proceed silently; the second one names the first and stops
  before creating anything. §3c policy 5 is rewritten accordingly: the
  four-condition allowance survives only as subordinate rules for a
  deliberately overridden concurrent launch.
- A crashed run's lease heals itself on the next launch, with PID-reuse
  protection, so enforcement does not decay into "delete the lock file"
  folklore. The deliberately narrow failure mode is an *unverifiable* owner,
  which asks the operator rather than guessing.
- Probing birth identity costs one PowerShell spawn (~1–2 s) at launch on
  Windows, once per run — noise against a pipeline that runs for hours.
- Tests: verdict and acquisition logic is unit-tested with injected probes;
  one deliberate child-process scenario (the `src/file-lock.test.ts`
  pattern, no pipeline spawn) covers cross-process exclusion, killed-owner
  recovery and the simultaneous stale-takeover race. `src/cli-entries.test.ts`
  pins the three-way invariants: the flag in every usage string and the
  acquisition positioned after the dry-run return, before the pipeline
  handlers.
