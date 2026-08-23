# AFK Deterministic Quality Gauntlet

## Objective

Implement the deterministic quality gauntlet defined by GitHub parent issue
#48 through the twelve approved vertical slices in `issues.md`.

The gauntlet moves repeatable quality decisions from agent prose into
orchestrator-owned evidence. It evaluates generated business behavior before
cleaning and hardening, protects that approved behavior after every writing
stage, and keeps every agent invocation focused on one role.

## Sources Of Truth

Use these sources in this order:

1. The current slice's GitHub issue body and acceptance criteria.
2. `docs/specs/afk-deterministic-quality-gauntlet.md` for cross-slice decisions.
3. Existing ADRs and behavior in the area touched by the slice.

Do not implement parent issue #48 as a separate slice. Do not expand a child
slice with acceptance criteria owned by a later child issue.

## Delivery Constraints

- Preserve current behavior when a consuming project has no quality policy.
- Keep orchestration provider-independent across Kiro, Claude Code, and Codex.
- Keep agent prompts small, role-specific, and free of prior conversations.
- Use deterministic commands and structured artifacts for facts AFK can check.
- Preserve DAG, wave, lane, resumption, cancellation, MERGE-PENDING, and
  blocked-ship behavior.
- Keep the current live dashboard out of scope. Emit the evidence it can use.
- Keep each slice green and independently verifiable before merge.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before final shipment.

## Overnight Self-Hosting Note

This AFK run implements changes to AFK itself. The orchestrator process loaded
at run start will not adopt new orchestration code during the same process.
Later slice agents still receive earlier merged feature-branch code. Treat this
run as implementation, then validate the completed gauntlet with a separate
canary PRD after the draft PR merges.

## Relevant Files

- `docs/specs/afk-deterministic-quality-gauntlet.md` - Authoritative parent specification and test scenarios.
- `CONTEXT.md` - AFK domain language and existing pipeline concepts.
- `README.md` - Current public pipeline behavior and compatibility contract.
- `package.json` - Required repository checks and supported runtime.
