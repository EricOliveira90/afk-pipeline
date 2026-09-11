# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness

- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — PASS (exit 0, 9.6s; `prepare` ran
  `tsc -p tsconfig.build.json` clean as part of it).
- `pnpm run typecheck` — skipped under the orchestrator's skip authorization.
  Cited evidence: gate attempt `47c8f909-52bc-4c29-ae83-5e06eed4b648`,
  artifact
  `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260911-145454/gates/s07/attempt-47c8f90952bc.json`,
  Git tree `f84945981d65ae899f34f5f12a87c19991f3beaf`, PASS at
  2026-09-11T18:09:30.383Z. No file under review was modified, so the
  authorization holds.

### Probes (disposable-worktree only, no candidate file changed)

Behavior verification, not a substitute for the pre-ship suite:

- `pnpm vitest run src/afk-manifest.test.ts src/feedback-integrity-gate.test.ts
  src/escalation.test.ts src/run-state.test.ts src/logger.test.ts
  src/skip-gate.test.ts src/prompt-template.test.ts src/artifacts.test.ts`
  → `Test Files 8 passed (8)`, `Tests 274 passed (274)`, exit 0.
- `pnpm run test:heavy:orchestrator` → `Test Files 2 passed (2)`,
  `Tests 227 passed (227)`, exit 0, 454.7s. This is the load-bearing evidence
  for B-10, B-12, P-02 and P-03, all of which are bound to spawned pipeline
  runs.

### Behavior verification

Every behavior in the manifest is bound in its declared file by a test whose
name carries the behavior ID, and each one asserts observable output rather
than a mock:

- B-01/B-02 — `src/afk-manifest.test.ts`: the four parsed fields with the path
  normalized, absent-as-empty, `it.each` refusals for unknown `riskClass`,
  glob-shaped `path`, blank fields, duplicate pair, non-array; and the waivers
  read back off disk after `trimUnclaimedMigrationPrefixes`
  (`src/afk-manifest.ts:306` spreads the parsed manifest).
- B-03..B-08 — `src/feedback-integrity-gate.test.ts` runs the real gate against
  real git fixture repos: `id`/`stage`/`required`/`run` with `command`
  undefined; FAIL + `failureKind: "COMMAND"` +
  `findings.protectedChanges: ["afk.config.json"]` with all four field names
  and `afk.json` in `detail`; the `fileScope`-is-not-authorization case
  asserting the literal `"fileScope is not authorization"`; INFRASTRUCTURE on a
  bad `featureRef` *with* `protectedChanges` proven absent (never an empty
  violation list); deleted test named exactly, deleted non-test PASSing;
  waiver-applied PASS with the four fields in `appliedWaivers`; wrong-risk-class
  waiver not covering; a candidate-authored worktree `afk.json` exempting
  nothing; `riskClasses` omission suppressing the rule and saying so in
  `detail`; and `acceptedPairIntact: false` failing closed on both filenames
  with a `gate-policy` waiver for each proven not to exempt.
- B-09/P-01 — `src/escalation.test.ts`: the version-2 `GATE-SCOPE` parse, a
  version-2 document *without* `gateEvidence` parsing as an ordinary
  cited-finding and as `PRE-BUILD-SCOPE`, eleven `it.each` refusals (including
  the version-1-carrying-`gateEvidence` case asserted against the anchored
  four-key message, so it is refused by the exact-key check and not by
  something else), and an explicit "relaxes none of the version 1 refusals"
  case.
- B-10/P-02/P-03 — `src/orchestrator.test.ts`, on the existing
  generator-scope-escalation spawned scenarios converted to
  `describe` + `beforeAll` rather than new spawns: revised `fileScope`
  `[declared, extra]`, the revision planner prompt carrying `GATE-SCOPE`, phase
  ERROR + `/ADR 0052/` for the escalation-after-an-undeclared-edit case, and the
  third-escalation refusal now driven by a `GATE-SCOPE` document.
- B-11 — `src/artifacts.test.ts`: `Gate evidence: \`tests\`` and the artifact ID
  in the rendered diagnosis, plus a malformed version-2 record still retained as
  invalid.
- B-12 — `appliedWaiversFrom` de-duplicating the same waiver reported by two
  gates, and one real spawned run (`runPipeline summary report` →
  "a slice that passes with a launch waiver") whose launch `afk.json` waives a
  quarantined `it.skip`: the assertion reads `waiver-applied` out of the run's
  own `events.jsonl` and the record out of the persisted state file. The waiver
  is also what keeps the skip gate green, so the run could not have passed
  without it.
- B-13 — `src/run-state.test.ts`: `RUN_STATE_VERSION === 4`, every earlier
  version adapting to 4 with the field genuinely absent
  (`"appliedWaivers" in adapted === false`), the write-time version re-stamp,
  survival across an unrelated focused write, de-duplication on
  `riskClass` + `path`, empty-list-is-no-write, and a malformed record
  degrading to absent.
- B-14/P-06 — `src/logger.test.ts`: the exact table row with all four values;
  the QA-01 case proving two rounds of the same authorization render one row
  carrying round 1 while a second path renders its own; and the byte-stability
  case asserting the literal pre-#193 tail
  (`"| 1 | 1 | typecheck | ... |\n\n\nPre-ship sanity gate: N/A"`) with
  `## Applied Waivers` absent.
