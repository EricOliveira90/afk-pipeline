# Product Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope

This review judges slices 01 (#80), 02 (#81), 03 (#89), 04 (#82), and
06 (#129). Slice 05 (#94) is out of scope.

## Fix before ship

### 1. A focused scope revision can silently remove previously locked paths

**PRD requirement:** Stories 1 and 2 promise that a too-narrow lock routes to
a focused contract revision instead of deadlocking. Slice 01 B-03/B-04 requires
the revision to preserve the accepted contract, add the requested paths, and
resume the generator with the complete revised file scope.

**Evidence gathered:**

- In `src/orchestrator.ts`, `reviseAcceptedContract` at lines 1222-1255
  validates behavior-ID stability, current contract/manifest consistency, gate
  bindings, and whether the newly requested paths exist. It never checks that
  every path from `previousManifest` remains in the revised contract and
  manifest.
- In `src/acceptance-manifest.ts`, `validateAcceptanceManifestStability` at
  lines 403-443 checks only unchanged behaviors that were renumbered. It does
  not compare the previous and current file scopes.
- I ran those production validators with a previous scope containing
  `src/original.ts` and `src/keep.ts`, then a revised contract and manifest
  containing only `src/requested.ts`. Both validators accepted the replacement
  and printed `accepted-consistently-shrunk-contract`.

**User impact:** A planner can add the escalation's requested path while
dropping paths from the already accepted lock. If the evaluator accepts that
pair, the transaction re-locks it and the fresh generator receives an
incomplete scope. The promised focused additive repair can therefore create a
new scope deadlock or authorize loss of already contracted work.

**Clear condition:** Before re-locking, require every previously declared path
to remain in both `contract.md` and `acceptance-manifest.json`, in addition to
the requested paths. Add a focused-revision test where the planner removes an
old path and assert `ERROR`, byte-for-byte rollback of the accepted pair, and
no fresh generator dispatch.

## Outcome verification

### Slice 01 - Scope escalation routes to contract revision

The canonical generator instruction, strict artifact parsing, raw attempt
archives, no-round-spend routing, transactional rollback, and lock gate are
present and exercised. The additive-scope guarantee above is not delivered.

### Slice 02 - Impasse parks the slice and the run continues

Delivered. Exhaustion distinguishes adjudicable impasse from non-convergence,
retains both positions and evidence, projects the parked branch and reason,
continues independent work, holds DAG dependents, and preserves the park on
cancellation.

### Slice 03 - A human decision resumes the parked slice

Delivered. Decisions are schema-validated per finding, partial decisions remain
parked, the wait is bounded, valid decisions redispatch in the same run, and a
later run consumes an existing decision. The contract locks only after all
blocking findings have decisions and the mechanical lock gate passes.

### Slice 04 - Stuck diagnosis assembled by code

Delivered. `stuck.md` is assembled deterministically from archived lifecycle,
escalation, artifact, and commit evidence. Malformed retained escalation bytes
do not abort diagnosis. All execution-side STUCK exits use the code finalizer,
and the two stuck-specific generator prompts are retired.

### Slice 06 - Verified manual adoption

Delivered. `afk adopt` verifies the detached candidate tree with every base
gate before an atomic feature-ref update, records PASS and full provenance, and
surfaces it in the run summary and draft PR. Reason, conflict, gate, branch
race, provider ambiguity, worktree, parked-estate, and state-write failures
refuse or roll back without silently adopting.

## Verification

Read the PRD and all selected-slice contract, acceptance, context, QA, and
handoff artifacts, then traced the production and focused-test paths for all
five selected slices.

Ran 393 focused tests covering escalation, adjudication, impasse
classification, contract transactions, evidence rendering, adoption,
persistence/reporting, late STUCK diagnosis, lane refresh, same-run
redispatch, and next-run pickup. All passed. The already-passed full suite was
not re-run.

## Non-blocking notes

- A generator receives at most two focused revisions in one implementation
  round. The anti-loop bound is reasonable but is not stated in the PRD.
- Legacy negotiation `stuck.md` still says `Outcome: ESCALATE` for an impasse,
  while structured state and live projections correctly say
  `AWAITING-ADJUDICATION`.

## Out-of-scope PRD gaps

- Slice 05 (#94), the babysit courier that presents both positions verbatim
  and writes the adjudication artifact, was not executed by this run.
- Story 14, repository-versioned/global babysit skill packaging, remains
  explicitly deferred.

These gaps do not drive the verdict.
