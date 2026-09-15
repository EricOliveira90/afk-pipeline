# Slice Contract — Atomic additive split-scope extension

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #278
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

`--extend-scope <selector-list>` becomes a real input to the preserved-work
recovery action built by #277/#332–#335: the CLI parses the comma-separated
selector list and refuses it without exactly one `--renegotiate-stale` target and
a non-blank `--recovery-reason`; a pure resolver turns the list into one canonical,
duplicate-free, sorted set of `{number, ghIssue}` identities and refuses the whole
set unless every member exists as an AFK slice in current `issues.md`, is allowed
by current `afk.json`, is absent from the persisted-scope view B-03 hands it, and
has every blocker already scoped or in the same set; replay detection runs before
that resolution, so a repeat against a completed attempt is answered by
`replayOutcome` rather than refused for the members that attempt itself added
(B-03, B-09); admission records the complete set only in the
`PENDING` lineage event, where it is inert data that scope resolution and DAG
construction never see; and `completeRecoveryAttempt`'s one ADR 0056-protected
`transactRunState` body revalidates that set and then publishes a single run-state
document that both appends `COMPLETED` and appends the whole set to
`state.scope.slices`. Every ending before that commit leaves persisted scope
byte-identical and goes through #333's verified rollback path. Replay identity
grows to include the complete canonical set. The persisted facts plus one pure
derivation let a reader tell a recovery-admitted scope member from an original
one; rendering that in `afk status`, the run summary and `events.jsonl` stays with
#336, which owns the reporting surface and states that "the scope-extension flag
stays out: `--extend-scope` is #278" (`gh issue view 336`).

### In scope

- [behavior:B-01] `src/cli-options.ts` gains one exported parser for
  `--extend-scope` and a `PipelineRuntimeOptions.extendScope?: string[]` field
  carrying the selectors as typed. Refusals, each with its own message: the flag
  present without `--renegotiate-stale` or without `--recovery-reason` (PRD
  "`--extend-scope` is valid only with the other two flags"), a second occurrence
  of `--extend-scope`, a value that is missing or starts with `--`, a
  comma-separated part that is not digits-only (the `parseSliceIdList` rule at
  `src/cli-options.ts:293-315`), and a literal duplicate selector inside the list
  (PRD "its members form one atomic, duplicate-free set"). The digits-only rule is
  the whole accepted selector language, and it already covers both selector kinds
  the PRD names: a canonical slice number (`canonicalSliceNumber`, zero padding
  preserved as typed) **and** a bare GitHub-issue id, because `issues.md` parsing
  stores `Slice.ghIssue` with the `#` already stripped
  (`cells[1].trim().replace("#", "")`, `src/issues-parser.ts:80`), so every issue
  id an extension member can resolve to is itself digits-only. Planner decision,
  recorded here because it is a mechanical spelling call inside this contract:
  `#278` and every other non-digit issue-id spelling is refused by the same
  digits-only message rather than accepted and normalized, so one selector string
  has exactly one meaning at the parser and the resolver never sees two spellings
  of one identity (the ADR 0065 reason B-02 already cites). A second planner decision,
  recorded here because it is a mechanical uniformity call inside this contract:
  one occurrence only, matching the one-occurrence discipline
  `parseStaleRenegotiationRequest` already enforces for the two recovery flags
  (`src/cli-options.ts:166-175`), rather than `parseSliceIdList`'s repeatable
  form. Like `renegotiateStale`/`recoveryReason` (`src/cli-options.ts:388-392`),
  the value is read out *before* #277's still-live guard, so the accepted case is
  observable on the exported parser (#277 B-12 precedent,
  `src/cli-options.ts:148-162`).
