# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: FAIL
- Preservation check: FAIL

`pnpm install --frozen-lockfile`, `pnpm run typecheck`, and `pnpm run test`
all completed successfully. The full suite passed 1,099 tests in 728.3 seconds,
and every suite remained within its configured budget.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- Canonical evaluator example is schema-invalid: cleared. The example now uses
  an `OPEN/ADVISORY` finding, and `src/prompt-template.test.ts:109-115` parses
  the rendered example through `parseQAReview`.
- Resumed STUCK QA loses lifecycle continuity and attempt evidence: cleared for
  the reported STUCK path. `src/orchestrator.ts:2502-2522` restores both stage
  histories and advances the round, while `src/resume-integration.test.ts`
  verifies the round-4 canonical, Markdown, and lifecycle archives.

## Findings
### Finding 1 — Ordinary preserved-tree resume loses QA lifecycle and evidence continuity
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:1336-1341` assigns ordinary preserved-tree
resumes the mode `killed`, but `src/orchestrator.ts:2502-2522` restores QA/UAT
history and advances archive numbering only for mode `stuck`. The resumed run
therefore starts empty at round 1. `src/artifacts.ts:354-359` and
`src/artifacts.ts:388-394` refuse collisions for canonical and record archives,
while `src/artifacts.ts:120-126` overwrites the same Markdown archive.
**What the contract expected:** "Maintain independent deterministic-QA and UAT
histories" and "Preserve raw canonical attempts and code-derived lifecycle
records".
**What I observed:** A normal resume after a QA-time provider failure neither
loads prior open findings nor selects the next evidence round. It can omit or
resurrect finding IDs, fails to archive colliding JSON/record files, and
replaces the earlier Markdown evidence.

### Finding 2 — Valid canonical output from a failed evaluator attempt gets no lifecycle record
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:2319-2321` calls
`archiveAttemptEvidence()` after an evaluator invocation throws, then discards
its result. That helper successfully parses and advances valid canonical output
at `src/orchestrator.ts:2229-2237`, but the retry path at
`src/orchestrator.ts:2344-2357` never writes the record or carries the resulting
history forward. Existing coverage tests only malformed partial JSON.
**What the contract expected:** "Preserve raw canonical attempts and
code-derived lifecycle records" and require each later non-infrastructure
attempt to disposition every currently `OPEN` ID.
**What I observed:** A schema-valid `FAIL/IMPLEMENTATION` or `PASS/NONE`
artifact written before a provider disconnect is archived raw but receives no
lifecycle record. The next attempt can omit an open ID or resurrect a resolved
ID because its transition was discarded.

### Finding 3 — STUCK resume grants three extra implementation rounds
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:2524-2531` sets the final round to
`firstRound + MAX_GENERATOR_ROUNDS - 1` and always iterates three implementation
attempts. After restoring `nextRound` as 4, a failing STUCK resume can therefore
run rounds 4, 5, and 6. The resume integration fixture proves only a pass in
round 4; it does not assert failure stops after that attempt. `README.md:235`
documents that `--resume-stuck` grants exactly one more implementation/QA
attempt.
**What the contract expected:** "Changes to ... the three implementation-round
cap ... [are out-of-scope]."
**What I observed:** The change effectively expands the cap from three total
rounds to six for a resumed STUCK slice and can invoke the generator and QA two
times beyond the documented one-attempt exception.
