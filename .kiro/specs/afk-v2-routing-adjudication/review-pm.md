**Verdict:** FIX-BEFORE-SHIP

## Blocking findings

### P1. A planner-written lock can bypass evaluator disagreement and human adjudication

**PRD requirement:** Stories 3, 4, and 10 require a contested contract
disagreement to survive through negotiation exhaustion, classify as an
impasse, and route to the human rather than being settled by an agent. The
implementation decisions also make contract locking an orchestrator-owned
transition.

**File and location:** `src/orchestrator.ts`, `negotiateAttempt`, especially
the non-`ACCEPT` verdict branch at lines 3321-3329 and
`lockRefusedByGate` at lines 2891-2897.

**Evidence read/run:** I read the current verdict branch and confirmed that
after the evaluator returns `REVISE`, it re-reads the planner-authored
`contract.md`. If that file says `LOCKED` and the mechanical gate returns no
independent objection, line 3329 breaks out of negotiation as successfully
locked. `lockRefusedByGate` reopens the file only when the gate objects; it
does not require evaluator `ACCEPT` or orchestrator lock provenance. I also
ran the focused ordinary-negotiation assertions. They passed, but their
planner fixture writes `NEGOTIATING`, so they do not exercise this path.

The resulting user outcome is wrong: a planner can write `Status: LOCKED`
while the evaluator records a blocking `REVISE` or `CONTESTED`
finding, and generation then starts without the required second round,
impasse park, or human decision.

**Required before ship:** Treat every agent-authored `LOCKED` candidate as
unauthorized. Only an evaluator `ACCEPT` followed by a passing mechanical
gate may write or retain `LOCKED`. Add focused cases for a pre-locked
candidate with evaluator `REVISE`, and with evaluator `ACCEPT` plus gate
refusal, proving both remain unlocked and never dispatch generation.

## Selected-slice verification

| Slice | Stories | Result | User outcome verified |
|---|---|---|---|
| 01 Scope escalation (#80) | 1, 2, 13 | Core flow delivered | Every generator entry point receives the same stop-before-edit instruction. Strict parsing, immutable attempt archives, focused planner/evaluator revision, undeclared-edit refusal, and same-round generation resume are present and passed focused pipeline verification. The shared negotiation authority defect in P1 must still be fixed. |
| 02 Impasse parking (#81) | 3, 6, 10, 15, 16 | Blocked by P1 | For honest `NEGOTIATING` planner output, pure contested exhaustion parks with both sides' evidence, independent work continues, dependents stay visibly held, and cancellation preserves the park. P1 leaves a path that bypasses exhaustion and therefore the promised park. |
| 03 Human decision resume (#89) | 4, 7, 8, 9 | Delivered after a park exists | Adjudication is strict and per-finding; every blocker needs a decision; evaluator and third-position decisions use one planner apply; the mechanical lock gate precedes generation; idle-only bounded waits support live pickup, expiry, next-run pickup, and cancellation. |
| 04 Code-assembled diagnosis (#82) | 11, 12 | Delivered | `renderStuckDiagnosis` deterministically renders lifecycle and evidence, every implementation `STUCK` return uses `finishStuck`, both stuck-specific prompts are deleted, and the shared resume path preserves the prior diagnosis. |

## Notes

- Lock-gate refusal after adjudication is persisted as
  `ADJUDICATION-LOCK-REFUSED`, although the PRD asks routing to preserve the
  existing terminal taxonomy. The phase clearly exposes the refusal,
  suppresses generation, and preserves the branch and decision evidence, so
  this difference does not independently block shipment.
- `archivedScopeEscalations` uses a shallower check than
  `parseScopeEscalation` when rendering `stuck.md`. Some correctly rejected
  malformed archives can therefore be labeled as structured escalation
  evidence. Routing still fails closed and retains the raw bytes, so this is
  a diagnosis-labeling issue rather than a control-flow defect.

## Verification

I read the PRD, all available selected-slice contracts and handoffs, and the
production and test paths for each promised transition. Fresh focused
verification passed 291 parser/artifact/diagnosis tests and 8 targeted
pipeline assertions covering focused scope revision, same-run adjudication,
independent and dependent scheduling, lock refusal, bounded expiry, and
next-run pickup.

I did not rerun the full suite because the pre-ship sanity gate already passed
this exact tree.

## Out-of-scope PRD gaps

- Slice 05 / #94, the babysit courier that presents both positions verbatim
  and writes `adjudication.md`, was intentionally not executed. Until that
  manual follow-up lands, the operator must supply the artifact directly.
- Story 14, relocating and globally installing the babysit skill, remains
  explicitly deferred by the PRD.
- Slice 06 / #129 (`afk adopt`) was not selected and has moved to
  `.kiro/specs/afk-v2-run-state-lock-and-adoption/`; it does not affect this
  branch's verdict.
