# Architecture review — PRD 9: preserve-work contract renegotiation

**Round:** 1 (first and only round that reads the whole branch)
**Reviewed:** `git diff main...HEAD` (43 commits, `b3218a8` back to `d9c88a6`),
slices #277, #332, #333, #334, #335, #278 and their contracts under
`.kiro/specs/afk-preserved-work-renegotiation/slices/`.

**Verdict:** ACCEPT-WITH-NOTES

## What ships, structurally

One new module (`src/preserve-work-recovery.ts`, 2913 lines), one additive
run-state schema bump (v6 -> v7 plus a per-state-validated event shape), one pure
scope-widening helper in `src/slice-scope.ts`, two CLI parsers in
`src/cli-options.ts`, and exactly one orchestrator call site
(`src/orchestrator.ts:8515`, `reconcileRecoveryLineage` before the manifest scope
check). Everything else is exported seams with no production caller: the CLI
refuses `--renegotiate-stale` for every well-formed request
(`src/cli-options.ts:480-487`), which `issues.md:64-70` and slice 06's contract
Non-goals put in #336. So the shipped reachable surface is: two parsers that
refuse, one schema that loads unchanged, and one launch-time reconciliation that
is a no-op when `state.recoveryLineage` is absent (`src/run-state.ts:1381-1393`
returns a default state, `reconcileRecoveryLineage` iterates nothing).

That is the right shape for this PRD, and the parts I checked hardest hold up:

- **One writer per persisted fact.** `appendRecoveryLineageEvent` takes a loaded
  state, not a repo root (`src/run-state.ts:425-435`), so an event can only be
  appended inside a `transactRunState` body that already reloaded under the ADR
  0056 lock. There is one restore-and-verify routine
  (`restoreAcceptedPairFromSnapshot`), one rollback writer, one terminal-event
  builder (`nextRecoveryEvent`), and one scope encoder
  (`encodeRunScopeFingerprintPayload`) shared by admission and completion. ADR
  0018's "a new persisted fact extends run-state's schema with a version bump and
  a reader" (ARCHITECTURE.md "Placement rules") is satisfied, and the sanitizer's
  per-state required/forbidden field rules (`src/run-state.ts` ROLLBACK_FAILURE_FIELDS
  / COMPLETION_FIELDS) are a genuinely good call: a `PENDING` event carrying a
  replacement fingerprint cannot load.
- **The v7 widening of `extensions` without a bump is sound.** I verified the
  claim rather than taking it: `git show 93b5d5e:src/preserve-work-recovery.ts`
  line 767 emits the literal `extensions: []`, and `git show 89da518:src/run-state.ts`
  typed it `string[]`, so no document on disk can hold a non-empty array of the old
  element type. The `[]` case is valid under both shapes.
- **Completion is one write.** `completeRecoveryAttempt` appends the `COMPLETED`
  event and calls `appendScopeExtensions` in the same `transactRunState` body
  (`src/preserve-work-recovery.ts:2483-2499`); `transactRunState` writes the whole
  mutated state once (`src/run-state.ts:718-730`, `writeRunState` spreads the
  state), so there is no document with one half. The narrow-only invariant of
  `resolveRunScope` is untouched, and the widening lives beside it rather than in a
  transaction body — the right placement.
- **Nothing moves a ref.** I grepped the module for merge/reset/rebase/checkout
  usage: it imports only `countCommitsAhead`, `hasUncommittedChanges`,
  `isAncestor` and `resolveCommit`, three of them behind an injected
  `RecoveryGitProbes` seam. ADR 0039 is respected on every path, including
  refusals.
- **Test placement follows the ladder.** One new spawned `runPipeline`
  (`src/resume-integration.test.ts`), with a comment saying why the ordering claim
  cannot be made anywhere cheaper (`src/preserve-work-recovery.test.ts:2398-2413`),
  everything else on a shared fixture. That is ARCHITECTURE.md's last placement
  rule applied correctly.

No finding below has a normal-operation reachable trigger introduced by this
diff, because the request path is refused at the CLI and the one wired call site
is inert without lineage. Hence ACCEPT-WITH-NOTES rather than FIX-BEFORE-SHIP.
Notes A-01, A-03, A-07 and A-08 are the ones #336 should read before it wires the
path, because that slice is what makes them reachable.

## Findings

### A-01 — the locator hardening misses Windows separators inside a segment

`deriveRestoreDestination` (`src/preserve-work-recovery.ts:2686-2720`) exists
because `sliceDir` is derived as the grandparent of the locator and a bad locator
would rewrite `contract.md` / `acceptance-manifest.json` somewhere else — the
docstring makes that argument itself. It rejects a segment that is exactly `""`,
`"."` or `".."`, a locator with fewer than three `/` segments, and a penultimate
segment that is not `recovery-snapshots`. It does not reject a segment that
*contains* a path separator, and on the platform of record `path.join` resolves
backslashes. I ran it:

