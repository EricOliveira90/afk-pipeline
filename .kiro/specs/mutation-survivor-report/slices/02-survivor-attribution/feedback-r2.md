# Contract review — round 2

Slice: `02-survivor-attribution` (GH #304)

The revision closes both blocking gaps and both advisories, and it does so by
adding mechanism rather than by adding prose around the old mechanism. Nothing
in the changed text opens a new gap.

## The absence-versus-unusability collision (F-01)

The prior pair had one read status carrying two incompatible obligations: a
missing declared file was `UNREADABLE`, B-06 demanded silence for it, and B-08
demanded a note for it. The revision introduces a distinct `ABSENT` status on
the two new readers, defined by `existsSync` and by nothing else, and narrows
`UNREADABLE` to a path that exists but throws and `MALFORMED` to a path that
reads but does not parse. B-06 keys its silent branch on the omitted-or-`ABSENT`
input; B-08 keys both notes on `UNREADABLE` or `MALFORMED` and says outright
that `ABSENT` and the omitted input are B-06's. The branches are now disjoint by
construction, so the two same-slice tests that would have asserted opposite
notes for one input cannot both exist.

Three things make this more than a definitional fix:

- **The distinction lives in one place.** B-09 states that the call site probes
  nothing itself and passes each read result straight through, `ABSENT`
  included, so the absent-versus-unusable question is not re-answered a second
  time with a second chance of answering it differently.
- **The divergence from `readMutationReport` is declared, not incidental.**
  B-04 states that the existing reader is not changed, and P-06 plus the
  manifest's B-04 observable pin the existing missing-report `UNREADABLE` case
  (`src/mutation-report.test.ts:219` — present and `#303`-tagged) as unedited.
  So #304's silence about a missing baseline does not leak into #303's
  `REPORT_UNREADABLE` / `MUTATION_NOT_RUN` path, which must stay loud.
- **The distinction is observable cheaply.** The absent case writes no file; the
  present-but-`UNREADABLE` case puts a directory at the declared path. That
  works on this platform — a directory at the path gives `existsSync` true and
  `readFileSync` `EISDIR`, confirmed on this Windows host — so no permission
  simulation is needed, and the test plan, the manifest's B-04/B-06/B-08
  observables and a Definition-of-done check all require the pair per file.

B-06 also now states the absent-`decisionsPath` outcome explicitly, which the
prior pair left unstated: no `accepted` label, every baseline label left exactly
as it is, no note.

## Preservation behaviors and the acceptance gate (F-02)

Five preservation behaviors previously declared `acceptance:behaviors` while
their observable was that `#303`-tagged tests pass untouched, which the gate
cannot select evidence from. The revision resolves this with the retitle rule,
stated once at the head of "Existing behavior to preserve" and then anchored per
behavior in both artifacts.

The mechanism holds against the gate as implemented. Coverage is counted per id
by `fullName.includes(behaviorTag(issueNumber, behaviorId))`
(`src/acceptance-gate.ts:108-120`, `behaviorTag` at `:246-251`), and the pattern
handed to `--testNamePattern` is an alternation over every bound id
(`behaviorSelector` at `:262-273`). Each required tag therefore matches
independently, so one test name can carry both `[behavior:#303:...]` and
`[behavior:#304:P-0x]` and prove both slices without removing #303's coverage.
This is established practice here rather than a novel move — dual issue-qualified
tags on one name already exist at `src/cleaner-stage.test.ts:548` and `:871`,
`src/final-evaluation.test.ts:506`, and `src/logger.test.ts:1263` and `:1281`.

Every anchor the revision names was checked and each is a real test already
carrying a `#303` tag: `src/afk-manifest.test.ts:203`, `:276`, `:288`;
`src/logger.test.ts:1719`; `src/ship-gate.test.ts:2411`, `:2449`, `:2487`,
`:2577`; `src/mutation-report.test.ts:131`, `:219`, `:398`, `:513`, `:659`.
Retitling a `describe` does carry the tag into every assertion's `fullName`
inside it, which is how P-04, P-05 and P-06 are covered without touching an
`it`.

Two Definition-of-done checks make the obligation checkable rather than
aspirational: one requires a `#304`-qualified passing assertion for every id
from `B-01` through `P-06`, and one requires that the retitle be the *whole*
edit — `git diff` on each preserved test shows changed `describe`/`it` name
strings and nothing else. That second check is the right expression of the
"assertions unedited" promise these behaviors are actually making.

## The two recorded assumptions (F-03, F-04)

Both advisories asked for the same thing: state the assumption and name what it
costs when it is wrong.

**Baseline format.** B-04 no longer asserts the incremental artifact's shape as
settled fact. It records the shape as this slice's assumption, states that no
sample file and no schema artifact exists here to confirm it, and cites the
precedent for that gap in the code — `src/mutation-report.ts:83-88` already
records the report shape as hand-derived "because no schema artifact exists in
this repository". The containment is named at the parser: a differently shaped
baseline parses `MALFORMED`, which B-08 routes to `BASELINE_UNUSABLE` with every
survivor `unattributed`, so a wrong shape can cost attribution but never
produce a wrong label. An operator reading "everything unattributed" next to
`BASELINE_UNUSABLE` is one step from the cause, which is what makes this
diagnosable instead of mysterious.

**Two match keys.** B-07 now names the tension instead of leaving a reader of
B-07 alone unable to see that its key is the one B-05 calls unstable. It
attributes the id-plus-file key to the recorded decision it cannot amend
(`src/mutation-report.ts:46-50` does declare the decisions file keys by the
tool's own id; amending ADR 0071 is an explicit non-goal), and states the
consequence in both directions — a stale `ACCEPT` entry either matches nothing,
so its survivor is re-raised carrying its baseline label, or matches whichever
mutant now holds that id in the same file, so a survivor no human adjudicated is
labeled `accepted`. Stating the unsafe direction is the right call; the harm
bound it gives is also correct against this contract, since no label reaches a
gate, verdict or PR-open condition (B-12) and an `accepted` survivor stays in
the list at full detail under the suppression non-goal. The exposure is one
mislabeled bullet a reviewer can check against the decisions file — never a
hidden survivor, never a changed outcome.

B-05's own rationale is restated the same way: location-and-mutator matching
rests on a conservative assumption that costs nothing if it is wrong, because
that key is stable under renumbering either way.

## Other checks on the revision

- **Gate aptness.** The manifest changes to `gateIds` are formatting only; no
  behavior gained or lost a gate. `typecheck` still rides the behaviors that
  change types (B-01, B-09, B-11, P-03), and `acceptance:behaviors` is now
  satisfiable for every id that declares it.
- **Parser regression surface.** The new `parseMutationDecisions` binds both
  halves: valid text returning `PARSED` with the pinned key spellings, and each
  refusal returning `MALFORMED` naming the offending member, with the reader
  boundary cases (`ABSENT` versus `UNREADABLE`) asserted alongside. Inline
  object and string literals are the established harness for this file, and the
  contract says so rather than leaving a fixture surface undeclared.
- **New vocabulary scope.** The one new status member is declared in "New
  patterns / deps / schema" and confined to the two new readers' unions,
  deliberately kept off `MutationReportRead` (`src/mutation-report.ts:61-64`,
  which is where that type in fact lives).
- **Explorer unknowns.** The unknowns that could have blocked a lock are all
  answered by the pair: where attribution is computed (B-09, inside
  `runMutationStep`), the decisions parser's identity (B-04, a new function
  following the ADR's discipline rather than literally reusing
  `parseAfkManifest`), the match keys (B-05, B-07), the degradation vocabulary
  (B-08), and whether the path validation is factored (B-02, one local helper
  the three paths share).
