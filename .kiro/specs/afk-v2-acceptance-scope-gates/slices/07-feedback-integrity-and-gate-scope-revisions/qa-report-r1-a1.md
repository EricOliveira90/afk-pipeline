# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | PASS — exit 0, "Lockfile is up to date", `prepare` (`tsc -p tsconfig.build.json`) clean |
| `pnpm run typecheck` | PASS — exit 0, `tsc --noEmit` emitted no diagnostics |

I ran `pnpm run typecheck` myself rather than relying on the skip authorization,
because it costs ten seconds; it agrees with the orchestrator's own gate
evidence (`.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260909-212637/gates/s07/attempt-b4e0165c869c.json`,
attempt `b4e0165c-869c-462a-a0d8-8b7b4595480c`, tree
`28998e9e71243a048b14771e8dc85b2ce1750550`). Per the assigned scope I did not
run the project test suite; the orchestrator runs it on the accepted candidate.

### Boundary compliance

Slice changes are `cf325a7..HEAD` (8 commits). Changed files: 23. The contract's
`Files expected to change` list: 23. They are the same set, path for path —
`src/afk-manifest.ts`, `src/afk-manifest.test.ts`,
`src/feedback-integrity-gate.ts`, `src/feedback-integrity-gate.test.ts`,
`src/escalation.ts`, `src/escalation.test.ts`, `src/artifacts.ts`,
`src/artifacts.test.ts`, `src/skip-gate.ts`, `src/skip-gate.test.ts`,
`src/run-state.ts`, `src/run-state.test.ts`, `src/run-events.ts`,
`src/logger.ts`, `src/logger.test.ts`, `src/orchestrator.ts`,
`src/orchestrator.test.ts`, `src/prompt-template.test.ts`,
`prompts/generator.md`, `prompts/generator-repair.md`,
`prompts/evaluator-contract.md`, `prompts/evaluator-contract-revision.md`,
`agents/generator.md`. No new migration file. No scope amendment is needed.

The non-goals hold: `src/gate-runner.ts`, `src/post-qa-gates.ts`,
`src/candidate-gate-phase.ts`, `src/base-gates.ts`, `src/gate-policy.ts` and
`src/acceptance-manifest.ts` are untouched in this slice's range.

### Behavior verification

Every behavior is bound by a test in a contract-declared file, tagged
`[behavior:…]`:

- **B-01/B-02** (`src/afk-manifest.test.ts:48-231`) — the four fields survive,
  the path is normalized, absence reads `[]`, and the launch throws naming the
  offender for an unknown `riskClass`, a globbed `path`, a blank field, a
  duplicate pair and a non-array. `trimUnclaimedMigrationPrefixes` preserves the
  array via `{ ...manifest, migrationPrefixes }` (`src/afk-manifest.ts:306`).
- **B-03** (`src/feedback-integrity-gate.test.ts:87-158`) — declared once as
  `feedback-integrity` / `deterministic` / `required: true` with `run` and no
  `command`; FAIL / `failureKind: "COMMAND"` on a changed `afk.config.json`
  naming the path in `findings.protectedChanges` and all four `afk.json` fields
  in `detail`; a `fileScope` declaring the path authorizes nothing; a probe that
  cannot answer returns `INFRASTRUCTURE` with no violation list.
- **B-04/B-05** (`:160-211`) — a deleted `src/foo.test.ts` FAILs under the
  default `**/*.test.ts`, a deleted source file does not, a covering
  `deleted-test` waiver PASSes with the four fields in
  `findings.appliedWaivers`, and a waiver for the wrong risk class does not
  cover it. Glob matching is `matchesGlob` from `src/gate-policy.ts:365`; no
  second matcher exists in the new module.
- **B-06** (`:213-240`) — a `protectedChangeWaivers` entry written into the
  candidate worktree's own `afk.json` exempts nothing; the gate takes waivers
  only from `config.manifest` (`src/orchestrator.ts:5607`).
- **B-07** (`:242-256`) — a policy omitting `deleted-test` suppresses the rule
  and `detail` says so; declaring it restores the FAIL.
- **B-08** (`:258-294`) — `acceptedPairIntact: false` FAILs naming both
  `contract.md` and `acceptance-manifest.json`, and the check runs before waiver
  matching (`unwaivable`), so a `gate-policy` waiver for either records nothing
  and exempts nothing.
- **B-09/P-01** (`src/escalation.test.ts:31-380`) — version is read before the
  key check, so `gateEvidence` is admitted conditionally at version 2 only and a
  version-1 document carrying it is refused as an unknown key; `gateEvidence`
  requires `findingIds` exactly `["GATE-SCOPE"]`; `GATE-SCOPE` without
  `gateEvidence` throws; neither reserved identity mixes with a cited ID or with
  the other; a version-2 document without `gateEvidence` parses as an ordinary
  escalation; version-1 documents parse unchanged.
- **B-10/P-02/P-03** (`src/orchestrator.test.ts:1913`, `:2133`, `:1627`) —
  `GATE-SCOPE` travels the one existing focused-revision door (the door reads
  the parsed escalation and special-cases no identity), the laundered-scope
  refusal still ends the round ERROR without widening, and the third escalation
  in a round is still refused. Added as `it`s on existing scenarios.
- **B-11** (`src/artifacts.test.ts:253`, `:291`) — a version-2 archived record
  is no longer `invalid` and the diagnosis renders `gateId` and
  `evidenceArtifactId`; a malformed version-2 record is still retained as
  `invalid`.
