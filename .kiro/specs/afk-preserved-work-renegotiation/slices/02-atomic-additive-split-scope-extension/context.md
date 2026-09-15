# Context: #278 — Atomic additive split-scope extension

Source: `gh issue view 278`. Parent PRD 9 (#276). Blocked by #335 (already merged
in this worktree, `git log`: `870ae0a feat(#335)`). Adds `--extend-scope
<selector-list>` to the recovery action built by #277/#332-#335
(`src/preserve-work-recovery.ts`).

## Files and current behavior

- FACT: `src/preserve-work-recovery.ts` is the recovery module. Its header
  narrates the #277/#332-#335 lineage and says "Reporting and dispatch
  wiring are #336's" (module header, ~L1-49).
- FACT: The extension-set concept already has a placeholder in persisted
  state. `PersistedRecoveryLineageEvent` in `src/run-state.ts` has an
  `extensions: string[]` field (`src/run-state.ts:293-297`) whose comment
  says it stays "[a]lways empty until `--extend-scope` ships (#278); present
  so a reader never has to tell 'no extensions' from 'this record predates
  extensions'". This is the field #278 must start populating.
- FACT: `admitStaleRenegotiation` (`src/preserve-work-recovery.ts:801-978`)
  writes the `PENDING` lineage event; the `extensions: []` literal is
  written at `:960` with a comment (`:957-960`) pinning it to `--extend-scope`
  (#278).
- FACT: `replayOutcome` (internal, `src/preserve-work-recovery.ts:745-779`)
  is the idempotent-replay/conflict comparator. A comment block (`:730-743`)
  states the extension set is currently compared as "the completed attempt
  admitted none" until #278 ships. It compares `completed.target.number`,
  `completed.target.ghIssue`, `completed.reason`, and
  `completed.extensions.length === 0` (`:756-759`) — #278 must extend this
  comparison to the full canonical set, per AC "replay is an idempotent
  no-op only for ... the complete canonical extension identity set."
- FACT: `RecoveryRefusalCode` (`src/preserve-work-recovery.ts:109-169`)
  already enumerates `replay-completed-no-op` (`:164`) and `replay-conflict`
  (`:169`) — the refusal vocabulary #278's replay-conflict path (differing
  target/reason/set) should extend or reuse.
- FACT: `completedReplacementFor` (internal, `src/preserve-work-recovery.ts:709-728`)
  finds which `COMPLETED` event a pair-on-disk belongs to, keyed by
  fingerprints rather than requested target.
- FACT: `completeRecoveryAttempt` (`src/preserve-work-recovery.ts:1813-1996`)
  is the writer of the `COMPLETED` event; it takes the ADR-0056 lock via
  `transactRunState` at `:1922` and rechecks the scope fingerprint against
  `current.scopeFingerprint` at `:1949-1965`. This is the single
  locked-read-modify-write the AC requires to also add the extension set to
  persisted scope "under the same run-state write."
- FACT: `canonicalizeRecoveryRequest` (`src/preserve-work-recovery.ts:211-241`)
  resolves a selector against `PersistedRunScope` and refuses
  `scope-absent`/`target-out-of-scope`/`selector-ambiguous`. A comment
  (`:203-209`) states it deliberately does **not** reuse
  `matchesSliceSelector` from `src/slice-selector.ts`, citing ADR 0065
  (corroboration before identity resolution). Any new resolver for
  `--extend-scope` selectors should follow the same non-reuse precedent, per
  FACT below on `matchesSliceSelector`.
- FACT: `runScopeFingerprint`/`encodeRunScopeFingerprintPayload`
  (`src/preserve-work-recovery.ts:252-263`, `:271-275`) compute the canonical
  scope fingerprint (SHA-256 over a canonical encoding) referenced throughout
  admission/completion/reconciliation.
