# A run that dispatched nothing fails, and says which slices it held back

## Failure mode

`runPipeline` decided success with

```ts
const allSuccess = afkSlices.every((s) => completed.has(s.ghIssue));
```

`Array.every` is vacuously true over an empty selection, and it is also
true when every slice in `completed` was restored from a prior run's
state rather than run by this invocation. So a pipeline that dispatched
no slices at all reported `success: true`, and the three entrypoints
exited 0.

The operator-visible result was a run that finished in ~0m00s, printed a
summary with no slice rows, and exited clean — indistinguishable from a
run that did the work. The per-slice `NOT-RUN` log lines explaining the
hold-back were already emitted, but they scroll past above a success
exit, and nothing in the exit status contradicted them.

This is worse than a plain false negative: the exit code is the signal
CI and babysit loops key off, so a fully-blocked run looked like a
green build.

## Why `completed` could not answer the question

The obvious fix — "fail if `completed` is empty" — is wrong in both
directions:

- `completed` is seeded from persisted state before the first wave, so a
  run whose slices were *all* merged by a prior run has a non-empty
  `completed` and dispatched nothing. That run is genuinely successful:
  there was nothing left to do, and re-running is the normal idempotent
  no-op the resume path is built for.
- Conversely a run can dispatch slices that all fail, leaving
  `completed` empty — already a failure by the existing rule, needing no
  new signal.

So the question "did this invocation do anything?" is not derivable from
`completed`, which deliberately mixes restored and freshly-earned
completions. It needs its own record.

## Decision

Track two disjoint sets alongside `completed`:

- **`dispatched`** — slices this invocation handed to a wave (recorded
  where wave outcomes are persisted, so it covers failures too, not just
  passes).
- **`alreadyComplete`** — slices skipped because persisted state says a
  prior run merged them.

A run is a **zero-dispatch no-op** when both are empty. Such a run is
unsuccessful, and `PipelineResult` carries a new optional
`failureReason` naming every unrun slice with its unresolved blockers,
reusing the hold-back text already computed for the `NOT-RUN` log lines
rather than re-deriving it:

```
Pipeline dispatched no slices and skipped none as already complete — nothing ran.
  #5001 Held back — held back by unresolved dependency [#4999 (outside run scope)]
  #5002 Also held back — held back by unresolved dependency [#5001]
Fix the blocker(s) and re-run.
```

The three entrypoints print `failureReason` when present, falling back
to the existing generic failure line. `failureReason` is set only when
`success` is false, so it is safe to treat as "the reason, if the result
doesn't already explain itself".

**Cancellation is excluded.** A run aborted before its first wave has
`dispatched` empty, but Ctrl-C already has its own exit path (ADR 0003)
and an operator who cancelled does not need to be told nothing ran. The
check is gated on `!signal?.aborted` so the abort path keeps reporting
`ABORTED`, not a spurious no-op diagnosis.

## Exit codes are unchanged

No new exit-code taxonomy: a zero-dispatch run exits 1 through the
existing `!result.success` branch. Distinguishing "blocked" from "failed
while running" in the exit status would make every caller's status
handling wider for no decision it currently needs to make — the
distinction lives in the printed reason, which is where an operator
reads it. If a caller later needs to branch on it programmatically,
`failureReason`'s presence is already the discriminator, and a dedicated
code can be added then without revisiting this decision.

## Consequences

- A fully-blocked run now exits non-zero, so CI and babysit loops that
  treated it as green will start reporting it. That is the point, but it
  is a behaviour change for any caller that was (unknowingly) relying on
  the false green.
- The guardian reviewers are unaffected and still must not run on an
  untouched branch; the zero-dispatch case reaches the summary having
  invoked no agent at all, which the tests pin.