- **B-12** (`src/feedback-integrity-gate.test.ts:296` plus
  `src/orchestrator.test.ts:3494`) — `appliedWaiversFrom` de-duplicates on
  `riskClass` + `path` across results and returns `[]` for evidence with no
  findings; the spawned run proves the whole chain from one run: the waiver is
  read back out of the written evidence immediately after
  `gateArtifacts.push(...postQaGates.artifacts)` and before the
  CANCELLED/ERROR/REPAIR branches, one `waiver-applied` line lands in
  `events.jsonl`, and `.afk/state/<run-slug>.json` holds the record under issue
  `5001`. No new spawn was added.
- **B-13** (`src/run-state.test.ts:1378-1466`) — versions 1–4 load as 4 with the
  field absent-as-empty, `writeRunState` re-stamps the current version,
  `saveAppliedWaivers` ignores an already-recorded `riskClass` + `path`, and a
  malformed record degrades to absent instead of wedging the load.
- **B-14/P-06** (`src/logger.test.ts:280`, `:306`) — `## Applied Waivers` is
  rendered in `src/logger.ts` from the `waiver-applied` events alone with all
  four fields plus the slice; with no such event the section is absent and the
  summary tail is asserted byte-for-byte identical to the pre-change one.
- **B-15/P-05** (`src/skip-gate.test.ts:258-364`) — a `skipped-test` waiver
  excludes the path from the candidate scan, the base scan and the
  uncovered-file fail-closed check, and is recorded in
  `findings.appliedWaivers`; `fileScope` alone authorizes nothing; both #86
  `CONFIGURATION` refusals and increase-only counting are unchanged.
- **B-16/B-17/P-04** (`src/prompt-template.test.ts:201`, `:291`, `:344`) — the
  three-way branch is byte-identical across `prompts/generator.md`,
  `prompts/generator-repair.md` and `agents/generator.md` (asserted as
  `new Set(blocks).size === 1`), carries the exact version-2 JSON literal, the
  never-mix rule over all three identities and the
  escalate-for-a-human-decision rule; the parser-regression rubric is
  byte-identical in both evaluator prompts and binds both halves of the
  evidence, the owning fixture area, and the inline-harness carve-out; the
  pinned version-1 literal and `PRE-BUILD-SCOPE` sentence were updated in
  lockstep at `:171-193`; both evaluator prompts still carry
  `# Durable finding lineage`, `# Control-plane situation`, resolved
  placeholders and the `severity` / `state` bullets.

### Definition of done

All six items hold: every behavior bound in its declared file; the six frozen
modules unedited and `GATE_EVIDENCE_VERSION` still 3; the gate declared exactly
once, at the post-QA site beside `scope` and `tests:skipped`, with no rule of it
implemented elsewhere; one waiver reader (`src/afk-manifest.ts`), reached only
from the launch manifest, with no matcher of its own; an applied waiver
observable at all three points from the single spawned run at
`src/orchestrator.test.ts:3400`; changed files exactly the declared scope with
no migration.

## Pass 2: Quality & Craft
- Convention compliance: NOTES
- Code quality: PASS
- Test quality: PASS

Notes, none material. The new module matches the existing in-process gate shape
(`src/scope-gate.ts`, `src/skip-gate.ts`) and the comment density of the files
around it; every comment states a reason rather than restating the code. Two
design choices are load-bearing and correctly reasoned in place: the accepted
pair is checked before waiver matching so no authorization path can reach it,
and `saveAppliedWaivers` takes the provider-suffixed run slug (parameter named
`runSlug`) rather than the PRD slug, which is the difference between a state
file readers open and one nobody does. The evidence read in the orchestrator's
producing seam swallows an unreadable artifact deliberately and says why,
leaving the refusal to the verified-evidence checks that own it. The two
advisory notes below are a text-formatting slip and two stale pointers in the
handoff; neither affects behavior.

## Resolved findings
- None. No findings were routed to this QA stage.

## Findings
### Finding 1 — Rubric section abuts the next heading in both evaluator prompts
**Severity:** Minor
**Pass:** 2
**Evidence:** In `prompts/evaluator-contract.md` and
`prompts/evaluator-contract-revision.md`, the rubric's last line
(`harness implies undeclared, is a BLOCKING finding under scenario honesty and
evidence-backed scope.`) is followed directly by `# Canonical review artifacts`
with no blank line. Every other `# ` heading in both files has one.
**What the contract expected:** "[behavior:B-17] … gain ADR 0060's
parser-regression rubric text additively" (P-04: "the rubric addition is
additive").
**What I observed:** The text is additive and correct, and it still parses —
CommonMark ATX headings interrupt a paragraph, and the B-17 test's `(?=^# )`
lookahead still finds the boundary — but the section boundary is formatted
unlike every other one in files whose entire purpose is to be read by an agent.
Cosmetic; identical in both files, so there is no drift between them.

### Finding 2 — Handoff points B-02 and B-14 at the wrong function and file
**Severity:** Minor
**Pass:** 2
**Evidence:** `handoff.md:9` credits B-02 to
`src/afk-manifest.ts:writeAfkManifest`; there is no `writeAfkManifest` — the
round-trip comes from `trimUnclaimedMigrationPrefixes` spreading the parsed
manifest at `src/afk-manifest.ts:306`. `handoff.md:34` credits B-14 to
`src/artifacts.ts`; the `## Applied Waivers` renderer is `src/logger.ts:466-495`,
which is the file the contract declares and the one
`src/logger.test.ts:280` asserts against.
**What the contract expected:** "[behavior:B-14] `Logger.writeSummary`
(`src/logger.ts`) renders an `## Applied Waivers` section"; "[behavior:B-02]
`trimUnclaimedMigrationPrefixes` (`src/afk-manifest.ts`) preserves
`protectedChangeWaivers`".
**What I observed:** Both behaviors ship in exactly the places the contract
names and are bound by tests there. Only the handoff's two pointers are wrong,
which costs the next reader of that map a search.
