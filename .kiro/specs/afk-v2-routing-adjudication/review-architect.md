# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Blocking Finding

### A1. A generator can rewrite the accepted contract pair before escalation validation

**Convention:** ADR 0055 Seam 1 section 3 says the shared contract transaction
is the only way the accepted `contract.md` and `acceptance-manifest.json` pair
is mutated. ADR 0048's Decision likewise assigns scope mutation to the
orchestrator, not the generator.

**File and location:** `src/escalation.ts`,
`outOfScopeChangedPaths` (lines 158-188), especially the whole-directory
exemption at lines 180-184; `src/orchestrator.ts`,
`runSliceExecute` (lines 4250-4324), especially loading `lockedManifest`
after the generator returns at line 4258; and `src/contract-transaction.ts`,
`withContractTransaction` (lines 162-172), which captures the pair only when
the focused revision starts.

**Evidence read/run:** I read the generator return path, the changed-set guard,
and the transaction capture together. I also read
`src/escalation.test.ts:266-309`, which explicitly proves that every path
under the slice directory is exempt, including
`acceptance-manifest.json` and `contract.md`. I searched `runSliceExecute`
for a pre-invocation snapshot or post-invocation integrity check of the locked
pair and found none. `git diff --check
run/v2-routing-adjudication-host...HEAD` passed; I did not rerun the full
suite because the pre-ship gate already passed this tree.

A generator can therefore add an undeclared source path to both locked files,
then write an escalation for some other path. The orchestrator loads the
generator-modified manifest as `lockedManifest`; the changed-set check ignores
both modified control files because they are under `sliceArtifactDir`; and
`runFocusedScopeRevision` captures those modified bytes as the previously
accepted pair. Its additive guard then preserves the unauthorized path rather
than detecting it. The fresh generator receives a lock that it widened itself,
bypassing the orchestrator-owned mutation transaction and the pre-build scope
boundary.

**Required before ship:** Protect the accepted pair across every generator
invocation. Capture its bytes before dispatch and fail closed if the generator
changes either file, before escalation parsing, focused revision, gates, or QA.
Restore or otherwise preserve the last orchestrator-accepted bytes and retain
the attempted mutation as evidence. Keep the slice-directory exemption only
for agent-writable artifacts, or special-case these two orchestrator-owned
files. Add a focused test where a generator edits both files and emits an
otherwise valid escalation; assert `ERROR`, no planner/evaluator dispatch, and
byte-identical accepted artifacts.

## Structural Assessment

The shared contract transaction, one adjudication completion predicate,
replaceable park lifecycle, and tri-state estate probe otherwise centralize the
new state transitions coherently. The excised `afk adopt` implementation is no
longer present on this branch.
