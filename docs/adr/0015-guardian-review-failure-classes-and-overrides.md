# ADR 0015 — Guardian review failure classes, scope-aware PM review, and cheap re-entry

**Status:** Accepted
**Date:** 2026-08-07

## Context

Every failure in the PRD 070 babysitting run occurred in the post-merge
guardian review phase. The generation phase was already hardened by
ADR 0014; reviews still collapsed every failure into a single terminal
`UNKNOWN` verdict:

- The architect and PM reviews always launched concurrently (even under
  `--serial-lanes`), and both codex wrappers persisted the same
  `AWS_CONFIG_FILE`. The loser of the rename race died at spawn with
  `failed to persist AWS config file: … Access is denied. (os error 5)`.
- A PM review re-ran the consumer's full ~8-minute Vitest suite under
  the 180 s default inactivity timeout and was killed mid-run — minutes
  after the pre-ship sanity gate had run that exact suite on the same
  SHA.
- A "Not ready" run left `review-*.md` and a governance-log append
  uncommitted in the review worktree, breaking the consumer's
  verify-draft flow (which requires a clean tree after the reviewed
  SHA) and forcing a manual commit-reviews-then-rerun-UAT ordering.
- The PM review judged the branch against the whole PRD, so any PRD
  with HITL slices dead-ended at FIX-BEFORE-SHIP forever and required a
  manually created override PR.
- Each fix→review round re-ran the sanity gate and both reviews from
  scratch: 25–40 minutes of mostly redundant re-execution, three times.

## Decision

**Review failure classes.** The single `UNKNOWN` verdict is replaced by
distinguishable outcomes, mirroring ADR 0014's infrastructure-retry
model:

- `NEVER_RAN` — the agent process died before producing any structured
  output (spawn/wrapper errors). Infrastructure-class.
- `DIED_MID_RUN` — the agent showed real activity and was then killed
  (idle watcher, tool cap) or exited nonzero. Infrastructure-class.
- `UNPARSEABLE` — the agent finished but the review file carries no
  recognizable verdict marker. Terminal, like the three real verdicts.

Infrastructure-class failures retry within the run using the existing
`--infrastructure-retries` budget (default 2) and never open a PR when
exhausted. Classification uses the provider's parsed stream activity:
no structured event before the failure means `NEVER_RAN`; idle-watcher
and tool-cap kills are always `DIED_MID_RUN`. The failing agent's
stderr line (embedded in the codex provider's rejection message) is
surfaced in `run-summary.md` next to the outcome, not only in launcher
stderr. Reviews also run with the slow-agent inactivity budget
(`--command-timeout-ms`, default 600 s) instead of the 180 s provider
default, and both review prompts state that the sanity gate already ran
so the full test suite must not be re-run.

**AWS-config isolation.** Every codex invocation receives its own
temporary copy of `AWS_CONFIG_FILE` (created via `mkdtemp`, removed on
exit). Wrapper writes land in the copy and are discarded — ephemeral
agents must not mutate the operator's real AWS config. Isolation
applies regardless of which credential source is present, because the
wrapper persists the config file either way. Additionally,
`--serial-lanes` now also serializes the two guardian reviews.

**Scope-aware PM review and recorded override.** The PM review prompt
receives the run's scope — selected AFK slices versus skipped slices
with their reasons (`hitl` / `not-selected`) — and must separate
blockers within the selected slices from PRD-level gaps outside the
run's scope; only the former may drive the verdict. For the cases where
the PM still blocks, `--open-pr-on-override` opens the draft PR despite
an unfavorable PM verdict and records the override and both verdicts in
the PR body. Only a real `FIX-BEFORE-SHIP` PM verdict can be overridden,
and only when the architect verdict is favorable — an override records
disagreement with a judgment, not the absence of one.

**Review artifacts always committed.** `review-architect.md`,
`review-pm.md`, and any governance-log change the guardians made are
committed to the feature branch regardless of verdict. They are
evidence either way, and a scratch review worktree is deleted at the
end of the phase — anything uncommitted is lost.

**Cheap re-entry.** The run state persists a `reviewPhase` cache:

- The pre-ship sanity gate result is keyed by the reviewed tree's SHA.
  Only PASS is cached (a FAIL could be an environment flake, and fixing
  a real failure changes the tree anyway). After the docs-only review
  commit, the cached key is refreshed to the new tree.
- A favorable review verdict (SHIP / ACCEPT-WITH-NOTES) is recorded
  against the post-commit HEAD and skipped on re-entry while HEAD is
  unchanged. Unfavorable and infrastructure outcomes are never cached.

Malformed cache entries degrade to a re-run; they never block
resumption.

## Consequences

- A spawn race or idle kill costs an infrastructure retry, not the
  whole review phase; the run summary states which class failed and why.
- Concurrent codex invocations no longer share mutable AWS config
  state; wrapper config writes are discarded by design.
- PRDs with HITL slices can reach a PR: the PM grades the branch
  against its scope, and a deliberate human override is recorded
  auditable in the PR body instead of happening out-of-band.
- A Not-ready run leaves the feature branch clean and evidence-complete,
  so consumer verify-draft flows and re-entry work without manual
  commits.
- A fix→review cycle re-runs only what changed: the gate is skipped for
  an unchanged tree and a favorable review for an unchanged HEAD.
- The three-round implementation cap and all ADR 0014 QA behavior are
  unchanged.
