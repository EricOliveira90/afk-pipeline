# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Blocking Finding

### A1. The adoption state "CAS" is an unlocked read-check-write

**Convention:** ADR 0055 section 11 requires adoption's state write to be a
compare-and-swap against the record observed before verification, and states
that a concurrent run touching the slice must make adoption refuse rather than
win by last writer. ADR 0018's Concurrency section only establishes that a
synchronous read-modify-write cannot interleave on one Node process's event
loop; it does not protect this command from a separate pipeline process.

**File and location:** `src/run-state.ts`,
`saveSliceStateIfUnchanged` (lines 484-498), especially the load at line 493,
comparison at line 495, and unconditional `writeFileSync` at line 497.
`src/adopt-command.ts:894-968` moves the feature ref and then relies on this
helper to report a lost state CAS.

**Evidence read/run:** I read both production call sites and searched
`src/run-state.ts` and `src/adopt-command.ts` for any file lock, mutex, atomic
conditional replacement, or generation check spanning that sequence; none
exists. The helper loads the file, compares one slice record, and later
overwrites the whole state file. I also read
`src/run-state.test.ts:518-590` and `src/adopt-command.test.ts:1447-1493`.
The former places the competing record before the helper starts; the latter
injects a fake `persistSliceState` that reports `{ ok: false }`. Neither test
creates an update between the production comparison and write.

Another process can therefore persist `AWAITING-ADJUDICATION` after line 495
and before line 497. Adoption then overwrites that park with `PASS`, returns
success, and strands the live adjudication estate. A concurrent update to any
other slice can also be lost because the helper rewrites the full previously
loaded state object. This is the corruption ADR 0055 section 11 says the CAS
must make impossible.

**Required before ship:** Make the state mutation genuinely cross-process
conditional. For example, serialize every run-state writer on a shared
inter-process lock and perform load, expected-record comparison, mutation, and
commit while holding it; a lock used only by adoption is insufficient. An
equivalent generation-based or transactional store is also acceptable. Add a
deterministic test that pauses the production primitive after comparison,
writes a competing park through another writer, then proves adoption refuses
and rolls the feature ref back without losing either record.

## Structural Assessment

The shared contract transaction, single lock predicate, tri-state estate
probe, and replaceable park lifecycle centralize the invariants required by
ADRs 0050-0055. No other structural violation warrants blocking shipment.

The pre-ship sanity gate is accepted as passed for this tree; I did not rerun
the full suite. `git diff --check main...HEAD` passed during this review.
