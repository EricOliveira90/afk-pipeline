# Contract review — round 1

## The waiver chain now has an owner for every link

The one thing the previous attempt left unowned was the middle of the applied-waiver
chain: something has to read an applied waiver out of a *passed* `feedback-integrity`
gate, emit the event and stamp run state. Nothing in the repository handed the
orchestrator those findings on the PASS path, and the three files that could have been
widened to carry them are frozen by this slice's own Definition of done.

B-12 answers that directly and picks the door that does not require touching a frozen
file: the orchestrator re-reads the written evidence. Checking the anchors against the
worktree:

- `readGateEvidence` is exported at `src/gate-runner.ts:968`, so importing it is not an
  edit to that module.
- `gateArtifacts.push(...postQaGates.artifacts)` really is at `src/orchestrator.ts:6001`,
  and the CANCELLED / ERROR branches follow at 6002-6007, so the stated insertion point
  is reached on the path where waivers matter.
- `GateRunOutcome.findings` and `GateResult.findings` are optional and copied into the
  recorded result regardless of status (`src/gate-runner.ts:77-82`, `706-709`), so a PASS
  outcome carrying `appliedWaivers` does reach the evidence file. The same is true of
  `detail`, which is what makes B-05's PASS-with-waivers and B-07's
  policy-omission `detail` both observable without widening any type.

With B-13 owning the version 3 → 4 run-state field plus the de-duplicating
`saveAppliedWaivers`, B-14 owning the `## Applied Waivers` rendering, and B-12's
observable binding the event *and* the persisted record on one existing spawned
orchestrator scenario, the failure mode that blocked the last attempt — a
`waiver-applied` variant nothing emits and a run-state field nothing writes, both green —
is no longer reachable. The Definition of done restates the same property in the terms an
implementer can check.

## Why the rest of the contract is lockable

Gate aptness holds: every behavior is bound by `tests`, the schema- and type-shaped ones
(B-01, B-03, B-09, B-12, B-13) also by `typecheck`, and `lint` is correctly never cited
since the catalog marks it non-executable. Each observable names a declared file.

Scenario honesty holds on the cases that could have drifted. B-08 is candid that it
exercises a declaration built with `acceptedPairIntact: false` rather than a live run —
the orchestrator throws on a mutated pair before the post-QA gates, so this is a
fail-closed unit property and the manifest says so. B-06 tests the authority question that
matters (a worktree-authored waiver exempting nothing) by injecting the launch manifest,
not by hoping the gate ignores the worktree file. B-04 pins the comparison to the same
candidate source `scope` and `tests:skipped` already take, which retires the explorer's
open question about the deleted-test base. B-11 resolves the other open question by
naming `archivedScopeEscalations`' hand-rolled `parsed.version !== 1` check as work rather
than assuming the archived record upgrades itself, and `renderStuckDiagnosis` does live in
the declared `src/artifacts.ts`.

Scope is evidence-backed. The file list matches what the behaviors touch, `src/afk.ts` is
cited as a read-only path and correctly absent, and the frozen list — `gate-runner`,
`post-qa-gates`, `candidate-gate-phase`, `base-gates`, `gate-policy`,
`acceptance-manifest` — is consistent with the seam B-12 chose. Non-goals name the
neighbours that could otherwise leak in: no park record for a gate finding, no second skip
detector, no second scope-revision channel, no reconciliation of the two escalation doors,
no gate-cache participation for a `run`-based gate (which also disposes of the explorer's
`GateCacheKey` unknown). P-01 through P-06 pin the version-1 escalation language, the
already-implemented already-edited refusal, the per-round bound, the ADR 0061 prompt
sections, #86's fail-closed skip behavior and byte stability of a waiver-free
`run-summary.md`.

Single-session feasibility is real but not comfortable — this is a wide slice. The work
partitions cleanly along module lines and only two assertions need a spawned pipeline,
both added as `it`s on existing scenarios per the repo's cost discipline rather than as new
spawns. A sensible order is the waiver reader (B-01, B-02), then the gate module (B-03 to
B-08), then the producing seam and its stores (B-12 to B-14), then the escalation channel
(B-09 to B-11, B-16), leaving the skip-gate re-homing (B-15) and the evaluator rubric text
(B-17) last since neither blocks anything else.

## Two things worth tightening, neither blocking

B-14 asserts that the rendered section names the slice, but the payload its own Given
describes carries only the waiver's four fields. Every per-slice run-event member already
carries `ghIssue`, so this is satisfiable — say so in the payload description rather than
leaving the renderer to source an undeclared value.

`prd.md`'s D5/D6/D22 prose still attributes this work to "slice 01". The contract's claim
to those decisions is well supported by #193's body and slice 08's context, but the
contract never records that the prd.md phrasing is stale, which leaves the settled
cross-slice record reading as though two slices own `src/afk-manifest.ts`. One sentence
fixes it.
