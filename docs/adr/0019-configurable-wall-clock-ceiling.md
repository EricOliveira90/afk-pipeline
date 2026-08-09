# Configurable wall-clock ceiling, role-aware defaults, terminal ceiling kills

## Failure mode

The ADR 0016 wall-clock ceiling worked exactly as specified — and killed
a healthy generator. In a babysat PRD run on the Kiro backend, slice
"Execute an autonomous renewal safely in preview" had its generator
killed exactly 3_600_000 ms after start (`ERROR — Phase B returned
ERROR`). The session was not stalled: its log held zero spinner frames,
its branch carried six real commits (a migration, a gated handler, UI
states, end-to-end tests, a bundle fix), and its last file write was
~4 minutes before the kill. The lane successor went LANE-CANCELLED, so
the run lost its two remaining slices and produced no draft PR.

Generator durations measured across the same PRD: ~41 min, ~60 min, and
the killed slice exceeding 60 min. ADR 0016's premise that 60 minutes is
"comfortably above a legitimate generator invocation" does not hold for
heavy slices — the default sat directly on top of the real duration
distribution.

## Decision 1 — role-aware ceiling defaults

`SLOW_AGENT_MAX_DURATION_MS` (**7_200_000**, 120 min) applies to the
generator and evaluator-qa invocations — the same two roles that already
get `SLOW_AGENT_IDLE_TIMEOUT_MS` (ADR 0008 precedent), because the same
property (routinely shelling out to full builds and test suites) drives
both their idle profile and their total runtime. Short-lived roles
(explorer, planner, evaluator-contract, generator-stuck, guardian
reviews) keep the 60 min provider default from ADR 0016.

The ceiling stays a backstop, not a scheduler: raising it for the two
roles that legitimately run long does not weaken wedge detection for
them, because the progress-filtered idle watcher (ADR 0016 decision 2)
is the primary stall detector and fires within minutes, not hours.

## Decision 2 — `--max-agent-duration-ms` CLI override

A new runtime flag, parsed in `parsePipelineRuntimeOptions` alongside
`--command-timeout-ms` / `--heartbeat-interval-ms` /
`--infrastructure-retries`, threads through `PipelineConfig` as
`maxAgentDurationMs` and overrides the ceiling **uniformly for every
role**. It complements the role-aware defaults rather than replacing
them: with the flag absent, the defaults above apply; with it present,
one predictable number governs all invocations.

Uniform-override semantics were chosen over per-role flags because the
operator's mental model when reaching for this knob is "my biggest slice
needs N hours", and a larger ceiling on a role that finishes in five
minutes costs nothing — the ceiling only matters when exceeded, and the
idle watcher still guards fast roles that wedge.

## Decision 3 — a ceiling kill during slice execution is terminal

Observed behaviour — straight to ERROR (displayed STUCK) at
`gen:1 eval:0` with no retry — is kept and now deliberate, for the
generator path:

- Exceeding the ceiling is not transient. NEVER_RAN / DIED_MID_RUN
  (ADR 0015) model infrastructure flakes where a rerun plausibly
  behaves differently; a generator that used its whole budget will use
  it again. An automatic retry restarts the round from scratch against
  the same ceiling and doubles the wasted wall-clock before failing the
  same way.
- The remedy is an operator decision, not a rerun: raise
  `--max-agent-duration-ms` (or split the slice). To make that
  discoverable, `runSliceExecute` appends the remedy to the recorded
  error when the failure message matches the ceiling-kill shape, and
  `persistOutcome` now prefers the failure site's specific detail over
  the wave layer's generic `Phase B returned ERROR` label when writing
  run-state and the run.log outcome line — so the run says *why* the
  slice died and *what to do*, not just `STUCK gen:1 eval:0`.
- Committed generator work survives on the slice branch (the killed
  slice above had six commits); a rerun with a larger ceiling resumes
  from the persisted state, not from zero value.

Deliberate asymmetries, unchanged by this ADR:

- **evaluator-qa inside `runQAStage`**: the existing attempt loop
  retries *any* rejection — including a ceiling kill — within the
  `--infrastructure-retries` budget without consuming an implementation
  round. QA reruns are idempotent and comparatively cheap, and with the
  120 min default a QA ceiling kill is expected to be rare.
- **Guardian reviews**: a ceiling kill classifies as DIED_MID_RUN and
  retries within the run (ADR 0015). Reviews are short; a review that
  hits 60 min is far more likely wedged than working.

## What stays untouched

- The provider-side default (`DEFAULT_MAX_DURATION_MS` = 3_600_000 in
  each provider) — it remains the floor-level backstop for any caller
  that passes nothing.
- ADR 0007's idle floor and tool-call ceiling, and ADR 0016's
  progress-filtered liveness.
- `InvokeOptions.maxDurationMs` — already accepted by all three
  providers; this ADR only makes the orchestrator finally pass it.
