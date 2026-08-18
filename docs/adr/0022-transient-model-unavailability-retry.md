# Retry transient model unavailability with backoff at the orchestrator

## Failure mode

Model backends have outages measured in minutes; agent CLIs retry for
seconds. In the PRD 075 babysit run, two generator deaths ~4.5 h apart
ended identically: kiro-cli printed `Retry #3, retrying within 10.0s..`
then `The model you've selected is temporarily unavailable` and exited
nonzero — total internal retry span ~30 s. AFK saw only
`Agent generator exited with code N`, the slice went ERROR, and the
lane behind it was cancelled. Each death cost a full lane of work for a
condition that had cleared by the time anyone looked.

AFK's existing retry layer doesn't cover this: `runQAStage`'s
infrastructure retries apply only to the evaluator-qa stage, and
planner/generator invocations were single-shot.

## Decision 1 — providers classify, the orchestrator retries

Providers are the only layer that can see *why* an invocation died, so
classification lives there; policy (whether and how long to wait) lives
in the orchestrator, uniform across providers.

- `TransientProviderError` (src/agent-provider.ts) marks failures
  expected to clear on their own. `isTransientProviderError` checks by
  `name`, surviving duplicate module instances.
- The kiro provider keeps a bounded 16 KB tail of combined output; a
  nonzero exit whose tail matches `/temporarily unavailable/i`
  classifies as transient (`classifyExitError`). Claude and Codex
  currently classify nothing — their CLIs have different failure
  shapes and no observed evidence yet; the seam is one error class
  away when they do.
- Kills are never transient: idle kills, ceiling kills, tool-cap
  kills, and cancellations propagate untouched.

## Decision 2 — elapsed-time window, exponential backoff

`withTransientRetry` (src/transient-retry.ts) wraps both invoke
wrappers (per-slice in `makeSliceContext`, guardian-level in
`runPipeline`):

- Backoff schedule 30 s → 60 s → 120 s → 240 s → 480 s, the last delay
  repeating. The first retry is quick (the outage may already be
  over); later ones spread out rather than hammering a struggling
  backend.
- The window (default **15 min**, `--transient-retry-window-ms`,
  0 disables) is *elapsed time from the first transient failure*, and
  a retry is scheduled only when its full delay still fits. Attempt
  duration counts against the window — a CLI that burns a minute
  failing eats a minute of budget — so the operator's worst-case
  slice delay stays predictable: window + one attempt.
- Each retry logs to run.log and the agent's own log
  (`generator hit a transient model outage — retry 2 in 60s`), and the
  agent log stream is reused across attempts (append mode), so the
  whole story lives in one file.
- The backoff sleep is abort-aware: Ctrl-C rejects the pending sleep
  with `CancelledError` immediately — a pipeline is never stuck
  waiting out an outage the operator no longer cares about. The sleep
  timer is deliberately ref'd: waiting out an outage is legitimate
  work and must keep the event loop alive.

## Why a window and not a retry count

Counting retries couples the budget to the schedule; a window states
the operator-meaningful quantity directly — "how long am I willing to
wait for the model to come back before the slice fails". It also
composes with the observed outage profile (minutes, not seconds) and
with future schedule tweaks.

## Relationship to existing retry layers

| Layer | Trigger | Budget |
|-------|---------|--------|
| CLI-internal retries | request-level blips | ~30 s, not ours |
| This ADR | provider-classified transient outage | elapsed window, default 15 min |
| `--infrastructure-retries` (ADR 0014/0015) | QA/guardian invocation died or self-classified INFRASTRUCTURE | attempts, default 2 |
| Pipeline re-run | anything terminal | human |

A transient retry happens *inside* one invocation attempt from the
QA-stage's perspective, so the layers stack rather than overlap: the
QA stage only sees a failure after the transient window is exhausted.