```
locator:     "a/..\..\b/recovery-snapshots/id"
segments:    ["a","..\..\b","recovery-snapshots","id"]
bad segment: false      // none is exactly "", "." or ".."
snapshotDir: C:\b\recovery-snapshots\id
sliceDir:    C:\b       // outside repoRoot C:/repo
```

`restoreAcceptedPairFromSnapshot` then `mkdirSync`s that directory and writes both
pair files into it (`:1804-1810`). No locator this code produces can look like
that — `publishAcceptedPairSnapshot` normalizes separators at `:949`
(`relative(...).split("\\").join("/")`) — so the trigger is a hand-edited,
merged or corrupted run-state file, not normal operation. That is why this is a
note. The cheap fix is to reject any segment containing `\` or `:`, or better, to
resolve the derived `sliceDir` and assert containment under `repoRoot`, which
covers every future spelling instead of the two known ones.

### A-02 — two comparators for one "canonical order"

`compareScopeExtension`/`compareGhIssue`
(`src/preserve-work-recovery.ts:529-535`, `:2728-2735`) and
`compareScopeIdentity`/`compareIdPart` (`src/slice-scope.ts`, added by #278) are
two implementations of the same ordering rule — "canonical slice number, then GH
issue id" — and the first is documented as "the one order the set is stored,
compared and appended in". They agree on every digits-only spelling. They diverge
where `Number()` coerces a non-digit string: `compareGhIssue` sorts `"12.0"`,
`" 12"` and `"1e3"` numerically (`Number.isInteger(Number(x))`), while
`compareIdPart` requires `/^\d+$/` and falls back to a string compare. Consequence
today is confined to stored order (the scope fingerprint is recomputed from
persisted order, and replay comparison subtracts by `ghIssue`), so nothing fails —
but this is precisely the "two normalizations of one identity is how two callers
come to disagree" argument the module makes three times in its own comments
(`:246-254`, `:355-363`, `:588-596`). Export one comparator and have
`appendScopeExtensions` take it.

### A-03 — `afkManifest` is optional and its default is the permissive branch

`admitStaleRenegotiation` and `completeRecoveryAttempt` both declare
`afkManifest?: AfkManifest | null` and pass `args.afkManifest ?? null`
(`:1244-1249`, `:2443-2448`). `resolveScopeExtensions` treats `null` as "the
documented legacy mode [that] restricts nothing" and skips
`assertWithinManifestScope` entirely (`:437-455`). So a call site that forgets the
argument while passing `extendScope` silently loses the one shared fail-closed
reservation check every other scope funnel makes, and omission is indistinguishable
from a deliberate legacy declaration. Its sibling `slices?: readonly Slice[]`
fails *closed* on omission (every selector resolves to `extension-slice-unknown`;
under the completion lock it becomes CAS-lost and a rollback), so the two inputs
to one decision have opposite failure directions. Since the only future caller is
#336's wiring, make the parameter required (`afkManifest: AfkManifest | null`) so
the caller has to say "legacy" out loud. Contract B-02 authorizes the `null`
semantics; it does not require the parameter to be optional.

### A-04 — the module imports four "Internals (do not import)" and then cites that rule to duplicate a parser

`readLockedAcceptedPair` re-implements the accepted-contract status match —
`/\*\*Status:\*\*\s*(\S+)/i` at `src/preserve-work-recovery.ts:724`, character for
character the regex in `readContractStatus` (`src/artifacts.ts`) — and the
docstring justifies it with ARCHITECTURE.md's "Internals (do not import)" column
(`:710-715`). But the same module imports `./acceptance-manifest.js`,
`./contract-convergence.js` and `./slice-scope.js` (all listed as Review rails
internals, ARCHITECTURE.md:29) and `./exact-stage-resume.js` (a Run records
internal, ARCHITECTURE.md:25). Either the column binds or it does not; applied
selectively it produced a second reader of the pair's LOCKED format, which is the
one duplication this module otherwise refuses everywhere. In fairness the column
is already disregarded at base — `acceptance-manifest.ts` has twelve non-Review-rails
importers on `main`, `slice-scope.ts` six — so the durable fix is a map that says
what is actually public, not a rewrite here. Note only, and pre-existing in its
cause.

### A-05 — the ARCHITECTURE.md row is a changelog, in a column headed "one line"

The new `Preserved-work recovery` row (ARCHITECTURE.md:26) is a single cell of
~2,300 characters narrating five slices in sequence ("and ... (#333) ... and ...
(#334) ... and ... (#335)"). The other twenty rows average roughly 120 characters,
the column header is "Purpose (one line)", and the file sits exactly at its
declared 150-line cap, so the row cannot absorb #336 without displacing something.
The map is what the explorer and planner receive in their envelopes
(ARCHITECTURE.md:8-9); a row this long costs every future agent context and states
history the ADRs and issue numbers already carry. Compress it to the module's
durable purpose and let `(#277, #332-#335, #278, ADR 0018/0039/0055/0056)` carry
the rest.

### A-06 — a spawned scenario and a 36s unit suite landed with no ratchet measurement

`src/preserve-work-recovery.test.ts` is new and runs inside the `fast` suite
(`package.json` `test:fast` excludes only the nine heavy files), and
`src/resume-integration.test.ts` gained one spawned `runPipeline`. I timed the new
file alone on 2026-09-15: **36.49s, 177 tests, exit 0** — about 14% of the `fast`
budget of 258s in `suite-budgets.json` — and the resume-integration budget (219s)
now also carries a fresh pipeline spawn. `git diff --stat main...HEAD` shows
`suite-budgets.json` untouched, and a grep of all six slice handoffs finds no
mention of `ratchet` or `budget`. CLAUDE.md and AGENTS.md ask for
`pnpm test:ratchet` when a spawned scenario is added, precisely so the seconds and
the git-process count are recorded rather than discovered later. Not a code defect
and deliberately outside `pnpm test` (ADR 0063) — but the measurement is owed.

### A-07 — `endCompletionThroughRollback` re-reads unlocked, then hands the lineage to a writer that re-reads again

`endCompletionThroughRollback` (`:2188-2240`) loads run state, checks the trailing
event is this attempt's `PENDING`, and then calls `rollBackRecoveryAttempt`, which
loads run state *again* and acts on whatever unresolved event trails
(`:2005-2026`) — restoring that event's snapshot over the slice directory before
its locked recheck runs. Between the two reads the lineage can be a different
attempt's `PENDING` (rollback, then a fresh admission), and the restore is outside
the lock, so the wrong snapshot can reach disk even though the locked recheck then
refuses to append. The docstring names this window and defends the caller-side
check as the best available under #335 P-02, which forbids teaching the writer an
`attemptId`. I agree it is the right call for this slice, and the trigger requires
two concurrent recovery processes on one run — unreachable while the CLI refuses.
When #336 wires the path, the clean resolution is an *expected*-`attemptId`
parameter on the existing writer (one writer, one more precondition), not a second
writer.

### A-08 — nothing holds dispatch for a trailing `PENDING`

The PRD says a `PENDING` attempt "blocks ordinary resume, generator dispatch and
another admission for that target". Two of the three ship: `hasOpenRecoveryAttempt`
refuses a second admission, and `reconcileRecoveryLineage` terminates an unresolved
attempt at launch and stops the run (`src/orchestrator.ts:8520-8543`). The dispatch
half is covered only for the other two states — `recoveryDispatchRefusal` on
`ROLLBACK_FAILED` (`:2543`) and `recoveryPreDispatchRefusal` on `COMPLETED` drift
(`:2597`) — and both return `undefined` for a trailing `PENDING`. Within one
process that admitted an attempt there is no predicate a dispatch site can ask.
No such call site exists today, so nothing is wrong on this branch; recording it so
#336 wires a `PENDING` hold rather than assuming the two exported predicates are
the whole "may I dispatch" answer.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Recovery snapshot locator validation misses Windows separators inside a segment, so a tampered locator escapes repoRoot","class":"ROBUSTNESS","clearCondition":"deriveRestoreDestination rejects any locator segment containing a path separator or drive letter, or asserts the derived sliceDir resolves inside repoRoot","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"Two comparators implement the one canonical scope-identity order and disagree on numeric-coercible non-digit spellings","class":"DESIGN","clearCondition":"One exported comparator owns canonical scope-identity order and appendScopeExtensions uses it","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"afkManifest is an optional argument whose default is the permissive legacy branch, unlike its fail-closed sibling slices","class":"DESIGN","clearCondition":"admitStaleRenegotiation and completeRecoveryAttempt take afkManifest as a required AfkManifest | null so a caller must declare legacy mode explicitly","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"The recovery module imports four modules the map lists as internals while citing that rule to duplicate readContractStatus's LOCKED regex","class":"COUPLING","clearCondition":"Either the LOCKED-status read reuses one owner, or ARCHITECTURE.md's public-seam columns are corrected to match what modules actually import","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"The new ARCHITECTURE.md module row is a ~2,300-character five-slice changelog in a column headed 'Purpose (one line)'","class":"DOCUMENTATION","clearCondition":"The Preserved-work recovery row states the module's durable purpose at the length of its sibling rows, with history left to the cited ADRs and issues","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"A new spawned scenario and a 36.5s unit suite landed with no suite-budgets measurement recorded","class":"PROCESS","clearCondition":"pnpm test:ratchet is run and suite-budgets.json carries a labelled measurement covering the new fast-suite file and the added resume-integration spawn","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-07","title":"endCompletionThroughRollback's unlocked trailing-event check leaves a window where the rollback writer restores another attempt's snapshot","class":"CONCURRENCY","clearCondition":"The rollback writer takes an expected attemptId precondition so the restore cannot act on a lineage that moved after the caller's read","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-08","title":"No exported predicate holds agent dispatch while a target's trailing lineage event is PENDING","class":"INTEGRATION","clearCondition":"A dispatch-time predicate refuses for a trailing PENDING attempt and the wiring slice consumes it alongside the ROLLBACK_FAILED and COMPLETED-drift holds","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false}]}
