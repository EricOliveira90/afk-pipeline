# Slice Contract — Blocking rubric floor

**Parent PRD:** .kiro/specs/afk-guardian-review-convergence/prd.md
**GH issue:** #172
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

Narrow architect blocking authority at the structured-finding, lineage, ledger-validation, and ship-gate decision path: every architect blocker names a normal-operation reachable trigger; round-1 and later-new blockers are attributed to the reviewed diff; later-new findings block only for an integrity or data-loss class introduced by the fix; and an uncleared prior blocker remains blocking (GH #172; ADR 0057 decision 3; ADR 0033).

### In scope

- [behavior:B-01] Given an architect round-1 `FIX-BEFORE-SHIP` finding, when its effective ledger outcome is derived, then the finding may keep blocking authority only when `reachableTrigger` is non-blank and `introducedByReviewedDiff` is true; an infrastructure-fault-only trigger, a crash window repaired before another actor can consume invalid state, or pre-existing `main` behavior is represented as a note rather than a blocker (GH #172 task 1; ADR 0057 decision 3).
- [behavior:B-02] Given architect round 2 or later reports a finding with no prior stable lineage, when its effective ledger outcome is derived, then the finding is retained but may block only when it has a non-blank reachable trigger, `introducedByReviewedDiff` is true, and its class is exactly `INTEGRITY` or `DATA_LOSS`; every other new class reports as a note (GH #172 task 2; ADR 0057 decisions 2-3).
- [behavior:B-03] Given architect round 2 or later reports a finding matched to a prior stable lineage, when the current disposition is not `RESOLVED`, then the finding may continue to block when it carries a non-blank reachable trigger regardless of its class or whether the current fix diff introduced the original defect; a `RESOLVED` prior finding cannot block (GH #172 task 2; ADR 0057 decisions 1-3).
- [behavior:B-04] Given an invoked architect record whose outcome is `FIX-BEFORE-SHIP`, when the ship gate constructs it or persisted review state is sanitized, then at least one finding must satisfy the applicable B-01, B-02, or B-03 authority rule; otherwise the invoked result is recorded as `ACCEPT-WITH-NOTES` with its findings retained, and a persisted impossible blocking record invalidates the tolerant rounds ledger instead of loading as blocking authority (GH #172 Tests and Dependency decision; ADR 0057 decisions 1 and 3).

### Non-goals (explicit out-of-scope)

- Delta-diff selection, open-finding and resolved-history prompt interpolation, or other round-2+ context delivery owned by GH #171; this slice consumes the round number and stable lineage already available at the ledger/ship-gate seam (GH #172 dependency decision; ADR 0057 decision 2).
- Round caps, cap exits, symmetric override changes, PR-body recording, or unresolved-finding issue filing owned by GH #173 and GH #174 (ADR 0057 decisions 4-5).
- PM rubric or blocking-policy changes. The PM guardian keeps structured findings v1 and its existing verdict authority (PRD Out of Scope).
- Changes to `agents/*.md`, the pre-ship sanity gate, QA evaluation, implementation-round convergence, or live-review tests (PRD Out of Scope and Testing Decisions).

### Existing behavior to preserve

- [behavior:P-01] Given a guardian finding with coupling, broken-abstraction, security-gap, or missing-error-handling class, when it satisfies the applicable reachable-trigger and attribution rule, then that class remains eligible to block; trigger category or low frequency alone does not demote a reachable harmful path (GH #172; existing architect principle 2; ADR 0057 decision 3).
- [behavior:P-02] Given PM structured findings v1 or existing guardian `SHIP`, `ACCEPT-WITH-NOTES`, infrastructure-failure, and favorable-cache records, when they are parsed, folded, persisted, or loaded, then their existing schema, cardinality, retry, cache-provenance, and ledger-tolerance behavior remains unchanged (ADR 0015; ADR 0057 decision 1).
- [behavior:P-03] Given architect findings that reuse IDs, aliases, or normalized class-plus-clear-condition fingerprints, when lineage advances, then #170's one-to-one stable identity, current identity, ordering-independent collision rule, and lifecycle dispositions remain unchanged apart from carrying the additive authority evidence (ADR 0057 decision 1 and its 2026-09-06 amendment).
- [behavior:P-04] Given at least one architect finding retains blocking authority, when draft-PR planning evaluates architect and PM outcomes, then existing favorable, blocked, single-guardian override, two-blocker refusal, artifact commit, and review-cache behavior remains unchanged (ADR 0015; ADR 0057 decisions 3 and 5).

### Changes to existing behavior (only if the issue asks for it)

- Architect structured findings use version 2. Each exact-key finding adds `reachableTrigger: string | null` and `introducedByReviewedDiff: boolean`; a present trigger is trimmed and must be non-blank. PM structured findings remain version 1.
- Persisted guardian findings add `reachableTrigger: string | null` and `introducedByReviewedDiff: boolean | null`. Version-1 PM findings and legacy findings carry `null` authority evidence; legacy architect `FIX-BEFORE-SHIP` rounds that cannot prove an authorized blocker degrade through the existing malformed-ledger tolerance to a fresh round-1 review (GH #172 dependency decision; ADR 0057 decisions 1 and 3).
- A parsed architect `FIX-BEFORE-SHIP` outcome is narrowed before ledger persistence and PR planning: it remains blocking only when at least one finding passes the round-aware authority policy; otherwise it becomes `ACCEPT-WITH-NOTES` while retaining all reported findings.

## Files expected to change

- prompts/architect-review.md
- src/artifacts.ts
- src/artifacts.test.ts
- src/guardian-blocking-authority.ts
- src/guardian-blocking-authority.test.ts
- src/guardian-convergence.ts
- src/guardian-convergence.test.ts
- src/prompt-template.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/ship-gate.ts
- src/ship-gate.test.ts

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)

- Add a pure `guardian-blocking-authority` policy seam. Its input is guardian kind, round number, prior-lineage membership, class, disposition, `reachableTrigger`, and `introducedByReviewedDiff`; its output says whether that finding may contribute blocking authority. `INTEGRITY` and `DATA_LOSS` are the only later-new exception classes.
- Architect structured findings v2 use the exact finding keys `id`, `title`, `class`, `clearCondition`, `disposition`, `reachableTrigger`, and `introducedByReviewedDiff`. No new package dependency or database schema is introduced.
- The ship gate invokes the policy after stable lineage resolution and before constructing the persisted architect record or passing outcomes to draft-PR planning (ADR 0033; ADR 0057 decisions 1 and 3). The run-state sanitizer independently applies the same invariant while reading persisted rounds.

## Test plan

- Given architect prompt rendering, when the template is read in a focused prompt test, then it requires structured findings v2, defines both new fields and their exact value shapes, states the round-1 floor and later-round exception, and keeps impact/recovery plus self-gathered evidence rules (`pnpm vitest run src/prompt-template.test.ts`).
- Given structured guardian artifacts for architect v2 and PM v1, when parsing runs, then exact keys, nullable/non-blank trigger validation, boolean attribution validation, verdict cardinality, and PM compatibility are covered without invoking a live reviewer (`pnpm vitest run src/artifacts.test.ts`).
- Given the cross-product of round 1 versus later, prior versus new, reachable versus absent trigger, reviewed-diff attribution, `INTEGRITY`/`DATA_LOSS` versus another class, and resolved versus uncleared disposition, when the pure authority policy runs, then its table matches B-01 through B-03 (`pnpm vitest run src/guardian-blocking-authority.test.ts`).
- Given existing ID, alias, fingerprint, and collision fixtures, when authority evidence is carried through lineage, then stable/current IDs and dispositions remain unchanged and the new fields follow the current finding (`pnpm vitest run src/guardian-convergence.test.ts`).
- Given direct persisted-round fixtures, when an architect `FIX-BEFORE-SHIP` record has only triggerless or otherwise unauthorized findings, then the rounds collection is dropped by tolerant sanitization; a record with one authorized blocker loads, and PM v1 plus favorable/cache fixtures remain valid (`pnpm vitest run src/run-state.test.ts`).
- Given the existing ship-gate guardian fixture, when an architect returns `FIX-BEFORE-SHIP` with only unauthorized findings, then the saved architect record and PR decision observe `ACCEPT-WITH-NOTES` while retaining those findings; when one finding is authorized, existing blocked and override behavior remains. Add assertions to an existing fixture rather than spawning a new pipeline scenario (`pnpm vitest run src/ship-gate.test.ts`).
- Given the implementation, when slice verification runs, then execute `pnpm run typecheck` and `pnpm run test` through the declared executable gates.

## Definition of done

- [ ] Architect findings carry versioned reachable-trigger and reviewed-diff evidence from artifact parsing through lineage and persistence.
- [ ] Round-aware authority is applied before an architect outcome can block PR planning, and tolerant state loading cannot restore an impossible blocker.
- [ ] Later-new notes remain recorded, prior uncleared findings remain eligible to block, and PM plus #170 ledger behavior stays compatible.
- [ ] The focused unit and existing ship-gate fixtures bind every scoped behavior without adding a spawned pipeline scenario.
