# Contract feedback — round 2 (#335, recovery completion and replay)

## What this round settled

Two findings are genuinely closed, and both were closed the right way — by
restating the contract over facts the tree actually carries, not by asserting
harder.

**Lock provenance (F-01).** The completion writer no longer matches any
provenance line against the pair's bytes. `completion-pair-not-locked` is now
defined by exactly one thing — `readLockedAcceptedPair` returning `undefined` —
and the only artifact-text rule in play is the `**Status:**` regex that reader
already applies (`src/preserve-work-recovery.ts:344-345`). Provenance becomes a
caller-supplied non-blank string with its own refusal code
(`completion-lock-provenance-missing`), which is a cleaner seam than a byte
match would have been: the format keeps one owner and the recovery module keeps
its no-`artifacts.ts` rule.

Worth recording that the planner was right and round 1's declared evidence was
wrong on the underlying fact. `LOCK_PROVENANCE_FIELD = "**Lock-Provenance:**"`
does exist, at `src/artifacts.ts:1539`; `setLockProvenanceLine` writes it
(`:1700`, used at `:1685-1687`), `readContractLockProvenance` reads it back
(`:1564`), and the orchestrator already calls that reader at
`src/orchestrator.ts:2772`. The contract's citations check out. The finding still
cleared on its second option rather than its first, because what matters is that
the completion writer depends on none of it.

**Pair fingerprints (F-05).** Named precisely, and the line references are
exact: `AcceptedPairBytes` at `src/preserve-work-recovery.ts:316-321`, the
module-local `sha256` at `:323-325`, and the two fields populated at `:358-359`.
B-01's observable now compares `===` against what
`readLockedAcceptedPair(sliceDir)` returns instead of restating a hash
independently, so B-04's and B-05's comparisons all reference one defined value.

**Orchestrator seams (F-02), contract side.** The three claims round 1 could not
check are now stated and correct. `runSliceExecute` is imported at
`src/wave.ts:19` and called exactly once, at `:536`. The LOCKED seam is indeed
not single: the phase-A collection tests `result.phase === "LOCKED"` at `:313`
and the lane restart tests `negotiate.phase !== "LOCKED"` at `:502`. Withdrawing
the "exactly once" claim as false rather than restating it is the right move, and
recording the located seams for slice 07 to inherit is worth more than the claim
was.

## What blocks the lock

**Only contract.md was revised. The acceptance manifest was not.**

The contract's Non-goals now hand the reporting surface and the launch wiring to
a named follow-up slice, and say plainly that this slice "emits no
`RunEventPayload`, adds no snapshot or status field, and touches neither
`src/cli-options.ts`, `src/orchestrator.ts`, `src/wave.ts` nor the three entry
points". P-04 requires the `--renegotiate-stale` refusal to stay in force with
its tests unedited.

`acceptance-manifest.json` still says the opposite. B-06, B-07, B-08 and B-09 are
all still in-scope behaviors with the full `typecheck`/`tests`/
`acceptance:behaviors` gate set. B-09 still requires deleting
`src/cli-options.ts:393-400` — the exact refusal P-04 requires be preserved —
advertising the flag pair in all three entry points, and wiring the whole request
path into `runPipeline`. And `fileScope` lists six paths, none of which are the
files those four behaviors must edit: `src/run-events.ts`, `src/logger.test.ts`,
`src/run-snapshot.ts`, `src/status.ts`, `src/cli-options.ts`,
`src/orchestrator.ts`, the three entry points,
`src/cli-options.test.ts`, `src/cli-entries.test.ts`.

So the pair is not narrowed; it is inconsistent. As it stands the
acceptance-behaviors gate cannot be satisfied inside the declared file scope, and
a generator reading the manifest is still handed the four-body scope round 1
refused. P-04 and P-05 in the manifest carry the stale framing too — P-04's
`when` is still "the #277 refusal is deleted", and P-05 still asserts "no
recovery-attempt-state event is emitted", a claim about an event variant this
slice no longer adds.

Three findings stay open behind that single omission:

- **F-03** — the scope reduction itself. The contract is now a plausible single
  session: three additive exported seams, one optional persisted field, six
  paths, and an empty "Changes to existing behavior" section. Narrow the manifest
  to match and this closes.
- **F-02** — B-09 still imposes the wiring in the singular ("at the seam where
  the replacement pair reaches `LOCKED`"), so the pair now asserts one LOCKED
  seam and two at the same time.
- **F-06** — B-09's observable still carries the unbounded clause "the
  repository contains no refusal string naming an unshipped slice on this path",
  with no pattern and no path set.
- **F-04** (advisory) — B-08 still carries the dual `foldEvents` derivation whose
  invocation shape the explorer left UNKNOWN. Carry that question into slice 07's
  contract as its first thing to confirm.

## The single change that clears this round

Apply to `acceptance-manifest.json` the reduction already applied to
`contract.md`:

1. Remove B-06, B-07, B-08 and B-09 from `behaviors`.
2. Restate P-04 over the refusal *staying in force* — `when` becomes the seams
   being added while `src/cli-options.ts` goes unedited, and the observable cites
   the unchanged tests at `src/cli-options.test.ts:340-459,563-564`,
   `src/cli-entries.test.ts:79-84` and
   `src/preserve-work-recovery.test.ts:1594-1626` as passing untouched, matching
   the contract's P-04.
3. Restate P-05's observable over the unmodified launch path rather than over the
   absence of a `recovery-attempt-state` event.

No contract prose needs to change to clear this. One note if you touch B-04's
observable while you are in the file: "asserts `src/wave.ts` and
`src/orchestrator.ts` are absent from this slice's file scope" is an assertion
about the manifest rather than about the code — the contract's Definition of done
already covers the same ground more directly ("no file outside 'Files expected to
change' is edited"). Not blocking either way.
