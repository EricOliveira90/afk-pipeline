# Contract review — round 3

## The case spelling is still wrong in the manifest

The round-3 response says the `fileScope` entry now reads `ARCHITECTURE.md`. It does
not. `acceptance-manifest.json:21` still reads `architecture.md`, and the revision's
own record of what changed in that file lists five regions — B-03's scenario prose,
P-04's scenario prose, P-10's scenario prose, and two inserted `"typecheck"` gate ids.
The `fileScope` array is not among them, so nothing in this round could have fixed it.

What makes this round worse than the last is that the definition of done was rewritten
to state the rule the manifest breaks. It now reads that the `fileScope` is exactly the
"Files expected to change" list, "each path spelled as `git ls-files` reports it —
`ARCHITECTURE.md` in that upper-case spelling, so the `scope` gate, which compares path
strings rather than case-folded ones, does not report the build order's last commit as
an out-of-scope change on a case-insensitive checkout." That is a good line; it names
the hazard precisely and explains why the case matters. It is also, right now, a line
the pair fails to satisfy. `git ls-files` in this worktree returns `ARCHITECTURE.md`;
contract.md:392 lists `ARCHITECTURE.md`; build-order step 5 is "The `ARCHITECTURE.md`
rows", carried by the second commit. So the last commit of the slice touches a path the
manifest does not declare under the spelling git reports, and on Windows the build will
look fine until the gate runs.

The whole fix is one character-case edit to line 21 of the manifest. Please make it in
the manifest itself rather than restating the requirement in the contract.

If the response was written against an intended edit that never reached disk, check the
file before asserting the condition next round: the verification command quoted in the
response reports the repository's spelling, not the manifest's, so it cannot confirm
the two agree.

## The type-level gate attribution is fixed

P-04 and P-10 now carry `typecheck` alongside `tests` and `acceptance:behaviors`, and
P-09 still does. Better than the minimum: each of those entries' `observableResult` now
says out loud which half of its claim only the compiler can see — P-04 that the helper's
signature and its `GateDeclaration`/`GateResult` types are what the call sites compile
against, P-10 that "every existing call site still compiles unchanged with the optional
argument absent is observable only to the compiler". And the new definition-of-done line
generalises the rule, citing `CLAUDE.md`'s note that vitest strips types without checking
them. A future reflow that drops the attribution now violates a written rule instead of
slipping through unnoticed. Nothing further needed here.

## One thing the reflow cost, minor

B-03's `then` still claims `runCleanerStage` "returns `{ ran, outcome, inputTreeId,
outputTreeId, roundsSpent }`", but the rewritten `observableResult` dropped the half that
checked it. The prior text named assertions on "the exported stage id and the returned
shape"; the new text names the fixture journal's ordering plus "a unit assertion on the
exported stage id". The ordering claim is genuinely clearer than before — naming the
"final evaluation and reuse" fixture and the journal is an improvement — but the shape is
now asserted in the `then` and observed nowhere in that entry.

It is advisory rather than blocking because most of the shape survives elsewhere: B-04
observes `roundsSpent` 0 and `inputTreeId === outputTreeId`, and B-08 observes the outcome
values. Only `ran` and the shape as a whole lose their named assertion. Either add the
returned-shape assertion back to B-03's observable, or drop the shape from its `then` and
let the entries that do observe those members carry the claim.
