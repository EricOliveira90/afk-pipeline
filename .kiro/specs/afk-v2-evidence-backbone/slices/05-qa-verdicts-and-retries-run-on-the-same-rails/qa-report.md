# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: FAIL
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

`pnpm install --frozen-lockfile` and `pnpm run typecheck` exited 0.
`pnpm run test` was invoked once, but the command runner terminated it at its
600-second wall-clock limit. Before termination, `fast`, `orchestrator`, and
`wave` recorded exit 0. The `resume-integration` process was then killed after
7.317 seconds, and the later suites did not run.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- Canonical evaluator example is schema-invalid: cleared. The example uses an
  `OPEN/ADVISORY` finding, and `src/prompt-template.test.ts:109-115` parses it
  with `parseQAReview`.
- Resumed STUCK QA loses lifecycle continuity and attempt evidence: cleared.
  `src/orchestrator.ts:2547-2568` restores both stage histories for resumes and
  advances evidence numbering.
- Ordinary preserved-tree resume loses QA lifecycle and evidence continuity:
  cleared in its original scope. The same restoration path now applies to
  ordinary resumes, and `prompts/generator-resume.md` receives the computed
  unresolved set.
- Valid canonical output from a failed evaluator attempt gets no lifecycle
  record: cleared. `src/orchestrator.ts:2412-2416` records valid failed-attempt
  evidence before an infrastructure retry.
- STUCK resume grants three extra implementation rounds: cleared.
  `src/orchestrator.ts:2569-2576` limits a STUCK resume to one implementation
  attempt, with an assertion in `src/resume-integration.test.ts:692-715`.

## Findings
### Finding 1 — The required full suite was terminated by the command runner
**Severity:** Blocker
**Pass:** 1
**Evidence:** `pnpm run test` returned exit 124 after 604.067 seconds.
`.vitest-reports/fast.json`, `orchestrator.json`, and `wave.json` record exit 0
after 90.040, 332.632, and 173.110 seconds. The runner then killed
`resume-integration` after 7.317 seconds. `scripts/timed-suite.mjs` maps a
signal-terminated child with null status to exit 1, explaining that report.
**What the contract expected:** The test plan requires verdict-driving fixtures
to verify canonical artifact outcomes, and the assigned sanity pass requires
`pnpm run test` to complete.
**What I observed:** The external command wrapper enforced 600 seconds of total
runtime rather than 600 seconds of output inactivity. It interrupted the suite
after about 604 seconds, so QA and clean suites were never attempted and the
full sanity result is unavailable.

### Finding 2 — Ordinary resumes can exceed the three-round implementation cap
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:2567` restores `firstRound` from archived
evidence, but `src/orchestrator.ts:2569-2576` grants every non-STUCK resume
three additional implementation attempts. After a round-1 implementation
failure, an ordinary resume can therefore execute rounds 2, 3, and 4. The
ordinary-resume fixture passes in round 2 and has no exhaustion assertion.
**What the contract expected:** "Changes to ... the three implementation-round
cap ... [are out-of-scope]." ADR 0014 says implementation failures advance the
generator round, "which remains capped at three."
**What I observed:** Restored round numbering is global, but the attempt limit
is reset per ordinary resumed invocation. The fourth implementation round is
reachable, changing preserved retry accounting.

### Finding 3 — Evidence archive failures do not prevent PASS
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:2212-2235` catches a raw canonical archive
failure and continues. `src/orchestrator.ts:2307-2325` likewise catches a
lifecycle-record archive failure and continues. The subsequent canonical
verdict can still return PASS and merge while `artifactReferences` names a
missing or stale archive.
**What the contract expected:** "Preserve raw canonical attempts and
code-derived lifecycle records at the exact paths below" and "Every attempt
preserves the specified evidence."
**What I observed:** Required archive writes are best-effort warnings. A
collision, permission error, or other local write failure can leave required
raw or lifecycle evidence absent without preventing the slice from passing.
