# Contract review — round 2

## What the revision fixed

All three prior findings are closed on their own terms, and the work behind
them was real rather than cosmetic.

**F-01.** B-07 now stops where the evidence stops: it asserts the four totals
and per-artifact weights on the thrown `ContextEnvelopeConfigurationError`'s
`message`, in a named test file, and explicitly hands the run.log /
run-summary.md half to B-10. B-10 does not assume a formatter exists — it
states that the recording path is added by this slice and names it end to end
(`renderPromptPreparationRefusal`, `promptPreparationRefusalSection`,
`logger.phase` → `RunJournal.phase` for `run.log`, `Logger.writeSummary` for the
summary), with `src/logger.test.ts` as the host. The "does not exist today"
claim holds against the repository: the summary table renders a slice's
recorded `error` only for `AWAITING-ADJUDICATION`, and `src/wave.ts` turns a
thrown `runSliceExecute` error into `{ phase: "ERROR", error: msg }` with no
`logger.phase` call, so an `ERROR` slice's refusal text reaches neither
artifact. B-06's `src/logger.ts:472` citation also holds — that line is exactly
`total.promptBytes += event.assembledByteSize;` — and quoting the statement
inline means the citation now carries its own evidence rather than asking a
reader to trust the line number.

**F-02.** The manifest-version-bump sentence is gone from both places it
appeared, which is the removal branch the finding offered. The contract no
longer claims a backward-compatibility guarantee that the generator context
manifest's version does not actually provide, and it replaces it with the
distinction that a reader can genuinely observe: field presence.

**F-03.** B-09 names `src/context-envelope.test.ts` in both halves of the pair
and in the test plan, with the reason recorded, and its gate set now matches
every other non-preservation behavior.

## What still blocks the pair

Both remaining problems are the same problem in two places, and both were
introduced by this revision rather than inherited: the obligations the planner
moved out of B-07 and out of the deleted version-bump sentence landed in
`contract.md` prose only. Neither B-10 nor P-05 exists in
`acceptance-manifest.json`, which stops at B-09 and P-04.

That matters because the acceptance manifest is the gate-bearing half of the
pair. The `acceptance:behaviors` gate runs
`vitest run --reporter=json --testNamePattern {behaviorId}` over manifest
behavior ids; a behavior that exists only in the contract has no `gateIds`, no
`observableResult`, and no id for that gate to select.

**B-10 (F-04).** B-07 now says in as many words that it "stops at the thrown
message" and that "B-10 owns carrying that message into run.log and
run-summary.md". With no B-10 manifest entry, that ownership lands nowhere:
AC7's output-artifact half is asserted by the contract, checked off in the
definition of done, and enforced by nothing. An implementation that never adds
either rendering function passes every gate. Before the split, this obligation
was inside B-07, which is a manifest entry — so the split, as it stands, lost
enforcement it previously had.

**P-05 (F-05).** The same shape. B-06 discharges the optional-on-read
guarantee by pointing at P-05, the "Changes to existing behavior" section
points at P-05, and the definition of done has a checkbox for it — but there is
no P-05 in the manifest. The consequence is precisely the one the prior round
described: `src/resume-integration.test.ts` and `src/orchestrator-runs.test.ts`
remain declared in `fileScope` with no manifest behavior saying what they must
assert, and nothing fails if the new event fields are made required and a
pre-slice journal stops resuming.

## What to do

Add the two entries to `acceptance-manifest.json`. The contract already
contains the substance for both — the given/when/then material, the host test
files, and for P-05 the read rule at `src/logger.ts:465-466` it preserves — so
this is transcription into the gate-bearing artifact, not new design work.
B-10 takes `preservation: false` and the standard `typecheck` / `tests` /
`acceptance:behaviors` gate set; P-05 takes `preservation: true` and the same
gates, with its observableResult naming both journal-replay seams. No
`fileScope` change is needed: every file involved is already declared.

One non-blocking note for whoever implements rather than for the revision:
B-10 labels `src/orchestrator.ts:8041` the "repair" seam, but that call site is
inside the merge-resolution round's `dispatchGenerator`, while an ordinary
repair round assembles through `:5838` with a `mode` variable. Both real call
sites are covered, so the wiring instruction is complete — only the label is
loose.
