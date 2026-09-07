# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS — `pnpm install --frozen-lockfile` completed in 33.4s; authorized `pnpm run typecheck` evidence passed for tree `ccaf6f1883fb7f24039a5cc6715ee4aa4c824857` in gate attempt `4653deb4-e639-4310-ac96-3b6b180188d2`.
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- none

## Findings
### Finding 1 — Architect prompt omits and contradicts the later-round blocking rules
**Severity:** Blocker
**Pass:** 1
**Evidence:** `prompts/architect-review.md:33-37` universally requires every blocker to be introduced by the reviewed diff and demotes unchanged behavior. It never states the later-new `INTEGRITY`/`DATA_LOSS` exception or the prior-lineage exception. `src/prompt-template.test.ts:291-315` checks the v2 heading and field names, but not those round-aware rules.
**What the contract expected:** B-02 limits later-new blockers to attributed `INTEGRITY` or `DATA_LOSS`; B-03 allows an uncleared prior-lineage finding with a reachable trigger to continue blocking “regardless of its class or whether the current fix diff introduced the original defect.” The prompt test must state the round-1 floor and later-round exception.
**What I observed:** The prompt gives one universal attribution rule, so it can cause a legitimate uncleared prior blocker to be reported as a note. The focused prompt test remains green while the required round-aware guidance is absent.

### Finding 2 — Authority policy tests do not bind the declared cross-product
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/guardian-blocking-authority.test.ts:15-81` tests trigger absence only in round 1 and `RESOLVED` only for prior lineage. It omits combinations such as triggerless prior-lineage and triggerless later-new `INTEGRITY` findings.
**What the contract expected:** The policy test covers the cross-product of round, lineage, trigger, attribution, class, and disposition for B-01 through B-03.
**What I observed:** Representative branches are covered, but several combinations remain unbound and could regress through condition reordering.
