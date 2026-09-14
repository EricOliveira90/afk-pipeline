# Contract feedback — round 1

## What this round settled

Both findings carried in from the previous attempt are met, and met in the way
that makes them stay met.

The cleaner archive filename is no longer written from the wrong reading of the
two slots. B-13, the S3 test-plan bullet, the definition-of-done line and the
manifest all name `cleaner-log-r1-a3.log` *and* say out loud which counter each
letter holds — `r` is the generator round, `a` is the cleaner round, the order
`src/orchestrator.ts:6962-6972` passes them in. That agrees with the explorer's
reading of the caller. The temptation the earlier round left open — fixing the
assertion by re-mapping `archiveCleanerLog`'s arguments, which would rename
every log already on disk — is now an explicit non-goal with `src/artifacts.ts`
kept out of file scope, so the escape hatch is closed structurally rather than
by request.

The restore budget is likewise nailed down by name. B-03 states that
`roundsAlreadySpent` is the `roundsSpent` the just-finished stage returned, held
in memory at the call site, and states the route it must *not* take —
`cleanerRoundsSpent(resumableCleanerStage)`, whose `PASS`-terminal predicate
would hand the restore three fresh rounds and make S3's zero-remaining state
unreachable. P-04 keeps the persisted resume bound as a separate route into the
same limit, so the new hand-off reads as an addition rather than a replacement.
S3 is now reachable under the obvious implementation, not only under one.

## What still blocks the lock

**The route can never reach the cleaner.** B-01 selects the *last* id in
`writingStageIds`. B-02 builds that list, when the cleaner committed, as
`[CLEANER_STAGE_ID, POST_APPROVAL_WRITING_STAGE_ID]` — cleaner first, because
the cleaner runs before the injectable writing stage. The last id is therefore
`post-approval-writing` in exactly the case that is supposed to select the
cleaner, and the contract's own test-plan bullet asserts that outcome for that
exact list. Read together, B-01 and B-02 make `CLEANER_STAGE_ID` selectable only
by a single-element list that B-02 never constructs. Everything downstream —
B-03's re-dispatch, B-04's revert and `EXHAUSTED` record, the manifest's B-02
claim that S3 "sees the RESTORE handled by the cleaner branch", and S3's own
"the restore route names `cleaner`" — is unreachable on a faithful
implementation of the two behaviors as written, while the DoD line ("passes the
cleaner's id exactly when the cleaner committed") reads as satisfied. Pick one
composition and make the three places agree: either the list carries only the
stages that actually wrote in the order the selection rule reads — the
production stub being a literal no-op contributes no id — or the selection rule
is something other than "last".

**The model-time column has no source.** B-09 sums "the matching `stage-duration`
events" out of `events.jsonl`, and B-10 renders that as a column. No such record
is evidenced: no existing event member carries a duration at all, and the
model-time channel that does exist derives per-role durations by pairing
`phase-started`/`phase-ended` (`src/stage-durations.ts:114-139`) — a file this
contract correctly declares read-only. So the seeded-stream unit test cannot
seed the field the manifest promises to assert field by field, and the generator
would have to invent an event kind or quietly substitute a different source.
Either name the pairing the stream already supports, with its key, or drop the
field and its column from B-09, B-10, the test plan and the manifest. Dropping
it costs nothing this issue's acceptance criteria ask for.

## Smaller notes

The S3 path pins a `reviews/` directory segment that the declared evidence does
not reach — the artifact-path builder for `.afk/artifacts/<run-slug>/slice-<n>/`
is an open unknown, only the filename line at `src/artifacts.ts:772` was
located. Since `src/artifacts.ts` is out of scope, a mismatch surfaces as a red
assertion rather than a false pass, so this is not blocking; but the DoD line
would then be unmeetable without reopening the contract. Pin the stem and let
the directory be whatever `archiveCleanerLog` writes into.

On breadth: the contract holds two separable features — the restore
re-dispatch/revert path and the ROI evidence family — sharing only the emission
point, each with its own scenario in the heaviest suite. The file list is
coherent and nothing here is unbuildable, so this is a note rather than an
objection; if the session runs long, the ROI half is the one that ships on its
own.

## Elsewhere in the pair

Gate choices fit their behaviors: the pure-function and type-shape behaviors
carry `typecheck`, the run-level ones carry `tests`, and every behavior carries
`acceptance:behaviors`. The spawned-scenario discipline is respected — S1 is the
one new spawn with a stated reason, S2 and S3 are `it`s on the shared fixture,
and the heavy-suite choice (`test:heavy:qa`) matches where the fixture lives.
The additive-event claim (`EVENTS_SCHEMA_VERSION` stays 1) matches how
`quality-stage-policy` shipped, and P-06 pins the historical-stream case. The
non-goal list correctly names the `CleanerRoundRecord` field inversion, the
hardener, the watchdog temptation and this repo's own `afk.config.json`.
