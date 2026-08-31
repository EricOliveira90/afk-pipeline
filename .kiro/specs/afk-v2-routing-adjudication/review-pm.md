**Verdict:** FIX-BEFORE-SHIP

## Blocking finding

### 1. A mixed contested/open exhaustion bypasses the promised human-adjudication route

PRD stories 3 and 10 promise that a `CONTESTED` finding held at round
exhaustion becomes an impasse for a human decision, while non-convergence
routes the operator to fix the ticket. Slice 02 behavior B-01 makes the mixed
case explicit: if round-two exhaustion leaves *any* unresolved blocking
finding `CONTESTED`, the slice must surface `AWAITING-ADJUDICATION`.

The shipped classifier does something materially different. In
`src/contract-review.ts`, `buildContractNegotiationOutcome` (lines 735-750)
returns `IMPASSE` only when *every* unresolved blocking finding is
`CONTESTED`. A round-two result containing one blocking `CONTESTED` finding
and one blocking `OPEN` finding is therefore classified as
`NON_CONVERGENCE`. `src/contract-review.test.ts`, test
`classifies a contest mixed with an OPEN blocker as NON_CONVERGENCE`
(lines 1038-1080), asserts that exact behavior.

I read both locations and ran:

`pnpm vitest run src/escalation.test.ts src/adjudication.test.ts src/artifacts.test.ts src/adopt-command.test.ts src/logger.test.ts src/ship-gate.test.ts src/contract-review.test.ts src/run-journal.test.ts src/prompt-template.test.ts src/status-future.test.ts`

All 362 tests passed, including the mixed-exhaustion assertion. This confirms
that the current user-visible outcome is deliberate: the operator is told to
fix the ticket instead of receiving the contested point for adjudication.
That misses a selected slice's locked outcome and the PRD's core routing
promise.

Required before ship: preserve the non-convergence handling for `OPEN`
blockers without dropping the adjudication route promised for a coexisting
`CONTESTED` blocker.

## Selected-slice verification

| Slice | Result | Product evidence |
|---|---|---|
| 01 Scope escalation | Delivered | Generator and resume prompts provide the exact stop-and-escalate artifact; `parseScopeEscalation` fails closed; `runFocusedScopeRevision` re-evaluates and re-locks; the generator loop resumes in the same implementation round; raw attempts are archived before parsing. |
| 02 Impasse parking | Partial | Pure contested exhaustions park with verbatim evidence; independent and same-lane siblings continue; dependents remain undispatched and visible; cancellation preserves the park. The mixed-exhaustion blocker above violates B-01. |
| 03 Human decision resume | Delivered | `parseAdjudication` validates one finding decision, `waitForAdjudication` is bounded and cancellation-aware, and `runImpasseAdjudication` records decisions, applies them once, runs the lock gate before generation, and supports same-run and next-run pickup. |
| 04 Code-assembled diagnosis | Delivered | `renderStuckDiagnosis` deterministically orders archived finding, escalation, round, artifact, and commit evidence; `finishStuck` is the shared STUCK finalizer; the synthesis section and both dedicated stuck prompt files are gone. |
| 06 `afk adopt` | Delivered | `runAdoptCli` verifies a detached candidate merge with every base gate before moving the feature ref, refuses conflicts/gate failures/bad reasons without live-state mutation, persists complete provenance, and projects it into summaries and draft PR bodies. |

## Notes

- Adjudication lock-gate refusal now has the additional persisted phase
  `ADJUDICATION-LOCK-REFUSED`. This differs from the PRD's stated intent to
  preserve the existing terminal taxonomy, but it preserves the human
  decision and parked estate and gives the operator a more accurate remedy.
  I do not consider that product-safe deviation a separate blocker.
- A generator round permits two focused scope revisions and then fails closed
  on another escalation. The PRD and slice contract promise one focused
  revision and require the generator to list every needed path, so this is a
  reasonable bound for an unspecified repeated-escalation edge case.
- I did not rerun the full suite because the pre-ship sanity gate already
  passed this exact tree, as stated in the review instructions.

## Out-of-scope PRD gaps

- Slice 05 / issue #94, the babysit courier that presents both positions and
  writes `adjudication.md`, was intentionally not executed in this run.
- PRD story 14, relocating and globally installing the babysit skill, remains
  explicitly deferred.
