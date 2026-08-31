# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Standards

### A1. Accepted-pair recovery is not unconditional

**Convention:** ADR 0008, Decision makes the on-disk contract the
orchestrator-owned source of truth. ADR 0055, Seam 1 section 3 requires
`contract.md` and `acceptance-manifest.json` to be restored byte-for-byte on
every non-accepted exit; ADR 0051 requires rollback by default.

**File and location:** `src/orchestrator.ts`, `runSliceExecute`'s generator
dispatch and rejected-mutation branch; `src/artifacts.ts`,
`archiveRejectedContractMutation`; `src/contract-transaction.ts`,
`restoreAcceptedContractPair` and `withContractTransaction`'s `finally`.

**Evidence read/run:** I read the current generator loop and confirmed it
captures the pair, awaits `invoke`, and only then checks for mutation. If the
generator changes either file and the invocation throws or is cancelled, the
outer catch returns without checking or restoring the pair. On the normal
return path, `archiveRejectedContractMutation` runs before restoration and
uses `flag: "wx"`; a collision or write failure therefore also skips
restoration. I read both rollback implementations and confirmed their
sequential writes stop after the first failed restore, potentially leaving
the pair half-restored. I inspected the focused tests; they cover successful
archival and rollback, not these failure exits.

This can leave an agent-authored lock or an internally inconsistent accepted
pair as the control state read by the next dispatch.

**Required before ship:** Put the integrity check and restoration behind
`finally` semantics, make evidence archival unable to prevent restoration,
and attempt both file restorations before reporting an aggregate failure.
Use one restoration primitive for the generator guard and transaction
rollback, with focused coverage for invocation failure, archive collision,
and each restore write failing.

### A2. Ordinary negotiation still trusts agent-written LOCKED status

**Convention:** ADR 0008, Decision says only the orchestrator writes
`LOCKED`, and only after evaluator `ACCEPT`. ADR 0055 section 4 requires every
lock to carry orchestrator provenance; section 5 requires the mechanical gate
to pass before anything writes `LOCKED`.

**File and location:** `src/orchestrator.ts`, `negotiateAttempt`, specifically
`recordGateObjection`, `candidateRefusedByGate`, and the verdict branch after
loading `contract-review.json`.

**Evidence read/run:** I read the current verdict branch and its gate helpers.
For an `ACCEPT` candidate already written as `LOCKED` by the planner, a gate
refusal records an in-memory `NEGOTIATING` state but never reopens the file,
leaving an ungated `LOCKED` contract on disk. For a non-`ACCEPT` verdict, the
code reads the planner-written status and breaks successfully when it is
`LOCKED` and the gate passes, even though the evaluator returned `REVISE`;
that lock also has no orchestrator provenance. I inspected the new ordering
test at `src/orchestrator.test.ts` and confirmed its planner writes
`NEGOTIATING`, so neither pre-locked path is exercised.

These paths let an agent grant generation authority despite the evaluator or
mechanical gate withholding it.

**Required before ship:** Treat every agent-written `LOCKED` candidate as
unauthorized. Normalize or refuse it before the gate, write `LOCKED` only in
the orchestrator's `ACCEPT`-after-gate branch, and never accept a
non-`ACCEPT` review because of the file's status. Cover both an `ACCEPT` plus
gate refusal and a `REVISE` plus passing gate with a pre-locked candidate.

## Spec

The four retained slices otherwise form the requested routing flow:
generator escalation, durable impasse parking, per-finding adjudication with
idle-only waiting, and code-assembled STUCK diagnosis. Slice 06 adoption code
is absent as required by the excision note. No separate spec-only blocker was
found beyond the authority and recovery defects above.

## Summary

Standards: 2 blocking findings. Spec: no additional findings. The worst risk
is authoritative contract state surviving from an agent mutation or being
accepted from an agent-written lock.