- [behavior:B-02] `src/preserve-work-recovery.ts` gains one exported pure
  resolver over `(selectors, a persisted-scope view, current `issues.md` slices,
  `AfkManifest | null`)` that returns either the canonical set or one refusal
  code. The scope argument is a *view* — the list of `{number, ghIssue}`
  identities the absent-from-scope and blocker-already-scoped checks are made
  against — and B-03 owns which view each call site supplies; the resolver itself
  never reads `RunState` and never decides the view. Each member resolves to
  `{ number: canonicalSliceNumber(slice.number),
  ghIssue: slice.ghIssue }` (`src/afk-manifest.ts:240-243`) and the set is sorted
  by canonical slice number, then GitHub issue, before it is stored or compared
  (PRD "Canonical request and scope identity"). New `RecoveryRefusalCode` members
  — one per distinguishable cause, per the code-not-prose rule at
  `src/preserve-work-recovery.ts:101-108` — cover, one named code each:
  `extension-slice-unknown` for a selector that matches no slice in current
  `issues.md`; `extension-slice-not-afk` for a slice declared `HITL` rather than
  `AFK` (`src/issues-parser.ts` `Slice.type`); `extension-outside-manifest` for a
  member outside `afk.json`'s `selectedSlices`; `extension-already-in-scope` for a
  member already present in the supplied scope view; `extension-identity-conflict`
  for two selectors resolving to one identity, or one digits-only selector matching
  one slice by number and another by issue id (both spellings being bare numerics
  per B-01, which is what makes that collision reachable); and
  `extension-blocker-unscoped` for a member whose `blockedBy` entry (raw GH-issue
  ids, `src/issues-parser.ts:62-69`) is neither in the supplied scope view nor in
  the same candidate set. The codes are named here rather than left to the
  generator because B-09 has to assert that a replay outcome is *not* one of them.
  The manifest check reuses `assertWithinManifestScope`
  (`src/afk-manifest.ts:252-266`) inside a `try`/`catch` that maps its throw to
  the refusal code, so the shared fail-closed comparison stays the one comparison
  every scope funnel makes; a `null` manifest is the documented legacy mode
  (`src/afk-manifest.ts:268-273`) and imposes no restriction. The resolver
  resolves selectors against `issues.md` and the supplied scope view directly and does not
  reuse `matchesSliceSelector`, following the ADR 0065 corroboration precedent
  recorded at `src/preserve-work-recovery.ts:203-209`.
