# Contract review — slice 01, Gate policy reader (round 1)

The contract locks. Every carried-over finding from the previous attempt is
answered, and the two things still worth changing are small enough to fix in
the same session the slice is built.

## Why this contract is testable

Each behavior names an entry point, an input, and a result a reader can compute
without running the code. The three exports each carry a success path, not only
rejections: `parseGatePolicy` returns prd.md D1's example deep-equal (B-02),
`matchesGlob` has six declared pairs with the expected boolean spelled out
(B-09), and `loadGatePolicy` is asserted twice — once over a `mkdtempSync`
directory whose `afk.config.json` carries a well-formed policy (B-08 case one)
and once over this repository's committed config (B-12). That closes the failure
mode the previous attempt left open, where an implementation that always
returned `null` satisfied every declared observable.

The static facts are assertions rather than reviewer inspection, which is what
makes them producible by the two gates the behaviors list. `resolveBaseGate‐
Declarations` ids for P-01, `readFileSync` + `JSON.parse` over the committed
config for P-02, and a source scan for "no `toLowerCase`, no
`./acceptance-manifest.js` import" for P-03 and B-10. I checked that P-01's
assertion can actually pass on an empty temp directory: `src/base-gates.ts:16-24`
maps `BASE_GATE_IDS` onto declarations whether or not `resolveSanityPlan` finds a
matching script, so the ids stay `["typecheck", "lint", "tests"]` and only
`required` varies. B-01's export enumeration is the piece that gives the word
"exactly" real evidence — typecheck alone can prove the six pinned names exist,
but only a sorted `Object.keys` comparison fails on a seventh.

The two case rules stay apart, which is the trap that cost the ancestor slice a
round. P-03 pins `src/acceptance-manifest.ts:64-71` as untouched — I confirmed
line 71 is the `toLowerCase()` that makes `fileScope` case-insensitive — while
B-10 asserts the new matcher is case-sensitive and shares no implementation with
it. B-10's `SRC/a.test.ts` case is the honest one: it matches, because `**`
absorbs the segment and no literal is compared there.

## Why the scope is evidence-backed and feasible

Three files, no migrations, no new dependency, and no consumer wired up, so with
`gatePolicy` absent every consumer keeps reaching `src/base-gates.ts`. The two
recorded calls are the right shape: `parseJsonWithUniqueKeys` exists in
`src/json-scan.ts` and is already used by `src/acceptance-manifest.ts`, and
keeping the unknown-key check local avoids exporting `requireExactKeys`, which
would edit a file this slice must not touch. Nothing in the repository asserts
the shape of the committed `afk.config.json` today, so adding the fourth
top-level key cannot break an existing suite. The non-goals name #195, #193, #85
and #86 against the specific decisions each owns, so a reader can tell why the
gate runner and the `GATE-SCOPE` channel are absent. The test plan is pure unit
tests with no git and no spawned processes, so the slice costs nothing in the
suite budget.

## Still worth changing

**The `protectedPaths` defaults are only half pinned.** B-03's text promises that
omitting *either* member returns the documented baseline, but the declared cases
only cover the `testGlobs`-omitted half. Nothing fails if the implementation
defaults `gatePolicyPaths` when the whole `protectedPaths` object is missing yet
throws when the object is present without that member — and since B-05 rejects
the near-miss key `testGlob`, a hand-edited config with one member is exactly
the case a user will hit. Add a fifth reduced policy whose `protectedPaths`
supplies `testGlobs` and omits `gatePolicyPaths`, or narrow B-03's wording to
what the cases cover.

**The `ARCHITECTURE.md` non-goal argues against the parent PRD without saying
so.** "No check requires one" is true — I looked, and no gate or test asserts
that a `src/` module appears in the module table; the only reader of
`architectureDoc` is `src/context-envelope.ts`, which ships the file's contents
into the envelope. But prd.md's ownership table (line 527) gives every slice,
01 included, "own rows" in `ARCHITECTURE.md`, and D6 accepts as a cost that this
dialect "must be documented, not inherited". Deferring the row is a defensible
call for a shared file; leaving the PRD row uncited and the documentation
obligation unowned is not. Either cite the row you are overriding and name where
the dialect gets documented, or bring `ARCHITECTURE.md` into scope with a
behavior that pins the added row.

Neither point changes the slice's shape, and neither blocks the build.
