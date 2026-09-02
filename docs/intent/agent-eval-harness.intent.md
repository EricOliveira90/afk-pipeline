# Intent: agent-behavior eval harness (AFK scope)

Author: founder (via Kiro session, 2026-09-02). Status: approved for the AFK v2 roadmap.
Source: Anthropic AI-native SDLC playbook ("Continuous evals in CI" play), adapted to AFK v2 plan.

## Problem

AFK regression-tests its orchestrator code exhaustively, but changes to `prompts/`, `agents/`, and envelope policy are verified only by the next live PRD run — the most expensive possible feedback signal. Run 5 burned 8 generator commits on a steering defect that a replay test would have caught before launch.

## Proposed outcome

A replay harness that runs recorded real cases against agent roles and checks the verdict/output:

- 20–50 scenarios built from recorded envelopes/rounds: PRD 1, the reliability wave (#111–#121), evaluator verdict cases, classifier cases.
- Runs on a cadence and on demand when `prompts/`, `agents/`, or envelope policy changes — not per-PR (model-call cost is real).
- Every future incident becomes a permanent scenario, extending the existing issue→ADR→test discipline to agent behavior.
- Results land as item-13-style first-class measurements with a standing trigger. Results never gate merges (noisy measurements report, never block — the test:budgets lesson).

## Affected users and systems

AFK maintainer (founder), the eval runner (new), `prompts/`, `agents/`, envelope recording/replay machinery, item 13 measurement culture, story 17 ROI framing.

## Constraints and non-goals

- No merge gating on pass-rate. Report-only.
- Reuse recorded envelope format; do not invent a parallel fixture format.
- The runner must be reusable by consuming repos: Rumo adds a governance scenario pack later (see rumo-app `docs/prds/governance-evals/intent.md`). AFK owns the runner; consumers own their scenario packs.

## Resolved decisions

- Run weekly and manually when relevant configuration changes.
- Compare exact structured dispositions in v1. Do not use a model-based grader.
- Enforce a model-call cap. Report `INCOMPLETE` when the cap stops a run.