- FACT: `isLegalRecoveryTransition`/`LEGAL_RECOVERY_TRANSITIONS`
  (`src/preserve-work-recovery.ts:286-312`) allow only
  `PENDING → COMPLETED | ROLLED_BACK | ROLLBACK_FAILED` and
  `ROLLBACK_FAILED → ROLLED_BACK`. #278 introduces no new lineage state
  (issue text: "The inherited terminal outcomes are `ROLLED_BACK` and
  fail-closed `ROLLBACK_FAILED`"), so this transition table is not expected
  to change.
- FACT: `src/cli-options.ts:120-141` defines
  `PipelineRuntimeOptions.renegotiateStale?: string`,
  `recoveryReason?: string`, `StaleRenegotiationRequest` (`:133-138`, single
  selector + reason — explicitly not a resolved identity, comment `:128-131`),
  and flag constants `RENEGOTIATE_STALE_FLAG = "--renegotiate-stale"` (`:140`),
  `RECOVERY_REASON_FLAG` (`:141`).
- FACT: `parseStaleRenegotiationRequest` (`src/cli-options.ts:163-223`)
  explicitly rejects comma-separated lists for `--renegotiate-stale`
  (`:196-208`, comment "one selector, not a comma-separated list") — the
  existing recovery target flag deliberately supports only one selector.
  `--extend-scope` needs its own list-parsing, separate from this function.
- FACT: `parseSliceIdList(args, flag)` (`src/cli-options.ts:293-315`) is the
  existing comma-separated selector-list parser, used today by
  `--force-restart`/`--resume-stuck` (call sites `:364-365`). It splits on
  commas and validates each part against `^\d+$`. This is numeric-slice-only
  — the issue's selector list must also accept GitHub-issue selectors, so
  `parseSliceIdList` is a precedent to model after, not a drop-in reuse.
- FACT: `parsePipelineRuntimeOptions` (`src/cli-options.ts:318-421`) calls
  `parseStaleRenegotiationRequest` at `:388`, then unconditionally throws at
  `:393-399` with a message that `--renegotiate-stale` is "refused until
  #335 lands." `git log -- src/preserve-work-recovery.ts` shows #335
  (`870ae0a`) already merged in this worktree. INFERENCE: this throw block is
  stale/dead code blocking any live `--renegotiate-stale` (and therefore any
  `--extend-scope`) invocation from `parsePipelineRuntimeOptions`; drawn from
  the throw text plus the merged #335 commit. Whether removing/updating it is
  in scope for #278 or a separate wiring slice (module header says
  "dispatch wiring is #336's") is an `UNKNOWN` (see Unknowns).
- FACT: `src/slice-selector.ts` (17 lines total) exports only
  `matchesSliceSelector(selectors, slice)` (`:6-17`), matching by exact
  `ghIssue`, exact `number` string, or `Number(value) === Number(slice.number)`.
  Confirmed not used by `preserve-work-recovery.ts` (per the `:203-209` comment
  above).
- FACT: `src/slice-scope.ts` defines `PersistedScopeSlice { number: string;
  ghIssue: string }` (`:4-7`) and `PersistedRunScope { mode; slices:
  PersistedScopeSlice[] }` (`:9-12`) — the shape #278's canonical additions
  (`{number, ghIssue}` per the issue body) must match.
- FACT: `resolveRunScope(slices, requested, persisted?)`
  (`src/slice-scope.ts:148-207`) is the canonical scope-resolution/narrowing
  function. A comment (`:140-146`) states the invariant: a re-run may only
  **narrow** persisted scope to a subset, never add; supersets/disjoint
  selections throw (`:164-176`). INFERENCE: because `--extend-scope` is a
  scope-*widening* recovery operation, it cannot go through
  `resolveRunScope`'s normal narrowing path — the extension set must reach
  persisted scope through a different write (the recovery completion write),
  consistent with the issue text "It is not persisted executable scope ...
  while recovery is unresolved" and "After the replacement lock succeeds ...
  add the whole set to persisted scope." Drawn from `resolveRunScope`'s
  narrow-only invariant plus the issue's completion-time scope-add
  requirement.
