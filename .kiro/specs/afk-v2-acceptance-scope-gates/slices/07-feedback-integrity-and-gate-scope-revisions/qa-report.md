# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

### Commands run

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm run typecheck` — exit 0. Run directly rather than cited; the tree was
  not modified, so the skip authorization
  (`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260910-000620/gates/s07/attempt-62da0c6aad60.json`,
  tree `7610c7ad653387000b8297220933d31503d5491c`) also covers it.

Per the assigned scope, no vitest suite was run: the orchestrator runs the
declared suites on the authorized candidate tree after this stage accepts.

### Boundary compliance

`git diff --name-status c76391c HEAD` (the slice base on
`feat-claude-code/afk-v2-acceptance-scope-gates`) reports 23 changed paths, and
all 23 are the contract's declared file list exactly — 21 modified, 2 added
(`src/feedback-integrity-gate.ts`, `src/feedback-integrity-gate.test.ts`). No
undeclared path, and no migration file. The only untracked tree is this slice's
own spec directory.

The definition-of-done freeze holds: `src/gate-runner.ts`,
`src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`, `src/base-gates.ts`,
`src/gate-policy.ts` and `src/acceptance-manifest.ts` are absent from the diff,
so `GATE_EVIDENCE_VERSION` stays 3 and the acceptance manifest stays at
version 2. `feedbackIntegrityGateDeclaration` is called from exactly one
production site (`src/orchestrator.ts:5968`).

### Behavior verification (read against source and bound tests)

- B-01/B-02 — `normalizeProtectedChangeWaiver` / `normalizeWaiverPath` enforce
  the `GATE_RISK_CLASSES` membership, the `[*?[]` glob refusal, non-blank
  fields and the `riskClass` + `path` uniqueness check, each throw naming the
  offender; absence reads as `[]`. `trimUnclaimedMigrationPrefixes` spreads the
  parsed manifest (`src/afk-manifest.ts:306`), so the array survives the
  rewrite. Bound at `src/afk-manifest.test.ts:48-231`.
- B-03/B-04/B-06/B-07/B-08 — `runFeedbackIntegrityGate` returns
  `INFRASTRUCTURE` on a failed `listChangedFiles` probe rather than an empty
  violation list, FAILs `COMMAND` with `findings.protectedChanges` /
  `findings.deletedTests` naming exact paths, names all four `afk.json` fields
  and the "fileScope is not authorization" rule in `detail`, matches globs only
  through gate-policy's exported `matchesGlob`, filters detections by
  `gatePolicy.riskClasses` and states the omission, and treats
  `acceptedPairIntact: false` as unwaivable before waiver matching. All bound
  at `src/feedback-integrity-gate.test.ts:87-294`, including the B-06 case that
  writes a self-authored `afk.json` into the candidate worktree and still
  FAILs.
- B-05 — a covering launch waiver exempts the detection and lands its four
  fields in `findings.appliedWaivers`; a right-path/wrong-class waiver does
  not (`src/feedback-integrity-gate.test.ts:176-211`).
- B-09/P-01 — `parseScopeEscalation` reads `version` before `requireExactKeys`
  and admits `gateEvidence` only when `version === 2 && "gateEvidence" in
  input`, so a version-1 document carrying it fails the exact-key check. The
  `GATE-SCOPE` ↔ `gateEvidence` biconditional, the sole-entry rule for both
  reserved identities and the never-mix rule are all present; the version-1
  refusals are untouched (`src/escalation.test.ts:31,267-381`).
- B-10/P-02/P-03 — no ID-specific branch was added to the orchestrator's
  focused-revision door, which is the point: the version-2 `GATE-SCOPE`
  document travels the same channel. Proven on an existing spawned scenario
  (`src/orchestrator.test.ts:1913`) — two planners, two contract evaluations,
  one QA round, next generator prompt carrying the requested path, merged
  `fileScope` widened, raw document archived verbatim — plus the
  raised-after-the-edit refusal (`:2133`) and the third-escalation stop
  (`:1627`).
- B-11 — `archivedScopeEscalations` accepts `version === 2` and
  `renderStuckDiagnosis` emits a `Gate evidence:` line with `gateId` and
  `evidenceArtifactId`; a malformed version-2 record is still `invalid`
  (`src/artifacts.test.ts:253,291`).
- B-12 — the seam sits immediately after
  `gateArtifacts.push(...postQaGates.artifacts)` and before the
  CANCELLED/ERROR/REPAIR branches, reads written evidence with
  `readGateEvidence`, and passes it through the pure `appliedWaiversFrom`
  (de-duplicated on `riskClass` + `path`, so two gates reporting one launch
  authorization is one waiver). Unit-bound at
  `src/feedback-integrity-gate.test.ts:296`; end-to-end on the existing
  `runPipeline summary report` spawn at `src/orchestrator.test.ts:3494`, which
  reads the single `waiver-applied` line out of `events.jsonl` and the matching
  record out of `.afk/state/<slug>-stub.json`.
- B-13 — `CURRENT_RUN_STATE_VERSION = 4`, `adaptLoadedState` accepts 1–4 and
  always returns 4, `sanitizeAppliedWaivers` degrades a malformed record to
  absent, `writeRunState` re-stamps the version, and `saveAppliedWaivers`
  re-reads inside the lock and ignores a recorded `riskClass` + `path`
  (`src/run-state.test.ts:1378-1460`).
- B-14/P-06 — `writeSummary` renders `## Applied Waivers` from the
  `waiver-applied` events alone and appends nothing when there are none, so a
  waiver-free run's bytes are unchanged (`src/logger.test.ts:280,306`).
- B-15/P-05 — the waived path is filtered out of the candidate scan, the
  relevant-base scan and therefore the uncovered-file check; file scope alone
  authorizes nothing; the two `CONFIGURATION` refusals and the
  increase-over-base rule are re-pinned (`src/skip-gate.test.ts:197,258-347`).
- B-16/B-17/P-04 — the three-way escalation block is asserted byte-identical
  across `prompts/generator.md`, `prompts/generator-repair.md` and
  `agents/generator.md` (`new Set(blocks).size === 1`) along with the version-2
  literal and the escalate-for-a-human-decision rule; both evaluator prompts
  carry the `# Parser regression surface` rubric while keeping
  `# Durable finding lineage`, `# Control-plane situation`, both placeholders
  and the `severity` / `state` bullets
  (`src/prompt-template.test.ts:201,291,344`).

Every one of the 17 controlled and 6 preserved behaviors carries a
`[behavior:…]`-tagged test, and every tag sits in the file the contract's test
plan named.

### Pass 2 notes

The new module is documented at the level of the modules it is modelled on, and
the comments carry the *reason* rather than restating the code — the
`INFRASTRUCTURE`-not-empty-list note, the base-side waiver exclusion
("excluding it from the candidate side alone would turn a removed skip … into a
base count the candidate can never match"), and the `runSlug`-not-`prdSlug`
rename are each the kind of note that stops a later reader reintroducing the
bug. `appliedWaiversFrom` is genuinely pure and separately unit-tested. Test
cost was held flat as the handoff claims: the two new spawned proofs are `it`s
on scenarios that already ran a pipeline, which is the ladder `CLAUDE.md`
prescribes.

## Resolved findings
- none (no findings were routed to this stage)

## Findings
### Finding 1 — `## Applied Waivers` can repeat one authorization per round
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/orchestrator.ts:6032-6072` emits a `waiver-applied` event on
every post-QA gate phase, so a slice that goes to REPAIR and re-runs the phase
emits the same waiver again under a different `round`. `src/logger.ts` renders
the section from `runEvents.filter((event) => event.type ===
"waiver-applied")`, with columns Slice / Risk class / Path / Author / Reason and
no round. `src/orchestrator.test.ts:3494` pins exactly one event, but that
scenario is a single-round PASS, so the repeat case is unbound.
**What the contract expected:** "[behavior:B-14] `Logger.writeSummary`
(`src/logger.ts`) renders an `## Applied Waivers` section in `run-summary.md`
from the run's `waiver-applied` events — slice, risk class, exact path, author,
reason".
**What I observed:** For a multi-round slice the table would carry one
identical row per round with nothing to distinguish them.
`saveAppliedWaivers` de-duplicates the persisted record and `events.jsonl`
keeps the `round`, so only the human-readable table is affected — hence
advisory, not blocking. Clears when the section de-duplicates on slice + risk
class + path or renders the round the event already carries, with a
`src/logger.test.ts` case for two events describing one waiver.
