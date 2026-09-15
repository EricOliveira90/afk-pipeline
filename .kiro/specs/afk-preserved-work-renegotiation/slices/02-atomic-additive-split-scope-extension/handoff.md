# Slice 02 — Atomic additive split scope extension (#278)

## What shipped

- B-01: `src/cli-options.ts:parseScopeExtensionSelectors` (and
  `PipelineRuntimeOptions.extendScope`, `EXTEND_SCOPE_FLAG`, read from
  `parsePipelineRuntimeOptions`)
- B-02: `src/preserve-work-recovery.ts:resolveScopeExtensions` (with
  `ResolveScopeExtensionsArgs`, `ResolveScopeExtensionsResult`,
  `ScopeExtensionRefusalCode` and the six `extension-*` members of
  `RecoveryRefusalCode`)
- B-03: `src/preserve-work-recovery.ts:admitStaleRenegotiation` (the resolver
  call after replay detection and before the snapshot) and
  `src/preserve-work-recovery.ts:extensionScopeView`
- B-04: `src/run-state.ts:PersistedRecoveryLineageEvent.extensions` and
  `src/run-state.ts:sanitizeRecoveryLineage`
- B-05: `src/preserve-work-recovery.ts:admitStaleRenegotiation` (the `PENDING`
  event's `extensions`, and the locked recheck that re-resolves the set)
- B-06: `src/slice-scope.ts:resolveRunScope` (unchanged, and read by
  `src/preserve-work-recovery.test.ts` against a `PENDING` proposal)
- B-07: `src/preserve-work-recovery.ts:completeRecoveryAttempt` (the
  revalidation inside the locked body, refusing `casLost`)
- B-08: `src/slice-scope.ts:appendScopeExtensions` and
  `src/preserve-work-recovery.ts:completeRecoveryAttempt` (the one
  `transactRunState` body that appends the `COMPLETED` event and assigns
  `locked.scope`)
- B-09: `src/preserve-work-recovery.ts:replayOutcome` and
  `src/preserve-work-recovery.ts:sameScopeExtensions`
- B-10: `src/preserve-work-recovery.ts:recoveryAdmittedScopeExtensions`
- P-01: `src/cli-options.ts:parseStaleRenegotiationRequest`
- P-02: `src/slice-scope.ts:resolveRunScope`
- P-03: `src/preserve-work-recovery.ts:encodeRunScopeFingerprintPayload` and
  `src/preserve-work-recovery.ts:runScopeFingerprint`
- P-04: `src/preserve-work-recovery.ts:completeRecoveryAttempt`
- P-05: `src/run-state.ts:sanitizeRecoveryLineage` (`RUN_STATE_VERSION`
  unchanged at 7)

## Decisions made during implementation

- The resolver takes every fact it needs as an argument (`selectors`, `view`,
  `slices`, `manifest`) and never reads `RunState`. It is called at three
  moments — pre-lock admission, the locked admission recheck, the locked
  completion revalidation — and a resolver that read state would have three
  answers with no way to say which was authoritative. It also makes the whole
  resolver unit-testable without a fixture repo.
- Which scope view the resolver is judged against is the *call site's*
  decision, not the resolver's (`extensionScopeView`). An ordinary admission
  supplies the persisted scope as loaded; a repeat against a completed attempt
  supplies it minus the identities that same attempt added. Without the
  subtraction, every replay of a request that added anything would refuse
  `extension-already-in-scope` and never reach the replay comparison at all.
  The subtraction is reconstructed from the lineage, not from a second stored
  copy, for the same reason B-10 is a derivation.
- The completion reads the addition set from the trailing `PENDING` event
  (`const additions = current.extensions;`) and takes no set from the caller.
  The caller supplies only the facts the set is revalidated *against*
  (`args.slices`, `args.afkManifest`), so no caller can widen scope by more
  than the admission recorded. `CompleteRecoveryAttemptArgs` gained exactly
  those two optional fields.
- `appendScopeExtensions` lives in `src/slice-scope.ts`, not in the recovery
  module: that file owns what a persisted scope is, so the shape of the one
  widening a scope can undergo is reviewable beside `resolveRunScope`'s
  narrow-only rule instead of inside a transaction body. It is pure, so the
  locked completion needs no second writer — the terminal event and the
  widened scope are one `transactRunState` body with one `changed: true`.
- Refusals are one stable code per distinguishable cause, checked per member
  cheapest-first (unknown → not-`AFK` → colliding → already scoped → outside
  the manifest), with the blocker check last because it is the one question
  that cannot be answered until the whole candidate set is known. A member
  whose only blocker is another member of the same set resolves: the set
  enters scope together.
- `assertWithinManifestScope` is reused for the `afk.json` comparison rather
  than restated, so an extension is checked against the same reservation a
  launch checks. A `null` manifest is the documented legacy mode and restricts
  nothing.
- `PersistedScopeSlice` was reused for the event's `extensions` instead of a
  new shape, and no per-entry provenance member was added: the event that
  authorized a widening is already the record of it, and a second field could
  contradict a hand-edited scope. B-10 derives the admitted identities from
  the trailing `COMPLETED` events.
- The replay comparison compares the sets member for member, both sides
  canonical, so a partial overlap, a superset and a different set of the same
  size are all `replay-conflict` rather than near-enough matches. The conflict
  message names both sets so an operator can see which member differs.
- No new spawned pipeline scenario: every `#278` assertion runs on the
  existing `preserve-work-recovery.test.ts` fixture through the exported
  seams, which is why `slices`/`afkManifest` are arguments rather than an
  `issues.md` read.

## Gotchas / learnings

- The fixture has no `issues.md` at all, so the declared-slice list and the
  manifest must be passed as arguments in every extension test. That is also
  the drift lever B-05 and B-07 need: mutating the passed `slices` array
  inside `beforeLockAcquired` makes the locked re-resolve refuse
  `extension-slice-unknown` without moving the scope fingerprint. Planting a
  widened scope instead trips the *earlier* scope-fingerprint recheck — same
  code (`facts-changed-before-lock`) and same trigger
  (`completion-cas-lost`), but a different message — because putting an
  addition in scope is itself a scope change.
- `hasOpenRecoveryAttempt` is checked before replay detection in
  `admitStaleRenegotiation`, so a test that plants a completed attempt on a
  *different* target cannot leave a `PENDING` event on the fixture target; the
  working shape is to complete a real attempt and then re-key its lineage
  entry.
- One bare-numeric `--extend-scope` selector can match one slice by its number
  and a second by its issue id (`"9"` matching slice 09 and issue #9). That
  names no single slice, so it is `extension-identity-conflict` rather than an
  ambiguity resolved by precedence — worth knowing before adding a precedence
  rule that looks like a simplification.
- `matchesSliceSelector` is deliberately not reused, for the same reason
  `canonicalizeRecoveryRequest` does not reuse it: a second differently-shaped
  normalization of one identity is how two callers come to disagree about
  which slice was named.
- `sanitizeRecoveryLineage` drops a whole event whose `extensions` list holds
  any malformed pair rather than filtering the pair out. A partially-kept set
  would be a set nobody admitted, and the event is what authorizes the
  widening.
- On this host `pnpm test:fast` emits `[vitest-worker]: Timeout calling
  "onTaskUpdate"` under load. It is reporter-transport noise (`vitest.config.ts`
  documents it), not a test failure.
