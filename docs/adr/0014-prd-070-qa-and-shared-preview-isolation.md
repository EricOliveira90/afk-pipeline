# ADR 0014 — PRD 070 QA and shared-preview isolation

**Status:** Accepted
**Date:** 2026-08-04

## Context

PRD 070 exhausted all three generator rounds on a shared-preview PostgREST
connection-pool outage. Each evaluator run overwrote `qa-report.md`, stopped at
its first Pass 1 failure, and sent only that latest finding back to the
generator. Remote database UAT also raced across AFK processes, and migrations
were checked only after QA rather than applied centrally before remote tests.

## Decision

AFK separates two QA stages:

1. **Deterministic slice QA** runs sanity commands, local behavior checks,
   boundary checks, and preservation checks.
2. **Shared-preview UAT** is opt-in and runs only after deterministic QA passes.

QA reports declare `Failure class: NONE | IMPLEMENTATION | INFRASTRUCTURE`.
Implementation failures advance the generator round, which remains capped at
three. Infrastructure failures retry within the same round (two retries by
default) and become an operational `ERROR` if retries are exhausted; they never
become a false implementation `STUCK`.

Every attempt is archived as `qa-report-r<round>-a<attempt>.md` or
`uat-report-r<round>-a<attempt>.md`. Retry generators receive complete prior
QA report history. Evaluators must reconcile prior findings and include all
still-unresolved findings in each new report.

Shared-preview UAT holds `.afk/locks/shared-preview.lock` (or a configured lock)
across migration verification, migration apply, and remote evaluation. The lock
uses atomic directory creation and a heartbeat so independent AFK processes
serialize against the same preview database and can recover stale owners.

Central commands and agent invocations use configurable output-inactivity
timeouts. Stdout/stderr activity resets the command timer; the lock heartbeat is
independent. CLI controls are:

- `--command-timeout-ms <n>`
- `--heartbeat-interval-ms <n>`
- `--infrastructure-retries <n>`
- `--preview-verify-command <cmd>`
- `--preview-apply-command <cmd>`
- `--preview-lock-path <path>`

Both preview migration commands are required together. Verification runs before
apply, and both complete before the remote evaluator starts.

Only handoffs from a slice's declared `blockedBy` dependencies are injected.
Unrelated sibling handoffs are excluded from generator and evaluator context.

## Consequences

- Functional failures retain strict QA and the three-round implementation cap.
- Shared-preview incidents spend infrastructure attempts, not implementation
  rounds.
- Remote UAT costs an extra evaluator invocation only when explicitly enabled.
- Preview migration ownership moves from individual tests to the orchestrator.
- Projects must provide deterministic verify/apply commands before enabling
  shared-preview UAT.
