# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Blocking Findings

### A1. Accepted-pair recovery can be skipped or only half-applied

**Convention:** ADR 0055, Decision - Seam 1 section 3 requires the accepted
`contract.md` and `acceptance-manifest.json` pair to be restored byte-for-byte
on every non-accepted exit. ADR 0048, Decision assigns scope mutation to the
orchestrator and requires a refused amendment to leave the contract untouched.

**File and location:** `src/orchestrator.ts`, `runSliceExecute`, lines
4291-4299; `src/artifacts.ts`, `archiveRejectedContractMutation`, lines
374-395; and `src/contract-transaction.ts`,
`restoreAcceptedContractPair`/`withContractTransaction`, lines 159-170 and
349-376.

**Evidence read/run:** I read the generator-mutation refusal in
`runSliceExecute` and confirmed it calls `archiveRejectedContractMutation`
before `restoreAcceptedContractPair`, without `finally`. I read the archive
implementation and confirmed its `flag: "wx"` write intentionally throws on
an existing stamp and can also throw after archiving only the first file. I
then read both rollback implementations and confirmed their sequential writes
are not isolated: failure restoring `contract.md` prevents any manifest
restore, while failure restoring the manifest leaves a half-restored pair.
The current integration assertions at `src/orchestrator.test.ts:1700` and
`:1746` cover only successful archival and restoration.

An archive collision or filesystem write failure can therefore leave the
generator's unauthorized lock bytes on disk, or leave the accepted pair
internally inconsistent. The slice reports `ERROR`, but the next dispatch
reads control state that the orchestrator did not accept.

**Required before ship:** Capture the rejected bytes independently of the live
files, make restoration unconditional even when evidence archival fails, and
attempt both file restorations before reporting an aggregate rollback error.
Add focused coverage for an archive failure and for each restoration write
failing.

### A2. Ordinary negotiation writes LOCKED before its mechanical gate passes

**Convention:** ADR 0055 section 5 mandates gate-before-lock ordering and says
that `LOCKED` on disk is the gate's attestation. ADR 0008, Decision makes that
on-disk status the authoritative contract state.

**File and location:** `src/orchestrator.ts`, `negotiateAttempt`, lines
3264-3282, together with `lockRefusedByGate`, lines 2845-2850.

**Evidence read/run:** I read the ACCEPT branch and confirmed
`artifacts.lockContract()` writes `LOCKED` at line 3271; only afterward does
line 3281 call `lockRefusedByGate`, which invokes `ctx.onContractLocked` and
reopens on objection. I also read the prior-lock recovery at lines 2942-2961;
it revalidates on a later dispatch but does not remove the crash window in the
current one.

A process stop between those calls leaves an authoritative `LOCKED` contract
whose migration/run-specific gate never passed. A later run can repair it, but
until then disk asserts the exact invariant ADR 0055 says must not be written.

**Required before ship:** Evaluate the mechanical gate against the accepted
candidate before calling `lockContract`; write the status and provenance only
after the gate passes. Preserve the existing objection-to-next-round routing.

## Structural Assessment

The shared transaction, adjudication completion predicate, replaceable park
lifecycle, idle-only wait, and tri-state estate probe otherwise align with
ADRs 0054-0055. The excised adoption implementation is absent from the
shipping source diff.
