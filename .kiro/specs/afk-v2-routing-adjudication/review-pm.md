**Verdict:** FIX-BEFORE-SHIP

## Blocking findings

### 1. Ambiguous adjudication JSON can apply the opposite human decision

The PRD Solution and stories 7 and 9 require a schema-validated human
decision to resolve one finding, then pass through the mechanical lock step.
An ambiguous artifact must fail closed; applying whichever duplicate value
the JSON runtime keeps does not preserve the human's decision.

Evidence gathered:

- File and location: `src/adjudication.ts`, `parseAdjudication` (lines 67-145).
  I read that the function calls `JSON.parse` and checks the resulting keys,
  but never checks the raw JSON for duplicate keys.
- I ran `parseAdjudication` against a current `IMPASSE` with this raw artifact:
  `{"version":1,"findingId":"F-01","winningPosition":"PLANNER","winningPosition":"EVALUATOR","author":"human"}`.
  It was accepted and returned `winningPosition: "EVALUATOR"` instead of
  refusing the contradictory decision.
- The focused `src/adjudication.test.ts` suite passed, confirming its invalid
  input matrix does not currently protect this outcome.

Required before ship: reject duplicate keys in both incoming adjudication
artifacts and persisted decision logs before any decision can be recorded,
applied, or used to prove a lock.

### 2. `afk adopt` can silently merge into a different PRD's run

PRD story 17 and slice 06 behavior B-01 promise that the named PRD's finished
slice is verified, merged into that run's feature branch, and recorded in
that run's state. Prefix-sharing PRD names can currently select another
PRD's state and mutate its branch.

Evidence gathered:

- File and location: `src/adopt-command.ts`, `resolveRunSlug` (lines 164-206).
  I read that no-provider discovery accepts any state slug equal to the PRD
  slug or beginning with `<prdSlug>-`, without proving the suffix is a
  provider qualifier or that the state belongs to the requested PRD.
- I ran `runAdoptCli` in a temporary Git repository containing the requested
  PRD `api`, no `api.json` state, and an unrelated `api-v2.json` state whose
  feature branch was `feat/api-v2`.
- `afk adopt api 129 ...` exited 0, reported adoption into `feat/api-v2`,
  moved that branch, and wrote slice `129` into `api-v2.json`.

Required before ship: discover only the exact PRD run and valid
provider-qualified variants, and refuse when ownership cannot be proved.

## Selected-slice verification

| Slice | Result | User outcome checked |
|---|---|---|
| 01 Scope escalation | Delivered | Initial and resumed generators receive the canonical stop-and-escalate instruction; strict validation and immutable archives fail closed; accepted focused revision is additive, lock-gated, transactional, and resumes generation without spending the implementation round. |
| 02 Impasse parking | Delivered | Pure contested exhaustion parks with both positions and evidence; mixed open/contested exhaustion names both remedies; independent and same-lane siblings continue; dependents remain visible and blocked; cancellation preserves the park. |
| 03 Human decision resume | Blocked | Bounded same-run and next-run pickup, per-finding durable decisions, cancellation, lane refresh, and the apply-and-lock transaction are present. Finding 1 means the decision artifact is not reliably fail-closed. |
| 04 Code-assembled diagnosis | Delivered | `stuck.md` is deterministically assembled from archived lifecycle, escalation, round, artifact, and commit evidence; all STUCK exits use the code finalizer; the synthesis invocation and both stuck-specific prompts are retired. |
| 06 `afk adopt` | Blocked | Candidate-tree gates, conflict/gate/reason refusals, provenance persistence, summary and draft-PR reporting, and provider-qualified runs are present. Finding 2 permits silent cross-PRD adoption. |

## Notes

- Adjudication lock refusal now persists as
  `ADJUDICATION-LOCK-REFUSED`, although the PRD says routing should not add a
  new terminal taxonomy. The status preserves the human decision and gives
  the operator the correct remedy, so this difference does not independently
  block the promised outcome.
- A generator implementation round allows two focused scope revisions before
  refusing another. The selected contract promises the route but does not
  define repeated-escalation behavior; the bounded refusal retains evidence
  and is reasonable.

## Verification

I ran focused suites only, as instructed: 390 tests passed across escalation,
contract review, artifacts, prompts, adjudication, contract transactions,
run journal, status, adoption, reporting, CLI routing, and estate handling.
I also ran the two temporary runtime probes described above. I did not rerun
the full suite because the pre-ship sanity gate already passed this tree.

## Out-of-scope PRD gaps

- Slice 05 / issue #94, the babysit courier that presents both positions
  verbatim and writes `adjudication.md`, was intentionally not executed.
- PRD story 14, relocating and globally installing the babysit skill, remains
  explicitly deferred and does not affect this verdict.
