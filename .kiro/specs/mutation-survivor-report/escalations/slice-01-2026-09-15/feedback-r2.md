# Contract review feedback — round 2

Slice: `01-mutation-report-step` (GH #303)

## What the revision settled

All six findings from round 1 are closed, and each one is closed by evidence I
could check against the source rather than by prose.

**The run-state pin (F-01).** `src/eval-boundary.test.ts` is in the file scope
and B-13 authorizes exactly one literal and its comment inside it, with P-05
stating what must survive: the import-boundary assertions and the
`EVENTS_SCHEMA_VERSION` pin at `1`. The source agrees with the contract's
citations — `src/eval-boundary.test.ts:127` is the pin inside the `P-05` case
that starts at `:108`, `src/run-state.test.ts:990` is the other pin with its
`[3, 4, 5, 6]` list on the following line, and `src/orchestrator.test.ts:5829`
uses the constant symbolically and needs no edit. Two pins, both authorized, so
`pnpm run test` can go green inside the lock. Keeping the bump rather than
retreating to event-only persistence is a defensible call and the contract
records why, including who reads the field back.

**The ARCHITECTURE.md cap (F-02).** The internals-cell placement is the right
shape and the premise checks out: the file is exactly 150 lines, the
`| Ship path |` row at line 33 carries `src/preship.ts`, `src/handoff.ts`, and
the `src/prompt-recorder.ts` precedent in the `| CLI entries |` row at line 17
is real. Worth noting in the implementation's favour: the cap assertion at
`src/eval-boundary.test.ts:293-304` pins only the `| Agent eval |` row's cells
plus the `<= 150` length, so nothing today constrains the cell being widened.
The change is now under B-08 with its own observable result, a Test plan bullet,
and a rewritten done item.

**The start seam and the bound (F-03, F-04).** Moving the start ahead of the
mode fork is the correct read of why the round-1 placement could not work: an
element of `Promise.allSettled` is awaited by the very `await` that would have
had to observe the guardians settling. `reviewDir` is a `RunShipGateArgs` field
(`src/ship-gate.ts:580`), so it is in scope at the declared start point. The
pair now names all three instants — started before the fork, origin captured
after the fork rejoins, awaited under the bound — and the bound is drivable from
`src/mutation-report.test.ts` with an injected `now` and a never-settling
promise, keeping fake timers away from the suite that spawns real git.

**Evidence alignment and the ADR assertion (F-05, F-06).** The `mutationRun`
seam is the right instrument, and the stdout obligation is now a discriminating
assertion (differently-shaped report on stdout versus the JSON at `reportPath`)
rather than an unobservable absence. Likewise the absent gate id became a
positive set comparison against a flag-absent run. B-17 names its test file and
enumerates its literals, and says plainly that the list is the whole claim.

## What the revision opened

One gap is new, and it is a direct consequence of the F-03/F-04 fix rather than
a leftover.

Starting the step ahead of the fork and awaiting it only after the fork rejoins
creates a path where the gate leaves with the step still in flight. A rejected
guardian rethrows at `src/ship-gate.ts:941-944` in the parallel branch, and a
rejecting `await runGuardianReview(...)` propagates the same way in the serial
branch at `:931-933` — both before control reaches the declared await. On that
path the step promise is never awaited, the 30-minute bound never starts, and
`terminate` is never called, so any process the step registered in `reviewDir`
outlives the gate. `quiesceWorktree` has no call site in `src/ship-gate.ts`
today (it is reached only through `src/git.ts:296`), so nothing in the declared
pair contains it.

This matters because the contract itself makes two commitments the path
violates: B-12's "no tolerated detached post-exit process" and ADR 0035's rule
that a live `cwd` blocks worktree deletion on Windows. It also matters because
P-03 explicitly asserts the rejecting-guardian scenario in both modes, so the
round already runs the case that produces the orphan — and the pair does not say
what the implementation should do there. Round 1's placement could not produce
this, since the rethrow happened only after every `allSettled` element had
settled.

The fix is small: say in B-11/B-12 that the guardian-rejection path terminates
the step through the same `terminate` binding (or awaits the bounded helper)
before the rejection propagates, and give P-03's rejecting-guardian scenario an
observable that sees it — for example, `src/ship-gate.test.ts` asserting that
`terminate`/`quiesceWorktree` was called on `reviewDir` and no mutation process
remains registered when the rejection leaves the gate.

## Smaller note, not a finding

B-12 cites `src/ship-gate.ts:948` as "the point where `architectResult` and
`pmResult` are both assigned". The assignments are at `:931-933` and `:945-946`;
`:947` closes the fork and `:948` is blank. The intent — the first instant after
the fork rejoins — is unambiguous and correct, so this is a citation nicety, not
something to revise for.