- FACT: `src/afk-manifest.ts` exports `canonicalSliceNumber(value)`
  (`:240-243`, normalizes e.g. `"2"`/`"02"` to the same key — directly
  relevant to the issue's "canonicalize its slice number" requirement) and
  `assertWithinManifestScope<T>(args)` (`:252-266`, the shared fail-closed
  gate for "is this slice selection within `afk.json`'s allowed set,"
  comment `:245-250` names `cli-run-scope.ts` and `runPipeline` as current
  callers). `loadAfkManifest(prdDir)` (`:269-273`) returns `null` when
  `afk.json` is absent (legacy mode) — relevant to the AC "exists ... is
  allowed by current `afk.json`."
- FACT: `src/issues-parser.ts` defines `Slice { number, ghIssue, title,
  type, blockedBy: string[], userStories, files? }` (`:3-20`); `blockedBy`
  holds raw GH-issue-id strings parsed from the "Blocked by" table column
  (`:62-69`). `buildDAG(slices)` (`:92-110`) computes `ready()` via
  `slice.blockedBy.every((dep) => completed.has(dep))` (`:103`), keyed by
  `ghIssue`. INFERENCE: the AC "every blocker already scoped or in the same
  extension set" requires comparing each addition's `Slice.blockedBy`
  entries (ghIssue strings) against the `ghIssue` field of both
  `PersistedRunScope.slices` and the candidate extension set — drawn from
  `blockedBy`'s type and `PersistedScopeSlice`'s `ghIssue` field.
- FACT: `withFileLock<T>(targetPath, action, options)`
  (`src/file-lock.ts:103-112`) is the ADR-0056 cross-process lock primitive;
  doc comment (`:97-102`) states run-state writers are synchronous and this
  extends the critical section across processes. `transactRunState` (used
  throughout `preserve-work-recovery.ts`, e.g. `:870`, `:922`, `:1591`,
  `:1922`) is presumably layered on it, imported from `run-state.ts`
  (`preserve-work-recovery.ts:83-92`) — not independently line-verified in
  this pass (see Unknowns).
- FACT: `src/scope-amendment.ts` (273 lines) is a **different** "scope":
  it widens a locked contract's *file* scope (`fileScope.paths` in
  `acceptance-manifest.json`) after a QA finding (ADR 0048), via
  `planScopeAmendment` (`:80-159`), `applyScopeAmendment` (`:173-205`),
  `appendContractScopeFiles` (`:217-255`). It is unrelated data
  (`fileScope.paths` vs. `PersistedRunScope.slices`) and unrelated callers
  (QA loop vs. recovery CLI) — not reusable machinery for #278, but the name
  collision ("scope amendment" vs. "extend scope") is worth flagging to avoid
  confusion in any design doc.

## Patterns and test harness

- FACT: `src/preserve-work-recovery.test.ts` is 3732 lines and imports
  `execFileSync`/`spawnSync` (`:15`), with a real subprocess spawn inside
  `describe("locked recheck against cross-process drift", ...)` (`:678`,
  spawn at `:696`) — this suite is comparatively heavy per CLAUDE.md's test
  loop discipline (real git processes cost real wall-clock).
- FACT: Existing `extensions: []` literals appear in fixtures at `:779`,
  `:942`, `:2432`, and are asserted `toEqual([])` at `:3381` — every current
  fixture hardcodes the empty extension set. New non-empty-`extensions`
  cases must extend these fixtures rather than introduce a new spawned
  scenario, per CLAUDE.md ("Where a new assertion goes") and the issue's own
  AC: "extend an existing persisted-scope fixture ... Add no unrelated
  spawned scenario."
- FACT: Relevant existing describe blocks in
  `src/preserve-work-recovery.test.ts`: `"canonical recovery request
  identity"` (`:311`), `"canonical scope fingerprint"` (`:392`), `"read-only
  eligibility"` (`:433`), `"admission commits exactly one PENDING event"`
  (`:763`), `"recovery lineage transitions"` (`:827`), `"the one COMPLETED
  append"` (`:3341`), `"a request that repeats a completed renegotiation"`
  (`:3705`), `"what completion and replay must not disturb"` (`:3855`).
  These are the most likely attachment points for new `it`s per the
  "prefer an `it` on an existing spawned scenario's shared result" ordering
  in CLAUDE.md.
