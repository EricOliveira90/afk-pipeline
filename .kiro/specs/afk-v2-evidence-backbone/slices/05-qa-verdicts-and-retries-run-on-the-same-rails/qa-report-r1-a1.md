# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

`pnpm install --frozen-lockfile`, `pnpm run typecheck`, and `pnpm run test`
all exited 0. The full suite completed in 994.8 seconds, and every suite stayed
within its configured budget.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- none

## Findings
### Finding 1 — Canonical evaluator example is schema-invalid
**Severity:** Major
**Pass:** 1
**Evidence:** `prompts/evaluator-qa.md:81-103` labels its exact example
`PASS/NONE` while including finding `QA-01` as `BLOCKING` and `OPEN`.
`src/qa-review.ts:233-241` rejects that combination. The prompt test at
`src/prompt-template.test.ts:88-107` checks only that field names occur and
does not parse the example.
**What the contract expected:** "`PASS/NONE` with `infrastructureEvidence:
null` and no `OPEN/BLOCKING` finding."
**What I observed:** Following the evaluator's exact canonical example creates
an artifact that the orchestrator rejects as `ERROR`, despite the adjacent
prompt text describing the correct invariant.

### Finding 2 — Resumed STUCK QA loses lifecycle continuity and attempt evidence
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:2492-2499` initializes both stage histories
empty and restarts round numbering at 1 on every `runSliceExecute` call,
including the `resume-stuck` path selected at `src/orchestrator.ts:2517`.
Existing raw archives then collide because `src/artifacts.ts:354-359` refuses
overwrite, lifecycle records collide because `src/artifacts.ts:388-394` uses
`wx`, while `src/artifacts.ts:120-126` overwrites the prior Markdown archive.
`prompts/generator-resume-stuck.md` also instructs the generator to reconstruct
findings from every preserved QA report rather than receiving the code-derived
unresolved set.
**What the contract expected:** "Maintain independent deterministic-QA and UAT
histories", route "only the computed unresolved set to later evaluators and
implementation retries", and "Preserve raw canonical attempts and code-derived
lifecycle records".
**What I observed:** A `--resume-stuck` implementation attempt starts with no
prior QA history, can omit an open ID or resurrect a resolved ID, does not
receive the computed unresolved set, fails to archive its new canonical and
lifecycle records under the colliding names, and replaces the Markdown evidence
referenced by the prior record.
