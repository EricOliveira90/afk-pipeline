# Contract review — round 3 — Eval runner (#262)

The contract pair is accepted. The one finding routed into this round is
resolved, and nothing the revision changed opens a new gap.

## F-08 — cross-slice listing assertion — resolved

Round 2 turned a scope statement into an assertion over the whole of
`eval-packs/`, which this slice's own non-goals guaranteed would go red:
#263 (S2) is contracted to add `eval-packs/afk/` and
`eval-packs/fixtures/consumer-governance/` onto the same feature branch, and
the `tests` gate runs again at pre-ship after siblings land. The fix asked
for was to bound the assertion to what this slice actually owns.

The revision does exactly that, in both artifacts and in both halves of the
behavior:

- `acceptance-manifest.json` B-28's `then` now asserts that
  `eval-packs/fixtures/refused/` contains no other file, and says in terms
  that the listing is bounded to the directory this slice owns rather than to
  all of `eval-packs/`, naming the two sibling paths that must be allowed to
  appear.
- B-28's `observableResult` pins a recursive listing of
  `eval-packs/fixtures/refused/` to exactly `["01-unknown-member.json"]`.
- `contract.md`'s B-28 bullet (lines 223-234) and the matching test-plan line
  (lines 349-353) carry the same bound, with the same reason stated.

No directory-wide absence claim over `eval-packs/` survives in either
artifact, so #263 doing exactly what it is contracted to do can no longer
falsify an S1 test on the merged branch.

The scope lock this all started from is intact where it belongs: the sentence
naming `eval-packs/fixtures/refused/01-unknown-member.json` as the only
committed pack S1 adds still stands as prose in the scope lock
(`contract.md:38-40`), and the definition of done's `git status` clause plus
the single `eval-packs/` entry in the file scope keep that claim enforceable
without an assertion that reaches into a sibling's territory. That is the
right division: prose for the scope intent, a test for what this slice's own
diff can be held to.

## Nothing further

The revision touched only the B-28 region in each artifact. Every other
behavior entry, scope term, gate binding and file-scope path is unchanged
from the text reviewed in round 2, and the changed text raises no new
question about gate aptness, scenario honesty, evidence-backed scope,
blocking unknowns, single-session feasibility or the declared non-goals. The
pack reader's regression surface is still bound on both sides — B-01 for
accepted input, B-02–B-07 and B-28 for refused input, with the committed
fixture path declared in the file scope.

One note carried forward from the explorer rather than from the contract:
#264 (`src/prompt-recorder.ts`, `--record-prompts`) is already merged on this
checkout, contradicting `prd.md`'s "Verified facts" section. The contract
already handles this correctly — its non-goals name #264 as merged and put it
out of scope — so no change is needed here; it is worth keeping in front of
the implementer so nothing gets re-derived.
