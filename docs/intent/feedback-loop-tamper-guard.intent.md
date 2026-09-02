# Intent: feedback-loop tamper guard (AFK scope)

Author: founder (via Kiro session, 2026-09-02). Status: approved for the AFK v2 roadmap.
Source: Anthropic AI-native SDLC playbook ("Give Claude a feedback loop" play: an agent fixing code must not be able to weaken the check on that code).

## Problem

§3c policy 1 lists "deletion of tests or gates" as an escalation risk class, but that rule is prompt text only. Prompt text is advisory; a generator can ignore it. Nothing deterministic stops a generator diff from deleting a test, skipping a test, editing the gate catalog, or touching suite-budgets.json outside its contract. The defect class is the same as #111–#121: an output that misleads the next actor.

## Proposed outcome

A changed-tree gate on the generator diff. It fires a surfaced finding, fail-closed, when the diff:

- Deletes or skips a test.
- Edits the gate catalog.
- Touches suite-budgets.json outside its contract.

Override path is waive-with-reason, same as item 6. The gate rides item 2's gate-derivation machinery and closes the loop under policy 6 (deterministic checks belong in the gate catalog, not hooks).

## Affected users and systems

Generator, evaluator, gate catalog, suite-budgets.json, item 2 gate-derivation machinery.

## Constraints and non-goals

- Deterministic only; no model call in the check.
- Not a hook — a gate, per the 2026-08-29 hooks decision.
- Legitimate protected changes require a structured waive-with-reason record. Contract scope alone is not a waiver.

## Resolved decisions

- Projects declare test-skip detectors. AFK may provide a TypeScript/Vitest detector; v1 does not use one universal cross-language regex.
- Contract file scope alone never authorizes a protected change. A structured waive-with-reason record is required.
- #84 owns deleted tests and protected-path changes. #86 owns project-declared skip detection.