- B-15/P-05 — `src/skip-gate.test.ts`: waived PASS with `appliedWaivers`, base
  scan exclusion, uncovered-file-check exclusion, `fileScope` alone still
  FAILing, and an explicit "leaves every #86 refusal exactly as it shipped".
- B-16/B-17/P-04 — `src/prompt-template.test.ts`: the three-identity block
  asserted **byte-identical** across `prompts/generator.md`,
  `prompts/generator-repair.md` and `agents/generator.md`
  (`new Set(blocks).size === 1`), the version-2 JSON literal in full, all three
  branches, the never-mix sentence, the five escalate-for-a-human triggers, and
  the parser-regression rubric in both evaluator prompts with the retained
  `# Durable finding lineage` / `# Control-plane situation` sections,
  placeholders and severity/state bullets.

### Boundary compliance

`git diff --stat e84068d...HEAD` (slice-07's own commits, feature-branch tip to
candidate) changes 23 source/prompt files, and every one is on the contract's
declared list. Nothing outside it: `src/gate-runner.ts`,
`src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`, `src/base-gates.ts`,
`src/gate-policy.ts` and `src/acceptance-manifest.ts` are untouched by this
slice. Verified in the tree: `GATE_EVIDENCE_VERSION = 3`
(`src/gate-runner.ts:43`) and the acceptance manifest still version 2
(`src/acceptance-manifest.ts:26,277`). No migration file; `migrationCount: 0`
holds. The remaining changed paths are this slice's own artifacts under
`.kiro/specs/.../slices/07-.../`.

`feedbackIntegrityGateDeclaration` is called from exactly one production site
(`src/orchestrator.ts:6375`), and the only other reference is the test. No
second waiver reader and no second glob matcher exist: the gate imports
`matchesGlob` from `src/gate-policy.ts:365` with the correct `(glob, path)`
argument order, and `ProtectedChangeWaiver` / `normalizeWaiverPath` from
`src/afk-manifest.ts`.

The accepted pair is intact — `git diff` of `contract.md` and
`acceptance-manifest.json` against HEAD reports only a CRLF-normalization
warning and no content hunks.

### Preservation

P-01 through P-06 are each bound by a named test, and all of them ran green in
the two probes above. The round-4 handoff's two claimed stale-base failures are
resolved in this candidate rather than merely explained away:
`src/qa-orchestration.test.ts` now pins the post-QA gate list with the
`declaresInOrder` / `expectDeclaresInOrder` subsequence helpers (lines 149-195,
2429-2463), so a fourth declared gate cannot break it; and `vitest.config.ts`
sets `AFK_MIN_FREE_DISK_GB: "0"`, so the 5 GB preflight floor no longer reaches
the spawned fixtures. Host free disk during this review was 13.7 GB.

The round-4 NUL-byte hazard is also clear: `src/logger.ts` contains zero NUL
bytes.

## Pass 2: Quality & Craft

- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The new module follows the existing in-process gate shape exactly — a pure
`run…Gate(input)` beside a thin `…Declaration(input)` closure, mirroring
`src/scope-gate.ts` and `src/skip-gate.ts`. Detections are collected before
waivers are consulted, which is what makes the accepted-pair rule unwaivable by
construction (`unwaivable: true`) rather than by a later special case. Failure
`detail` names each offender with the authorization recipe beside it, and the
`riskClasses` omission clause is appended to both the PASS and FAIL paths, so
the "what is not enforced" statement cannot be reachable on one path only.
Comments explain the non-obvious choices — why the base scan is filtered too in
the skip gate, why `appliedWaiversFrom` reads written evidence instead of the
in-memory outcome, why the waiver record lives beside `slices` rather than
inside `PersistedSliceState`.

Test quality is above the bar for this repo: the gate suite drives real git
trees instead of stubbing the changed-set probe, the prompt test asserts
byte-identity across the three generator surfaces rather than three separate
substring checks, the logger byte-stability test pins a literal tail, and the
B-12 proof is read out of a real run's `events.jsonl` and state file. The
assertion ladder in `CLAUDE.md` was respected: two existing single-`it` spawned
scenarios became `describe` + `beforeAll` runs and two more were extended, so
the slice adds no new pipeline spawn.

Two notes, neither a defect and neither affecting the verdict:

1. **Test-file renames read as deletions.** B-04's locked definition of a
   deleted test is "on the comparison base and not in the candidate", so moving
   a test file — which this repo does, e.g. the `wave.test.ts` /
   `wave-migrations.test.ts` split — will FAIL the gate at the old path until a
   human waives it. That is the contract as locked, not a deviation from it;
   flagged only because the operational cost lands on this repo's own
   self-runs.
2. **`skip-gate` records a base-only waiver as applied.** B-15 says "each waived
   path present in the candidate is recorded in `findings.appliedWaivers`"; the
   implementation also records a waiver whose path exists only on the base
   (`src/skip-gate.ts`, `appliedWaivers` filter). The in-code rationale — the
   record is of what was spent, and the path was excluded from the base scan
   too — is sound, and a waiver matching neither tree is still correctly
   excluded.

## Resolved findings

None routed into this stage. The prior round's QA-01 (one `## Applied Waivers`
row per authorization, carrying its round) was already dispositioned before this
stage and its repair is verified above under B-14 — `src/logger.ts` keys
de-duplication on slice + risk class + path and keeps the first round, asserted
by `[behavior:B-14] QA-01: renders one row per authorization, not one per round`.

## Findings

None.
