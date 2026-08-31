# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed the feature diff from merge base
`8f97ce6b34e5c268f159d7a48d3d28af83d4c542`, the slice contracts and
handoffs under `.kiro/specs/afk-v2-routing-adjudication/slices/`, and the
merged escalation, adjudication, contract-mutation, wave, journal, cleanup,
adoption, and preflight paths.

The pre-ship gate already passed this tree, so I did not rerun the full
suite. I read the source and ADR control flows directly, ran
`git diff --check`, and ran only the focused tests named below.

## Blocking findings

### 1. An adjudicated lane successor skips the lock gate after its base changes

- **File/location:** `src/wave.ts`, the adjudicated lane-successor refresh
  in `runWave` (lines 399-453); `src/orchestrator.ts`,
  `runImpasseAdjudication`'s proven-lock shortcut (lines 2297-2320).
- **Evidence gathered:** I traced the lane successor after its predecessor
  merges. `runWave` merges the new feature tip into the preserved successor
  worktree and calls `runSliceNegotiate`. The complete applied decision log
  makes `adjudicatedLockIsProven` return `LOCKED` immediately, before
  `ctx.onContractLocked` is consulted. I ran
  `pnpm vitest run src/wave.test.ts -t "keeps an adjudicated lane successor's decision and lock through refresh"`;
  it passed while exercising both proven-lock shortcuts around the feature-tip
  refresh. The test asserts estate preservation but never injects or observes
  a post-refresh lock objection.
- **Convention violated:** ADR 0028, **Why the gate is a callback**, requires
  the gate to cover lane-successor re-negotiation because the refreshed feature
  tip can introduce a migration-prefix collision. ADR 0055, **Seam 1 sections
  2-3**, permits `LOCKED` only through the mechanical gate.
- **Required fix:** Revalidate a proven adjudication lock against the current
  feature tip after lane refresh, before generation. Preserve the decision
  estate on refusal and add a focused test where the predecessor introduces a
  lock-gate objection.

### 2. Adoption can orphan a parked worktree and make the next launch refuse

- **File/location:** `src/adopt-command.ts`, `runAdoptCli` (lines 426-446 and
  546-589); `src/orchestrator.ts`, launch namespace construction (lines
  4730-4758); `src/preflight.ts`, leftover registered-worktree refusal (lines
  282-308).
- **Evidence gathered:** I read the complete adoption transition. It checks
  only whether the feature branch is checked out, never the selected slice's
  persisted phase or its registered slice worktree. Success moves the feature
  ref and overwrites the slice record with `PASS`, but does not remove or
  otherwise reconcile that worktree. The next run excludes completed slices
  from both `intended` and `retained`, so preflight classifies the still
  registered AFK worktree as unowned and refuses. I ran
  `pnpm vitest run src/preflight.test.ts -t "refuses a registered namespace worktree no live slice owns"`;
  it passed and confirms that terminal state. This is directly reachable when
  `afk adopt` is used on an `AWAITING-ADJUDICATION` slice.
- **Convention violated:** ADR 0055, **Seam 2 invariant and section 9**, says
  the parked estate survives every lifecycle operation except the slice's own
  re-dispatch and only that dispatch replaces the park. The current adoption
  path replaces the record without dispatch and strands the estate outside the
  lifecycle model.
- **Required fix:** Make adoption an explicit, fail-closed transition for
  parked slices. Either refuse it while the park owns a worktree, or quiesce and
  reconcile the whole estate so a successful adoption leaves no registered
  namespace worktree that blocks the next run. Cover adoption from persisted
  `AWAITING-ADJUDICATION` through the next launch.

### 3. QA scope amendment bypasses the new accepted-contract transaction

- **File/location:** `src/scope-amendment.ts`, `applyScopeAmendment` (lines
  173-205) and `appendContractScopeFiles` (lines 217-254);
  `src/orchestrator.ts`, the QA amendment caller (lines 3693-3744).
- **Evidence gathered:** I read the write order and caller. The amendment
  writes `acceptance-manifest.json` first, then calls a second function that can
  throw before writing `contract.md`; the caller has no capture/rollback
  boundary. The existing missing-section case at
  `src/scope-amendment.test.ts:233` exercises exactly that throw but does not
  assert restoration of the already-written manifest. I ran
  `pnpm vitest run src/scope-amendment.test.ts`; all 16 tests passed, confirming
  current coverage does not detect the split accepted pair. A contract write
  failure has the same result.
- **Convention violated:** ADR 0048, **Decision**, requires the orchestrator to
  keep the manifest and contract file list in sync and a refused amendment to
  leave the contract untouched. ADR 0055, **Seam 1 section 3**, says the shared
  capture/restore primitive is the only way the accepted pair is mutated. The
  new transaction abstraction omits this pre-existing third mutation path.
- **Required fix:** Route QA scope amendment through the shared accepted-pair
  transaction, or provide an equivalent atomic two-file rollback, and test
  failures after each write. The amendment archive should be committed only
  with a coherent pair.

## Architecture assessment

The shared adjudication transaction, full-blocker completion predicate,
replaceable park journal state, cleanup trait, and idle-only wait are otherwise
coherent. The findings above are structural boundary leaks: each bypasses an
invariant the new architecture claims to centralize.
