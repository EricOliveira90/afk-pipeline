# Slice Contract — Preserve-work recovery admission

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #277
**Status:** LOCKED

**Lock-Provenance:** focused-scope-revision round 4

**Negotiation round:** 2

## Scope lock

Ship the admission half of the preserve-work recovery protocol and nothing
else: the two new flags on the shared runtime options parser and the exported
request helper it validates them through, the canonical
request/scope identity helpers, the SHA-256 scope-fingerprint encoder, the
read-only git and run-state eligibility predicates, the immutable byte-verified
snapshot of the target's accepted pair, and — under the ADR 0056 run-state lock,
after a recheck of the facts the snapshot was built from — one appended
`PENDING` recovery-lineage event, which is the first admitted mutation on disk.
The persisted lineage shape and its transition validator ship here; the writers
of every terminal event do not. Because verified rollback (#333) and launch-time
reconciliation (#334) are unshipped, the shared parser refuses a well-formed
`--renegotiate-stale` request with a message naming #335 before any eligibility
check, so no live run can create a `PENDING` event (issue #277, "First, the
entry points refuse the flag until #335 lands"; prd.md:35-40). The whole slice is
proven through exported seams plus one cross-process contention test; it adds no
spawned pipeline scenario. The additive schema bump's version pins outside
`src/run-state.test.ts` are updated in place — one literal each in
`src/eval-boundary.test.ts`, `src/qa-orchestration.test.ts` and
`src/qa-orchestration-gates.test.ts` — which adds no spawned scenario and
changes no scenario's structure, name or asserted properties (B-10).

### In scope

- [behavior:B-01] One new exported helper in `src/cli-options.ts`,
  `parseStaleRenegotiationRequest(args)`, is the seam that observably accepts
  the request: given a well-formed `--renegotiate-stale <slice|ghIssue>` with
  exactly one selector it *returns* a request value carrying that selector and
  the accepted `--recovery-reason` text, and
  it refuses a comma-separated selector list, a duplicate selector inside one
  value, and a second occurrence of the flag with three distinct messages;
  `parsePipelineRuntimeOptions` (`src/cli-options.ts:210`) calls the helper
  before the B-12 guard, so those three refusals are observable on the parser
  too (issue #277 AC1; prd.md:54-60). Recorded decisions: the accepted-input
  assertion is made against the helper's return value rather than the parser's,
  because the parser throws the #335 refusal on every well-formed pair (B-12) —
  so exactly one function has an accepted return and exactly one has the
  refusal, and #335's change stays "delete one guard" without changing what the
  helper returns. The selector value is validated with the single-token
  discipline of `optionValue` (`src/cli-options.ts:117-125`) rather than
  `parseSliceIdList` (`src/cli-options.ts:185-207`), because a list is a
  refusal here, not an input; the whole-args duplicate scan `parseSliceIdList`
  performs is reused only to detect a second occurrence.
- [behavior:B-02] `--recovery-reason <text>` is required, non-blank and
  single-occurrence: a missing, blank or repeated value is refused with a
  distinct message, and either flag without the other is refused (issue #277
  AC2; prd.md:60-63). Recorded decision: the required-together refusal follows
  the `--preview-verify-command` / `--preview-apply-command` precedent at
  `src/cli-options.ts:272-276` — each flag parsed independently, then one
  paired-presence check.
- [behavior:B-03] One exported canonicalizer produces the canonical request:
  the reason is the CLI value after ECMAScript `String.prototype.trim()` with
  no case folding, whitespace collapse or Unicode normalization, and a resolved
  identity is the pair `{number, ghIssue}` whose `number` comes from
  `canonicalSliceNumber` (`src/afk-manifest.ts:240-243`) (issue #277 AC4-AC5;
  prd.md:107-113). Recorded decision: admission does not reuse
  `matchesSliceSelector` (`src/slice-selector.ts:6-17`), whose inline
  `Number(...)` comparison is a second, differently-shaped normalization; the
  selector resolves against the persisted scope entries and their canonical
  numbers, which is the corroboration ADR 0065 requires before an ID match
  resolves identity.
- [behavior:B-04] One exported encoder produces the scope fingerprint as
  SHA-256 over UTF-8 JSON with no insignificant whitespace and exactly the
  shape `{"mode":<mode>,"slices":[{"number":<canonical>,"ghIssue":<id>}]}`, in
  the persisted scope order and the shown key order, over `RunState.scope`
  (`src/run-state.ts:273`, `PersistedRunScope` at `src/slice-scope.ts:9-12`)
  (issue #277 AC6; prd.md:114-118). Recorded decision: the key order is emitted
  explicitly by the encoder rather than inherited from an object literal as in
  `decisionSetFingerprint` (`src/adjudication.ts:418-424`), and the encoder is
  exported so the completion slice (#335) calls the same one.
- [behavior:B-05] Read-only eligibility refuses unless the target is in the
  persisted run scope, has a recorded slice branch and a registered worktree at
  it, has a clean worktree, has commits ahead of the feature branch, has a
  slice branch already containing the exact current feature-branch head, and
  holds a valid locked accepted pair; a run with no persisted scope is refused;
  each refusal is distinguishable by a stable reason code (issue #277 AC7-AC8;
  prd.md:69-75). Recorded decisions: the scope of record is `RunState.scope`,
  not a re-read of `afk.json` (whose `issues.md` / `afk.json` revalidation is
  step 2, deferred to #278 by prd.md:33); the recorded slice branch is
  `PersistedSliceState.branch` (`src/run-state.ts:33`) and its absence is its
  own refusal reason; worktree and feature-branch names resolve through
  `src/run-identity.ts:16-50` rather than re-derived strings; and the
  predicates are composed inside the new recovery module from the already
  exported `hasUncommittedChanges`, `countCommitsAhead` and `isAncestor`
  (`src/git.ts:476`, `:683`, `:1446`), leaving `src/git.ts` and
  `src/worktree-processes.ts` unmodified (issue #277, "Where the git-side
  eligibility predicates land").
- [behavior:B-06] No admission, refusal, snapshot or lock path in the new
  recovery module invokes a git merge, reset or rebase, and the paths the tests
  exercise leave the slice-branch and feature-branch tips unmoved (issue #277
  AC9; prd.md:74-75, ADR 0039).
- [behavior:B-07] The snapshot copies the exact `contract.md` and
  `acceptance-manifest.json` bytes into a new directory beneath the target's
  artifact directory, written through a temporary sibling and published
  atomically only after both files' presence, SHA-256 fingerprints and
  locked-pair validation (`src/acceptance-manifest.ts:290-296`,
  `src/contract-review.ts:529-530`) agree with the source; a published snapshot
  directory is never overwritten, and a snapshot no `PENDING` event references
  grants no recovery authority (issue #277 AC10-AC11; prd.md:80-86, ADR 0055).
- [behavior:B-08] Admission acquires the ADR 0056 run-state lock through
  `transactRunState` (`src/run-state.ts:545-557`), reloads run state inside it,
  and rechecks the accepted pair, clean worktree, slice head, feature head,
  active attempt, request identity and canonical scope fingerprint against the
  facts the snapshot was built from; any mismatch is a pre-admission refusal
  that appends no lineage, changes no accepted-pair byte and leaves the
  published snapshot inert (issue #277 AC12; prd.md:88-94). Recorded decision:
  the between-publication-and-lock interleave is driven by an optional
  `beforeLockAcquired?: () => void` seam on the new module's own exported
  admission entry point, invoked after the snapshot is published and before
  `transactRunState` is called; the contention test supplies it and runs the
  mutating child process to completion inside it. `withRunStateLock`
  (`src/run-state.ts:516-522`), `transactRunState` (`:545-557`) and
  `withFileLock`'s `afterLockPublished` (`src/file-lock.ts:109-110`) keep their
  current signatures and behavior, because threading a seam through the shared
  run-state lock would change a primitive every other run-state writer calls and
  would put `src/file-lock.ts` in scope; the interleave being proven is
  "the facts changed after the snapshot and before this process held the lock",
  which the module-level seam reproduces exactly.
- [behavior:B-09] On a clean recheck the first mutation on disk is one appended
  `PENDING` event carrying attempt ID, target identity, canonical reason, empty
  extension set, provider name, slice branch, slice head, feature head, scope
  fingerprint, snapshot locator and original pair fingerprints; while a
  target's last lineage event is `PENDING`, a second admission for that target
  is refused (issue #277 AC13, AC17; prd.md:94-98, 133-136). Recorded
  decisions: the extension set is always the empty array because `--extend-scope`
  is #278 (prd.md:33); and the provider name is supplied by the caller's run
  identity (`src/run-identity.ts:23-36`), since run state persists no provider
  field.
- [behavior:B-10] Recovery lineage persists as one new optional `RunState`
  field, additive under ADR 0018's pattern: the version literal at
  `src/run-state.ts:76` is 7 and its change is documented in the same
  running comment block above it (`:50-75`); a `sanitize`-style reader degrades
  malformed data to `undefined`, `adaptLoadedState` (`src/run-state.ts:1022`)
  wires it, and the field is read and written only through focused APIs that go
  through the run-state transaction (issue #277 AC14; prd.md:122-126, ADR 0018).
  Recorded decision: three assertions of that version pin the literal outside
  `src/run-state.test.ts`, and the same change moves each from 6 to 7 — PRD 7's
  boundary test at `src/eval-boundary.test.ts:127`, inside `P-05 ... leaves both
  schema versions alone`, and two that read the version off a loaded state as a
  bare `6` rather than importing `RUN_STATE_VERSION`:
  `src/qa-orchestration.test.ts:1028` (`expect(state.version).toBe(6)`) and
  `src/qa-orchestration-gates.test.ts:1043` (`expect(bumped.version).toBe(6)`).
  The earlier round's survey searched importers of `RUN_STATE_VERSION` and so
  missed those two; the tests gate reports them as `expected 7 to be 6`, and
  because this behavior already decided the literal is 7, no edit inside the
  earlier file scope can make them pass. Each is one literal per file with
  nothing else in either file touched: the properties those two scenarios lock —
  the #91 approved-baseline locator and the #193 applied waivers still loading
  unchanged across an additive bump — are exactly what an additive v7 bump must
  keep true, so updating the expected version preserves the assertion instead of
  weakening it, and each test's name, structure and every other expectation stay
  as they are. The eval-boundary assertion likewise keeps the property PRD 7
  locked, that an eval run writes no run state; the precedent for moving a pin
  with the bump is that the same pin already moved when an earlier bump landed
  (that slice's own manifest still reads `RUN_STATE_VERSION
  still 5`, `.kiro/specs/afk-v2-agent-eval-harness/slices/01-eval-runner/acceptance-manifest.json`).
  No eval-boundary rule, forbidden-import list, module set or events-schema pin
  changes, and `EVENTS_SCHEMA_VERSION` stays 1.
- [behavior:B-11] The exported transition validator accepts only
  `PENDING -> COMPLETED`, `PENDING -> ROLLED_BACK` and
  `PENDING -> ROLLBACK_FAILED -> ROLLED_BACK`, refusing every other transition
  including any return to `PENDING`; the writers append and never edit or
  delete an event, so a retry is always a new attempt ID (issue #277 AC16;
  prd.md:127-149).
- [behavior:B-12] While #333-#335 are unshipped, `parsePipelineRuntimeOptions`
  itself throws for a well-formed `--renegotiate-stale` request — the same input
  B-01's helper returns a request value for — with a message naming #335, so all
  three entry points refuse before any eligibility check, snapshot or lock
  acquisition (issue #277 AC15; prd.md:35-40). Recorded decision: the refusal
  fires after `parseStaleRenegotiationRequest` has validated the flags, so
  B-01/B-02 messages are already the behavior that survives #335 and #335's
  change is deleting one guard in the parser while the helper is untouched; the
  guard lives in the shared `parsePipelineRuntimeOptions`, which is what all
  three entries call, and no entry file is modified or advertises an unusable
  flag in its `usage()` text.

### Non-goals (explicit out-of-scope)

- Admission Protocol step 2 and `--extend-scope` parsing or validation — #278
  (prd.md:33, 76-79).
- Attempt execution: reopening the pair, preserving or clearing live
  negotiation state, rerunning explorer or planner/evaluator — #332
  (prd.md:29, 151-175).
- Verified restore, `ROLLED_BACK`, `ROLLBACK_FAILED` and the fail-closed
  dispatch hold — #333 (prd.md:30, 182-187).
- Launch-time reconciliation of an unresolved attempt before ordinary resume —
  #334 (prd.md:31, 189-195).
- Completion transaction, pre-dispatch fingerprint check, replay idempotence,
  run-event or run-summary reporting of attempt state — #335 (prd.md:32,
  197-232).
- Blocking ordinary resume or generator dispatch on a `PENDING` attempt beyond
  refusing a second admission for the same target.
- Any change to `src/git.ts`, `src/worktree-processes.ts`, `src/orchestrator.ts`
  or `src/wave.ts`, any spawned pipeline scenario, and any automatic
  stale-contract detection (issue #277; prd.md:255-266).
- `src/scope-amendment.ts`'s contract file-scope amendment is a different
  mechanism and is not touched.

### Existing behavior to preserve

- [behavior:P-01] Every existing flag `parsePipelineRuntimeOptions`
  (`src/cli-options.ts:210-301`) parses keeps its current parsing behavior and
  error text, including `optionValue`'s `` `${flag} requires a value` ``
  (`:117-125`) and the paired preview-command message (`:272-276`) (issue #277
  AC3).
- [behavior:P-02] A launch that passes neither new flag behaves exactly as it
  does today: no new check runs, no refusal is raised, no new output is
  produced, and the parsed options carry the new members as `undefined` (issue
  #277 AC18).
- [behavior:P-03] Run-state readers keep loading every currently supported
  earlier version without loss through `adaptLoadedState`
  (`src/run-state.ts:1022-1147`), and a state file with no recovery lineage
  round-trips unchanged apart from the version stamp `writeRunState`
  (`:524-536`) already applies (issue #277 AC14 second half; ADR 0018).
- [behavior:P-04] The lineage writer preserves every unrelated run-state field
  — resume counters, slice outcomes, migrations, guardian history, quality
  stages and every other slice's fields — because it mutates only through
  `transactRunState` (`src/run-state.ts:545-557`) (prd.md:167-169, 208-210).
- [behavior:P-05] `src/git.ts` and `src/worktree-processes.ts` are unmodified:
  the eligibility predicates consume their already exported primitives at their
  current signatures, so no existing git helper's signature or behavior changes
  (issue #277, "Where the git-side eligibility predicates land"). The assertion
  a `P-05` test makes is that the new module reaches git behavior only through
  the already-exported `hasUncommittedChanges`, `countCommitsAhead` and
  `isAncestor` (`src/git.ts:476`, `:683`, `:1446`) called with their existing
  signatures — stubbing exactly those three flips every eligibility outcome the
  predicates produce, and no other `src/git.ts` or `src/worktree-processes.ts`
  export is invoked. Recorded decision: `vitest --testNamePattern P-05` also
  selects PRD 7's unrelated `P-05` test in `src/eval-boundary.test.ts`, which is
  in scope for the B-10 pin update; both tests must be green for this behavior's
  acceptance evidence, and neither is renamed.

### Changes to existing behavior (only if the issue asks for it)

- `RUN_STATE_VERSION` moves from 6 to 7 with one additive optional field,
  documented in the same version comment block (issue #277 AC14, ADR 0018). The
  three assertions of that version outside `src/run-state.test.ts` —
  `src/eval-boundary.test.ts:127`, `src/qa-orchestration.test.ts:1028` and
  `src/qa-orchestration-gates.test.ts:1043` — are each updated from 6 to 7, one
  literal per file; no behavior, interface, data format, security posture or
  acceptance criterion of PRD 7, #91, #193 or #96 changes with it, and no test
  is renamed, added, removed or otherwise edited (B-10).
- `parsePipelineRuntimeOptions`' returned options gain two optional members and
  the two new refusals; no existing member or message changes (issue #277 AC3).
- `src/cli-options.ts` gains one new export, `parseStaleRenegotiationRequest`,
  which `parsePipelineRuntimeOptions` calls before the #335 guard (B-01, B-12).
  No existing export changes.
- No change to `withRunStateLock`, `transactRunState` or `withFileLock`: the
  cross-process contention seam is the new module's own optional
  `beforeLockAcquired` parameter (B-08), so no shared lock primitive's signature
  moves and `src/file-lock.ts` stays out of scope.

## Files expected to change

- src/cli-options.ts
- src/cli-options.test.ts
- src/cli-entries.test.ts
- src/preserve-work-recovery.ts
- src/preserve-work-recovery.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/eval-boundary.test.ts
- src/qa-orchestration.test.ts
- src/qa-orchestration-gates.test.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/preserve-work-recovery.ts`: the only home for canonical
  request/scope identity, the fingerprint encoder, eligibility, snapshot
  publication, the lineage transition validator and the admission entry point,
  whose optional `beforeLockAcquired` parameter is the only contention seam the
  slice adds (B-08).
  It is added as one row to ARCHITECTURE.md's module table and imports only
  already-exported seams (`src/git.ts`, `src/run-state.ts`,
  `src/run-identity.ts`, `src/afk-manifest.ts`, `src/acceptance-manifest.ts`,
  `src/contract-review.ts`, `src/file-lock.ts` via `transactRunState`).
- New optional `RunState` field for recovery lineage plus its persisted event
  type, at `RUN_STATE_VERSION` 7 (ADR 0018).
- No new dependencies: SHA-256 uses `node:crypto`'s `createHash`, as
  `src/git.ts:1253-1255` and `src/adjudication.ts:418-424` already do.

## Test plan

- Given `--renegotiate-stale 12 --recovery-reason " stale lock "`, when the
  exported `parseStaleRenegotiationRequest` runs, then it returns a request
  carrying selector `12` and reason `stale lock` — trimmed only, with interior
  spacing, case and code points intact — and, given the same args, when
  `parsePipelineRuntimeOptions` runs, then it throws the #335 refusal instead of
  returning, so the accepted return and the refusal are asserted on different
  functions.
- Given each of `--renegotiate-stale 12,13`, `--renegotiate-stale 12,12`,
  a repeated `--renegotiate-stale`, a missing `--recovery-reason`, a blank
  `--recovery-reason`, a repeated `--recovery-reason`, and each flag alone,
  when the shared parser runs, then each case throws its own distinct message
  and no two messages are equal.
- Given a persisted scope of two slices, when the exported encoder runs, then
  the JSON byte string is exactly
  `{"mode":"explicit","slices":[{"number":"1","ghIssue":"277"},...]}` in
  persisted order and its SHA-256 matches an independently computed digest.
- Given a temp repo whose target fails exactly one eligibility predicate
  (out of scope, no recorded branch, missing worktree, dirty worktree, no
  commits ahead, feature head not contained, invalid or unlocked pair, and a
  run with no persisted scope), when admission runs, then it refuses with that
  predicate's reason code and the branch tips, accepted-pair bytes, negotiation
  files and run-state file are byte-identical to before.
- Given stubs for exactly `hasUncommittedChanges`, `countCommitsAhead` and
  `isAncestor` at their current signatures, when the eligibility predicates run,
  then every git-derived eligibility outcome follows the stubs and no other
  `src/git.ts` or `src/worktree-processes.ts` export is invoked.
- Given an eligible target, when admission runs, then a published snapshot
  directory beneath the target's artifact directory holds byte-identical
  `contract.md` and `acceptance-manifest.json`, no temporary sibling remains,
  and a second admission attempt never overwrites the published directory.
- Given a snapshot publication that fails after the temporary sibling is
  written, when admission returns, then no published directory exists, no
  lineage is appended, and the failure is reported as pre-admission.
- Given an eligible target, when admission commits, then the run-state diff is
  exactly one appended `PENDING` event carrying attempt ID, target identity,
  canonical reason, `extensions: []`, provider, slice branch, slice head,
  feature head, scope fingerprint, snapshot locator and original pair
  fingerprints, and every other run-state field is unchanged.
- Given a target whose last lineage event is `PENDING`, when admission runs
  again for that target, then it is refused and no second event is appended.
- Given the admission entry point's own `beforeLockAcquired` seam, which runs a
  spawned child process to completion so that the accepted pair or the run
  state's scope changes after snapshot publication and before
  `transactRunState` takes the ADR 0056 lock, when admission acquires the lock
  and rechecks, then it refuses with a mismatch reason, appends no lineage and
  leaves the published snapshot inert — with `src/file-lock.ts`,
  `withFileLock` and `withRunStateLock` untouched.
- Given every transition pair over the four states, when the transition
  validator runs, then only `PENDING -> COMPLETED`,
  `PENDING -> ROLLED_BACK`, `PENDING -> ROLLBACK_FAILED` and
  `ROLLBACK_FAILED -> ROLLED_BACK` are accepted and every return to `PENDING`
  is refused.
- Given a v3, v4, v5 and v6 run-state file, and a v7 file with malformed
  recovery lineage, when run state loads, then every supported version loads
  without loss, malformed lineage degrades to absent, and a file with no
  lineage round-trips unchanged apart from the version stamp.
- Given PRD 7's boundary test `src/eval-boundary.test.ts`, when its
  `P-05 ... leaves both schema versions alone` case runs after the bump, then it
  asserts `RUN_STATE_VERSION` is 7 with `EVENTS_SCHEMA_VERSION` still 1 and its
  forbidden-import offender list still empty — the pinned literal is the only
  edit to that file.
- Given the two spawned scenarios that read the version off a loaded state —
  `src/qa-orchestration.test.ts:1028` and
  `src/qa-orchestration-gates.test.ts:1043` — when each runs after the bump, then
  it asserts the loaded version is 7 while its own locked properties still hold
  unchanged: the #91 approved-baseline locator in the first, and the #91 locator
  plus the #193 applied waivers plus the added `finalEvaluations` record in the
  second. One literal per file is the only edit; no test name, structure or other
  expectation changes, and no scenario is added.
- Given a well-formed `--renegotiate-stale` plus `--recovery-reason` pair, when
  the shared parser runs, then it throws a refusal naming #335, and
  `src/cli-entries.test.ts` asserts each of `src/afk.ts`, `src/afk-claude.ts`
  and `src/afk-codex.ts` reaches its runtime options through
  `parsePipelineRuntimeOptions`, so the refusal reaches all three.
- Given an argument list with neither new flag, when the shared parser runs,
  then the result equals today's result and no eligibility, snapshot or lock
  code executes.

## Definition of done

- [ ] Behaviors B-01 through B-12 and P-01 through P-05 each have at least one
      test whose name contains its ID, so
      `vitest run --testNamePattern <id>` selects it.
- [ ] `pnpm run typecheck` passes.
- [ ] `pnpm test:fast` passes.
- [ ] `pnpm run test:heavy:resume` passes, because `src/run-state.ts` changed.
- [ ] `pnpm run test:heavy:qa` passes, because the two version pins live in
      `src/qa-orchestration.test.ts` and `src/qa-orchestration-gates.test.ts`.
- [ ] No file outside "Files expected to change" is modified, except the
      planner's, evaluator's and orchestrator's own contract, manifest,
      response, review, feedback and negotiation artifacts under
      `.kiro/specs/afk-preserved-work-renegotiation/slices/01-preserve-work-recovery-admission/`.
- [ ] No spawned pipeline scenario is added, and no test in the
      `orchestrator`, `wave` or `clean-failed` suites is added or modified. In
      the `qa-orchestration` suite the only edit is B-10's version pin — the
      literal `6` at `src/qa-orchestration.test.ts:1028` and at
      `src/qa-orchestration-gates.test.ts:1043` becomes `7`, one per file, with
      no test added, removed, renamed or otherwise changed in either.
- [ ] ARCHITECTURE.md gains one module-table row for
      `src/preserve-work-recovery.ts` and stays within its 150-line cap.
- [ ] `RUN_STATE_VERSION` is 7 and the comment block above it
      (`src/run-state.ts:50-75`) names the v7 addition.
- [ ] `src/eval-boundary.test.ts` pins `RUN_STATE_VERSION` to 7 and is otherwise
      unchanged: same test names, same forbidden-import list, same module set,
      `EVENTS_SCHEMA_VERSION` still 1.
