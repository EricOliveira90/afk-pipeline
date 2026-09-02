# Intent: mistake-twice → memory proposal loop (AFK scope)

Author: founder (via Kiro session, 2026-09-02). Status: approved for the AFK v2 roadmap.
Source: Anthropic AI-native SDLC playbook (CLAUDE.md working rule: "when a review flags the same mistake a second time, the correction goes into CLAUDE.md as part of that review").

## Problem

AFK applies this rule manually today. The AGENTS.md launch-command correction was a Track 4 hand task, done only after run 5 burned 8 generator commits on the same mistake. Recurring findings across rounds/runs do not automatically become steering amendments; they wait for the founder to notice the pattern.

## Proposed outcome

A pipeline output, not a new agent: when a finding recurs across rounds or runs, the run summary / guardian output gets a section proposing amendments to `AGENTS.md`, `ARCHITECTURE.md`, or `prompts/`. Proposals land as ordinary diffs in the draft PR, reviewed like any other change.

## Affected users and systems

AFK maintainer (founder), run-summary generation, guardian output format, §3c policy 3 (ARCHITECTURE.md honesty guards — pairs naturally).

## Constraints and non-goals

- Proposals only — the loop never edits steering files directly outside the PR review path.
- Recurrence threshold is two (same finding class, second occurrence), matching the playbook rule.
- No new memory store; the targets are the existing steering files.
- Format must converge with Rumo's Close learning pass (see rumo-app `docs/prds/close-learning-pass/intent.md`): one shared shape for recurrence-triggered proposed diffs.

## Resolved decisions

- V1 matches exact stable finding classes. Classifier similarity is out of scope.
- Write canonical `learning-proposals.json` from tracked review and spec history.
- Render proposals in the run summary and draft PR body.
- Commit proposal artifacts. Never edit steering files automatically.
