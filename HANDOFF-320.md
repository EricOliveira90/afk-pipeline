# Handoff — #320, reconcile guardian finding issues across review rounds

Branch `fix/320-guardian-finding-reconciliation`, worktree `C:\Code\afk-320`,
pushed to origin. No PR opened — the maintainer decides merge timing.

## What changed

**The persisted identity** (`src/guardian-round-records.ts`).
`PersistedFiledFinding` gained `prdSlug`, `runId` and `reconciled`
(`{ round, action: "UPDATED" | "CLOSED" }`). All three are optional: a record
written before #320 is still a true statement about an issue that exists, and
dropping it would file that issue twice. `prdSlug` can only ever *refuse* — a
record naming another PRD is not this run's to touch — and a record naming none
is read as this run's own, because it was loaded from this run's own state file.
`runId` is evidence for the comment, never a gate, because a resumed run
legitimately reconciles issues an earlier run's directory filed. The sanitizer
drops a row whose #320 fields are present but malformed rather than reading it
without them: those are the fields a close acts on.

**The write** (`src/guardian-round-persistence.ts`). New
`recordGuardianFindingReconciliations`, on the `GuardianRoundPersistence` seam
beside the other three. It only ever overwrites `reconciled` on rows that exist —
inventing a row would be a filing nobody performed. The round append already
carries `filedFindings` forward whole, so the memory rides along.

**The judgment** (`src/finding-filing.ts`, pure). `reconcileFindingIssues`
returns `update` / `close` / `reopen` / `refuse` / `unchanged` decisions. Identity
resolves stable-ID-first, fingerprint-second, through the same
`idMatchIsCorroborated` guard filing uses (#247 / ADR 0065), so a bare ID match
resolves nothing and therefore closes nothing. Only an explicit `RESOLVED` on
corroborated identity closes, and only on evidence no older than the round that
filed the issue. `applyFindingIssueReconciliation` performs the decisions through
injected `comment` / `close` / `reopen` callbacks, never throws, and returns the
memory only when every call a decision needed succeeded — a comment that landed
before a failing close costs one duplicate comment next pass rather than a
`CLOSED` row over an open issue.

**The wiring** (`src/ship-gate.ts`, one contiguous block right after
`foldGuardianLedger`, plus `runId` on the two `buildFindingIssueDrafts` calls).
It runs before the cap and PR decisions, so every exit below it has already told
the tracker the same story. `gh issue comment|close|reopen` go through the
existing `runCommand` seam. Every failure is data.

**The count** (`src/run-events.ts`, `src/logger.ts`, `src/handoff.ts`,
`src/orchestrator.ts`). One `guardian-issue-reconciliation` event per issue per
pass. `run-summary.md`'s new `## Guardian Finding Issues` section and
`handoff.json`'s new `unresolvedGuardianIssues` are both projections of that one
stream, so a dashboard and an operator cannot disagree — which is the
disagreement #320 was filed about.

**Docs.** A `Finding reconciliation` entry in `CONTEXT.md` and an amendment to
ADR 0057 decision 4 dated 2026-09-14.

This bug is reproducing in this repo's own tracker right now: #311 and #314 carry
byte-identical titles, as do #312 and #315, and #314/#315 were closed
`NOT_PLANNED` on 2026-09-14 while #311/#312 stayed open.

## Verified

An AFK self-run was live on this host, so only `typecheck` and targeted
single-file vitest runs were used.

- `npx tsc -p tsconfig.json --noEmit` — clean (equivalent to `pnpm run typecheck`).
- `npx vitest run src/finding-filing.test.ts` — 32 passed.
- `npx vitest run src/guardian-round-persistence.test.ts` — 20 passed.
- `npx vitest run src/guardian-finding-ledger.test.ts` — 10 passed.
- `npx vitest run src/handoff.test.ts` — 4 passed.
- `npx vitest run src/logger.test.ts` — 59 passed.
- `npx vitest run src/ship-gate.test.ts` — 35 passed (~41 s).
- `npx vitest run src/run-journal.test.ts src/run-state.test.ts` — 85 passed.
- `npx vitest run src/context-envelope.test.ts` — 75 passed (the ADR edit feeds
  the explorer's repository-context budget).
- `npx vitest run src/eval-boundary.test.ts src/prompt-recorder.test.ts` — 20
  passed (both assert on `CONTEXT.md`).

## Still owed

- The full `pnpm test`. Not run here: an AFK self-run was live on the host and
  the suite takes 17–30 minutes under contention.
- `src/orchestrator.test.ts` and `src/orchestrator-runs.test.ts` were not run
  (heavy pipeline suites, host contention). Both read `handoff.json` with
  field-level assertions (`toMatchObject`, individual fields) rather than an
  exact object, so the new `unresolvedGuardianIssues` field should not disturb
  them — confirmed by reading, not by running.
- No spawned ship-gate scenario exercises a *refused* reconciliation: the
  refusal decision, its event and both projections are unit-tested, and the
  ship gate's warn path around them is not. Adding one costs a new spawn, which
  CLAUDE.md's placement ladder puts last.

## Merge conflicts to expect

Branch `fix/272-238-preship-crash-and-skip` was editing `src/logger.ts` and
`src/ship-gate.ts` the same night. My edits to those two files are localized:

- `src/logger.ts`: one new section constant immediately before
  `dependencyRows` in `writeSummary`, and `${guardianIssueSection}` appended to
  the end of the existing section-interpolation line. `formatConsoleSummary` is
  untouched.
- `src/ship-gate.ts`: one import block, `basename` added to the `node:path`
  import, one contiguous block after `const alreadyFiled = ledger.filedFindings;`,
  and `runId,` added inside the two `buildFindingIssueDrafts(...)` calls.