- FACT: No standalone "persisted-scope fixture" file was found; scope
  fixtures are constructed inline in `src/preserve-work-recovery.test.ts`
  (no separate fixture file matched a Glob search for one).
- FACT: `src/scope-amendment.test.ts` exists as the companion test for the
  unrelated file-scope-amendment feature (see above) — not a fixture source
  for #278.
- FACT: Per ADR index summaries (pushed selection, not re-fetched in full
  except where cited): ADR 0018 (per-slice state persistence), ADR 0039
  (from-base restart never destroys unmerged commits), ADR 0055 (one
  contract-mutation transaction / durable replaceable park), ADR 0056 (one
  cross-process lock per run-state file), ADR 0060 (parser contracts declare
  regression surfaces) are the ADRs `ARCHITECTURE.md`'s Preserved-work
  recovery row cites as governing the module `src/preserve-work-recovery.ts`
  already implements; #278 extends that same module and inherits the same
  governing set.
- FACT: A grep across `docs/adr` for `fingerprint|canonical|extension
  set|scope resolution ignores` matched `docs/adr/0065-...md` (corroboration
  rule — an ID match resolves identity only when corroborated by a content
  fingerprint or other tiebreak; directly cited by
  `preserve-work-recovery.ts:203-209`) and `docs/adr/0055-...md` (lock
  provenance stamp, cited at `preserve-work-recovery.ts:1487`, `:1671-1678`,
  `:1843`), plus 0057, 0053, 0054, 0052, 0010, none of which are specifically
  about scope fingerprints or extension sets.
- INFERENCE: There is no ADR dedicated to scope fingerprints, canonical
  scope identity, or "extension sets" — those concepts exist only as inline
  design decisions inside `src/preserve-work-recovery.ts` and
  `src/run-state.ts`'s doc comments. Drawn from the grep in the prior bullet
  turning up no dedicated ADR despite the concepts being load-bearing in
  code already merged for #277/#332-#335.

## Unknowns

- UNKNOWN: Whether removing/updating the "refused until #335 lands" throw
  in `parsePipelineRuntimeOptions` (`src/cli-options.ts:393-399`) — which
  currently blocks any live `--renegotiate-stale` invocation even though
  #335 is merged — is in scope for #278, or belongs to #336 ("dispatch
  wiring," per the module header in `src/preserve-work-recovery.ts:49`).
- UNKNOWN: Exact signatures of `transactRunState`, `loadRunState`, and
  `appendRecoveryLineageEvent` in `src/run-state.ts` (imported by
  `preserve-work-recovery.ts:83-92` and used at multiple call sites, e.g.
  `:870`, `:922`, `:1591`, `:1922`) were not independently read line-by-line
  in this pass; their exact read-then-write contract (what "one locked
  read-modify-write" guarantees beyond `withFileLock`) is not yet confirmed
  from source.
- UNKNOWN: Whether any GitHub-issue-selector parsing precedent besides
  `parseSliceIdList` (numeric-only, `src/cli-options.ts:293-315`) and
  `matchesSliceSelector` (`src/slice-selector.ts:6-17`, deliberately unused
  by recovery) exists elsewhere in the CLI layer for mixed slice-number/
  GH-issue selector lists — no third parser was located.
- UNKNOWN: The exact current byte-for-byte shape of `RunState.scope`
  writes at the `COMPLETED`-event call site inside `completeRecoveryAttempt`
  (`src/preserve-work-recovery.ts:1813-1996`) — i.e., whether the function's
  existing return/side-effect already touches `state.scope` at all today, or
  only appends the lineage event — was not directly confirmed line-by-line;
  the exploration only located the lock acquisition (`:1922`) and the
  fingerprint recheck (`:1949-1965`), not a scope-array mutation.
