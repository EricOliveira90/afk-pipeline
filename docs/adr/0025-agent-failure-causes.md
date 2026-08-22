# Agent failure causes: classified once, carried as the outcome's reason

## Failure mode

A contract evaluator that died mid-tool-call failed its slice with a
fixed string:

```
Negotiation returned ERROR
```

That text is what reached the run state, the next run's retry
announcement, the event stream, and `afk status`. Three unrelated
situations were indistinguishable in it:

- the agent provider hung up with a non-zero exit (`codex-wrapper:
  error: failed to persist AWS config file`),
- the orchestrator killed the invocation itself (idle timeout,
  wall-clock ceiling, tool-call cap),
- the evaluator lived and wrote a real `ESCALATE` verdict.

The operator's only recourse was opening `.afk/logs/<slug>/run-*/` by
hand and guessing which agent log belonged to the failure. Worse, the
negotiate phase had no retry at all: `--infrastructure-retries` covered
the QA loop and the guardian reviews, so a single transient death during
contract negotiation ended the whole wave — the failure class the flag
exists for was the one place it didn't apply.

## Decision

Classify the failure **once, where it happens**, and carry the
classification as the outcome's reason.

`runSliceNegotiate` returns a `NegotiateOutcome` — a discriminated union
over `LOCKED` / `CANCELLED` / `{STUCK|ESCALATE|ERROR, cause}` — instead
of a bare phase string. The `NegotiateFailureCause` names one of five
kinds:

| kind | means | retried |
|---|---|---|
| `provider-exit` | provider hung up with a non-zero exit; carries `exitCode` | yes |
| `orchestrator-kill` | we killed it; carries `killClass` | yes |
| `transient-exhausted` | ADR 0022's retry window closed on an unresolved outage | yes |
| `verdict` | nothing died — the evaluator decided; carries `verdict` | **no** |
| `internal-error` | the pipeline itself threw (git, filesystem) | **no** |

Each cause carries a `summary`: one operator-facing line naming the
cause, the role, the exit code or kill class, and a collapsed tail of the
dead invocation's output. `wave.ts` records that summary verbatim as the
`WaveOutcome`'s `error`. From there it flows unchanged through every
existing channel — run state, the retry announcement, `events.jsonl`,
`afk status` in both forms — because all of them already read the
outcome's reason. No parallel reporting path was added.

### Infrastructure retry for the negotiate phase

Infrastructure causes retry under the existing
`--infrastructure-retries` bound (default 2), reusing the existing
`infrastructure-retry` warn reason so there is one retry vocabulary
across QA, guardians, and negotiation.

A retry re-enters the phase. It is idempotent by the existence checks
already there: `context.md` on disk means the explorer is skipped, a
drafted `contract.md` is revised rather than re-derived, and the round
counter restarts — so a retry consumes neither an explorer invocation
nor a contract round.

A `verdict` cause is terminal on the first occurrence. Retrying it would
re-run agents against a contract the evaluator has already judged, burn
the budget, and eventually report the same verdict — while hiding the
real answer behind three rounds of noise.

`internal-error` is deliberately *not* retried. Its blast radius (git
failures, filesystem errors) is a different problem with different
remedies, and widening the retry surface to cover it is out of this
change's scope. It is still classified and named, so it no longer hides
behind the generic ERROR text.

## Why classification reads the provider's message

`killClass` and `exitCode` exist only in the string each provider builds
when it rejects (`claude.ts`, `codex.ts`, `kiro.ts`), so the classifier
pattern-matches those messages. This is the house idiom, not a new one:
`classifyReviewFailure` in `artifacts.ts` already classifies guardian
review deaths the same way, including the same dash-agnosticism (codex
writes `- killed`, claude and kiro write `— killed`).

Transient failures are the exception and are recognised structurally via
`isTransientProviderError`, which matches on `Error.name` — so the check
survives duplicate module instances, and kiro's transient message
(`exited with code N — model temporarily unavailable`) classifies as
`transient-exhausted` rather than `provider-exit`.

Threading structured failure data out of all three providers instead
would be the cleaner design, but it changes every provider and its tests
for no behavioural gain here; the message is the wire format either way.

## Output tail

The tail is read from the invocation's agent log after
`closeAgentLog` has awaited the stream's flush, so it is complete. It is
collapsed to the last three non-empty lines joined with `/` and capped at
240 characters, because the reason has to stay a single line: run state
stores it as one JSON string and the retry announcement embeds it in one
`run.log` line. Reading the log is best-effort — an unreadable log
yields no tail rather than masking the real failure.

`verdict` causes carry no tail. The artifact the evaluator wrote is the
evidence, and it is already on disk under the slice directory.

## Consequences

- `runSliceNegotiate`'s return type is no longer assignable to
  `WaveOutcomePhase`; callers destructure `.phase`.
- The strings "Negotiation returned ERROR", "Negotiation refresh
  returned ERROR", "Contract negotiation escalated after max rounds" and
  "Contract not locked after negotiation" are retired. Anything grepping
  run logs for them breaks by design — the replacements say strictly
  more.
- One dead contract evaluator no longer ends a wave.