- [behavior:B-03] Any invalid member refuses the whole set: the resolver is pure
  and writes nothing, and `admitStaleRenegotiation` calls it before it publishes a
  snapshot or takes the run-state lock, so an extension refusal is a
  pre-admission refusal that appends no lineage, publishes no snapshot, rewrites
  no accepted-pair byte and adds no scope (PRD Admission Protocol step 2, "No
  state changes on refusal"; Failure Matrix row "Eligibility, extension or
  snapshot refusal"). This slice inserts the resolver into the documented
  admission sequence (`src/preserve-work-recovery.ts:781-840`) at exactly one
  place, **after** replay detection, and states the order because B-09 depends on
  it: eligibility, then `attempt-already-pending`, then
  `completedReplacementFor` (`:709-728`, unmoved), and only then extension
  resolution — still before the branch-tip reads, the snapshot publication and the
  lock. Which scope view the resolver is handed follows from that position, and it
  is the same rule in both branches — *the persisted scope as it stood for this
  request's own admission*:
  - **Not a replay** (`completedReplacementFor` found nothing): the view is
    `state.scope.slices` as loaded. A refusal is the pre-admission refusal above,
    and `extension-already-in-scope` is the code for a member already recorded —
    this is the only branch that refusal can arise in.
  - **A replay** (the pair on disk is a completed attempt's replacement): the view
    is `state.scope.slices` **minus the identities that same trailing `COMPLETED`
    event records in its `extensions`** — the scope the completed attempt was
    admitted against, reconstructed from the lineage that recorded the additions
    rather than from a second stored copy (the B-10 argument). Every member the
    completed attempt itself added is therefore absent from the view and cannot
    draw `extension-already-in-scope`, so the resolved set reaches B-09's
    comparison and the request is answered as a replay. A replay whose selectors
    are malformed as *identities* — unknown, `HITL`, outside `afk.json`, colliding,
    or blocked by something in neither the view nor the set — still refuses with
    that member's code, because a request whose members do not resolve is not a
    repeat of anything.
  Planner decision, recorded here because it is a sequencing call inside this
  slice's contract and reversible before merge: the alternative — resolve first and
  teach `extension-already-in-scope` to defer to replay — was rejected because it
  would make one refusal code conditional on state the resolver deliberately does
  not read, and because the shipped sequence comment at `:781-800` already fixes
  replay as the step decided "before anything is published".
- [behavior:B-04] `PersistedRecoveryLineageEvent.extensions` becomes
  `{ number: string; ghIssue: string }[]` and `sanitizeRecoveryLineage`
  (`src/run-state.ts:1185-1293`) accepts an array of pairs with non-blank members
  and drops an event whose `extensions` holds anything else. `RUN_STATE_VERSION`
  stays `7` and no migration is added. Planner decision, recorded here because the
  field's own comment declares itself this slice's placeholder
  (`src/run-state.ts:292-297`) and every writer to date emits the literal `[]`
  (`src/preserve-work-recovery.ts:957-960`): no v7 file on disk can contain a
  non-empty `extensions` array, so widening the element type is compatible for
  every reachable historical document, and the PRD pins the identity as the
  resolved `{number, ghIssue}` pair, which a `string[]` cannot carry. This
  follows the additive-without-a-bump precedent the `COMPLETED` and
  `ROLLBACK_FAILED` members already set (`src/run-state.ts:315-356`).
- [behavior:B-05] `admitStaleRenegotiation` writes the complete canonical set
  into the `PENDING` event's `extensions` and nowhere else: it does not touch
  `state.scope`, and it changes no other run-state field. It takes the resolver's
  inputs as arguments and calls the resolver itself, so no caller can admit an
  unvalidated set; the scope view it passes is the one B-03's sequence fixes and is
  computed inside the function, so no caller can widen or narrow it (the
  injected-seam discipline of `RecoveryGitProbes`,
  `src/preserve-work-recovery.ts:314-327`). The locked recheck at
  `src/preserve-work-recovery.ts:887-950` additionally refuses with the existing
  `facts-changed-before-lock` code when the set no longer resolves to the same
  identities under the lock (PRD Admission Protocol step 5).
- [behavior:B-06] A `PENDING` attempt's additions are not executable:
  `resolveRunScope` and `buildDAG` read `state.scope` and `issues.md`, and this
  slice puts nothing new in either while the attempt is unresolved, so a run whose
  lineage carries a pending set resolves the same `members`, `selected` and
  `skipped` values — and the same `SliceSkipReason` strings — as the same fixture
  without it (PRD "Proposed additions are data in the `PENDING` record only;
  scope resolution and DAG construction ignore them").
- [behavior:B-07] Inside `completeRecoveryAttempt`'s single
  `transactRunState` body (`src/preserve-work-recovery.ts:1922-1978`), after the
  existing trailing-event and scope-fingerprint rechecks, the set read **from the
  trailing `PENDING` event** — never from a caller argument — is revalidated
  through B-02's resolver against the run state held under the lock, with
  `state.scope.slices` as loaded under that lock as the scope view — the plain view,
  never B-03's replay view, because a still-`PENDING` attempt has added nothing yet
  and B-08 appends the set in this same write. A member that
  became invalid or is now present in persisted scope is an admitted failure: the
  body returns `changed: false` and the completion ends through #333's
  `rollBackRecoveryAttempt` after the lock is released, using the existing
  `facts-changed-before-lock` code and the existing `completion-cas-lost` trigger
  (`src/preserve-work-recovery.ts:1422-1436`, `:1980-1995`). No new lineage state
  and no change to `LEGAL_RECOVERY_TRANSITIONS`
  (`src/preserve-work-recovery.ts:286-312`).
- [behavior:B-08] When the rechecks hold, that one locked read-modify-write
  publishes one run-state document that both appends the `COMPLETED` event
  (replacement fingerprints and lock provenance, unchanged from #335) and appends
  the whole set to `state.scope.slices` through one pure exported helper in
  `src/slice-scope.ts`. The helper preserves every existing entry and its order
  and appends the additions in canonical set order; `scope.mode` is unchanged. The
  atomicity obligation is stated as what this slice can observe: the completion path
  performs **exactly one** run-state write — one `transactRunState` call that
  returns `changed: true` once, with no second `transactRunState`, no `saveRunState`
  and no other scope writer anywhere on the path — and the single document that
  write publishes carries both the `COMPLETED` event and the whole set. There is no
  seam inside the transaction body to interleave, so "no document carries only one
  side" is proven structurally (one write, one reloaded document holding both
  halves) rather than by observing an intermediate document; the existing
  `beforeLockAcquired` seam proves the adjacent fact that a change landing before
  the lock publishes neither half. Every unrelated run-state field — other
  scope entries, slice PASS/failure records, resume counters, migration claims,
  review history — is carried forward untouched (PRD "Successful Completion and
  Scope Atomicity"; ADR 0056 one lock per run-state file). The additions do not
  reach persisted scope through `resolveRunScope`, whose narrow-only invariant
  (`src/slice-scope.ts:136-147`) is preserved.
- [behavior:B-09] Replay identity includes the complete canonical set:
  `replayOutcome` (`src/preserve-work-recovery.ts:745-779`) compares the
  completed event's `extensions` against the request's resolved set as values —
  same length, same sorted `{number, ghIssue}` members — and only an exact match
  of target, canonical reason and set is `replay-completed-no-op`. A partial
  overlap, a superset, a different identity set, a different target or a different
  reason is `replay-conflict`, and the message names the completed attempt (PRD
  "Replay and Conflicts"; the placeholder comparison at
  `src/preserve-work-recovery.ts:730-743` is what this replaces). Every one of those
  cases is reachable because B-03 resolves a replay's selectors against the
  pre-completion scope view, so the members the completed attempt added resolve
  instead of drawing `extension-already-in-scope`: `{2,3}` against a completed
  `{2,3}` is the no-op, and `{2}`, `{2,3,4}` and `{2,4}` are conflicts on set
  inequality. The reached replay answer is distinguishable from a resolver refusal
  by outcome shape and code, not by message text: the no-op is the
  `replayed: true` member of `AdmissionOutcome` carrying
  `code: "replay-completed-no-op"` and the completed `attemptId`
  (`src/preserve-work-recovery.ts:620-656`), the conflict carries
  `code: "replay-conflict"`, and neither is any `extension-*` code from B-02.
- [behavior:B-10] One exported pure derivation over a loaded `RunState` reports
  which persisted scope identities were admitted by a completed recovery attempt,
  by reading the `extensions` of trailing `COMPLETED` lineage events. No new
  persisted field marks provenance and `PersistedScopeSlice`
  (`src/slice-scope.ts:4-7`) is unchanged — planner decision recorded here because
  the PRD is silent on how an admitted member is marked and the lineage already
  records it, so a second copy of that fact could disagree with the first. This is
  the seam #336's reporting surface consumes; see the non-goal below.

### Non-goals (explicit out-of-scope)

- Rendering the distinction in `afk status`, the run summary or `events.jsonl`.
  #336 owns `src/run-events.ts`, `src/run-snapshot.ts` and `src/status.ts` for the
  recovery reporting surface and this slice does not edit them; it ships the
  persisted facts and B-10's derivation those readers need.
- Removing #277's entry-point refusal of `--renegotiate-stale`
  (`src/cli-options.ts:393-399`) or wiring the request path into `runPipeline` —
  explicitly #336's ("this slice removes that refusal", `gh issue view 336`).
- Any new recovery command, policy, lineage state or terminal outcome; the
  inherited unsuccessful endings stay `ROLLED_BACK` and fail-closed
  `ROLLBACK_FAILED`.
- Removing or reordering persisted scope identities, automatic scope growth, and
  more than one recovery target per invocation (PRD "Out of Scope").
- `src/scope-amendment.ts`, which widens a locked contract's `fileScope.paths`
  after a QA finding (ADR 0048) and shares nothing but the word "scope".
- Any new spawned pipeline scenario, and any slice-branch or feature-branch
  mutation.

### Existing behavior to preserve

- [behavior:P-01] `src/cli-options.ts:393-399` — the `--renegotiate-stale`
  refusal naming #335 still throws for every well-formed request, and
  `parseStaleRenegotiationRequest`'s existing messages and single-selector
  refusals (`src/cli-options.ts:163-223`) are unchanged.
- [behavior:P-02] `src/slice-scope.ts:resolveRunScope` — the narrow-only
  invariant and its superset/disjoint throw (`:164-176`), the persisted-scope
  restore rules, and every `SliceSkipReason` value (`hitl`, `not-selected`,
  `narrowed`, `:14-26`) are unchanged.
- [behavior:P-03] `src/preserve-work-recovery.ts` — no path, including every
  refusal and rollback path, invokes a merge, reset or rebase (ADR 0039, #277
  B-06), and `runScopeFingerprint`/`encodeRunScopeFingerprintPayload`
  (`:252-275`) remain the single encoder admission and completion share.
- [behavior:P-04] `src/preserve-work-recovery.ts:completeRecoveryAttempt` — the
  three preconditions (locked replacement pair, one `lockGate` call, non-blank
  provenance), the single lock acquisition, and the `COMPLETED` event's
  replacement-fingerprint and provenance members are unchanged; the scope write is
  added inside the existing transaction body, not as a second write.
- [behavior:P-05] `src/run-state.ts` — `RUN_STATE_VERSION` stays `7`,
  `appendRecoveryLineageEvent` stays append-only and state-taking (`:1307-1329`),
  and a v7 file whose recovery events carry `extensions: []` still loads with
  every event intact.

### Changes to existing behavior (only if the issue asks for it)

- `PersistedRecoveryLineageEvent.extensions` changes element type from `string` to
  `{ number, ghIssue }` and its sanitizer rule tightens to match (B-04),
  authorized by the issue's "Resolve each member to `{number, ghIssue}` …  before
  storage or comparison" and by the field's own placeholder comment naming #278
  (`src/run-state.ts:292-297`).
- `replayOutcome`'s extension comparison changes from "the completed attempt
  admitted none" to full canonical set equality (B-09), authorized by the issue's
  "replay is an idempotent no-op only for … the complete canonical extension
  identity set" and by the comment reserving the change for #278
  (`src/preserve-work-recovery.ts:740-743`).
- `admitStaleRenegotiation` and `completeRecoveryAttempt` gain the arguments B-02's
  resolver needs (`issues.md` slices and the loaded `AfkManifest | null`);
  existing callers pass no extension selectors and keep their current behavior
  with an empty set.

## Files expected to change

- src/cli-options.ts
- src/cli-options.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/slice-scope.ts
- src/slice-scope.test.ts
- src/preserve-work-recovery.ts
- src/preserve-work-recovery.test.ts

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- No new dependency and no new pattern: the resolver is a pure function behind an
  injected argument (the `RecoveryGitProbes` precedent), the scope append is a
  pure function beside `PersistedRunScope`, and the completion write reuses the
  existing `transactRunState` body.
- One schema shape change without a version bump: `extensions` carries
  `{ number, ghIssue }` pairs (B-04).

## Test plan

- Given `--extend-scope 12` with no `--renegotiate-stale`, or with
  `--renegotiate-stale 7` but no `--recovery-reason`, when the exported parser
  runs, then each case throws its own message naming the missing flag; given
  `--extend-scope 12,12`, `--extend-scope 12 --extend-scope 13`,
  `--extend-scope 12,x`, `--extend-scope 12,#278` or `--extend-scope` with no
  value, then each throws.
- Given a valid trio whose list mixes a canonical slice number and a bare
  GitHub-issue id (`--extend-scope 03,278`), when the exported parser runs, then
  both parts are accepted and returned as typed — the newly accepted issue-id
  spelling B-01 declares, next to the rejected `#278` and `x` parts above.
- Given a valid trio, when the exported parser runs, then it returns the
  selectors in order; and given the same argv, when
  `parsePipelineRuntimeOptions` runs, then #277's unchanged refusal still throws
  (P-01).
- Given selectors naming an unknown slice, a `HITL` slice, a slice outside
  `afk.json`, a slice already in the supplied scope view, two selectors resolving to
  one identity, one selector matching one slice by number and another by issue id,
  and a slice whose blocker is neither in the view nor in the set, when the resolver
  runs, then each returns its own distinct `extension-*` code
  (`extension-slice-unknown`, `extension-slice-not-afk`,
  `extension-outside-manifest`, `extension-already-in-scope`,
  `extension-identity-conflict`, `extension-blocker-unscoped`) and no run-state
  file, snapshot directory or accepted-pair byte changes.
- Given selectors `"03"` and `"2"` for slices whose canonical numbers are `3` and
  `2`, when the resolver runs, then the set is `[{number:"2",…},{number:"3",…}]`
  in that order, and a member whose only blocker is another member of the same set
  is admitted.
- Given a `PENDING` admission with a two-member set, when it commits, then the
  event's `extensions` holds both sorted pairs, `state.scope` is byte-identical to
  before, and no other run-state field changed; and when the run state is
  reloaded, then `sanitizeRecoveryLineage` keeps the event, while an event whose
  `extensions` holds a bare string or a pair with a blank member is dropped.
- Given an existing persisted-scope fixture extended with a `PENDING` attempt
  carrying two additions, when `resolveRunScope` and `buildDAG` run, then
  `members`, `selected`, `skipped` and every skip reason equal the same fixture
  without the attempt (B-06).
- Given that same attempt, when completion runs with a valid locked replacement
  pair, an admitting lock gate and a non-blank provenance, then one run-state
  document contains both the `COMPLETED` event and both additions appended after
  the existing scope entries in canonical order, `scope.mode`, every prior scope
  entry, slice records, resume counters, migration claims and review history are
  unchanged, and the DAG built afterwards holds each addition until its declared
  blockers complete.
- Given an addition that is deleted from `issues.md`, disallowed by `afk.json`, or
  already present in persisted scope by the time completion takes the lock, when
  completion runs, then no `COMPLETED` event is appended, persisted scope is
  byte-identical, and the attempt ends through `rollBackRecoveryAttempt` with
  `facts-changed-before-lock` and the `completion-cas-lost` trigger.
- Given the same completion, when the run-state writers it reaches are counted,
  then it performs exactly one `transactRunState` call, that call returns
  `changed: true` once, and the module declares no other run-state or scope write on
  the completion path — the single-write, single-document evidence B-08 rests its
  atomicity claim on.
- Given a completion interrupted at the `beforeLockAcquired` seam by a
  `PENDING`-clearing interleave, when it resumes, then run state holds no addition
  and no `COMPLETED` event — the adjacent fact that a change landing before the lock
  publishes neither half, not an observation of a partial document.
- Given a completed attempt whose replacement pair is still on disk and whose set
  is `{2,3}`, when the same target and reason are repeated with `{2,3}`, then the
  outcome is `replay-completed-no-op`; and with `{2}`, `{2,3,4}`, `{2,4}`, a
  different reason or a different target, then it is `replay-conflict` naming the
  completed attempt. Each case additionally asserts the returned `code` is one of
  those two replay codes and no `extension-*` code, proving B-03's ordering and the
  pre-completion scope view rather than an already-in-scope refusal answered the
  request; and given a replay whose extra member does not resolve at all (deleted
  from `issues.md`), then the code is `extension-slice-unknown`.
- Given run state with one `COMPLETED` attempt that added two identities and one
  `ROLLED_BACK` attempt that proposed a third, when the derivation runs, then it
  reports exactly the two completed identities.

## Definition of done

- [ ] `--extend-scope` parses and refuses exactly as B-01 states, and its
  accepted value reaches `PipelineRuntimeOptions.extendScope` before #277's
  unchanged guard.
- [ ] One pure exported resolver produces the canonical sorted set and one
  distinct refusal code per invalid-member cause, with no state change on refusal.
- [ ] `PersistedRecoveryLineageEvent.extensions` carries `{number, ghIssue}`
  pairs, the sanitizer enforces that shape, and `RUN_STATE_VERSION` is still 7.
- [ ] Admission records the complete set only in the `PENDING` event, and an
  existing persisted-scope fixture proves a pending set is invisible to
  `resolveRunScope`, `buildDAG` and every skip reason.
- [ ] One locked read-modify-write inside `completeRecoveryAttempt` publishes both
  the `COMPLETED` event and the whole set in persisted scope, preserving every
  unrelated field; a test proves the completion path makes exactly one
  `changed: true` run-state write and that the one document it publishes holds both
  halves.
- [ ] Every failure or interruption before that commit leaves persisted scope
  byte-identical and ends the attempt through #333's rollback writer.
- [ ] Replay detection runs before extension resolution, a replay resolves against
  the pre-completion scope view, and replay is a no-op only for the exact target,
  reason and complete set; partial, superset and differing sets are
  `replay-conflict` naming the completed attempt, never an `extension-*` refusal.
- [ ] One pure derivation reports the recovery-admitted scope identities, and no
  file in #336's reporting surface is edited.
- [ ] No new spawned pipeline scenario is added, and this slice's declared gates are
  the evidence: `typecheck` (`pnpm run typecheck`), `acceptance:behaviors` for every
  behavior id in this slice's manifest, and the `tests` gate (`pnpm run test`) every
  behavior row binds — the same three ids the manifest declares, so the bar here and
  the gates there are one story. The slice agent runs `typecheck` plus the test files
  in this slice's file scope; the `tests` gate is the pipeline's own (evaluator-qa
  and the pre-ship gate), not a third full-suite run inside the slice
  (`CLAUDE.md` "Test loop discipline").
