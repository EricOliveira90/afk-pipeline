# Codex provider uses ephemeral full-trust JSONL invocations

**Date:** 2026-07-31

## Context

AFK needs a third agent provider that uses the installed Amazon-managed
Codex CLI and its existing authentication. It must preserve the same
worktree isolation, cancellation, logging, invocation statistics, idle
timeout, and tool-call cap as the existing providers.

## Decision

`codexProvider` invokes each role independently with:

```text
codex exec --json --ephemeral \
  --dangerously-bypass-approvals-and-sandbox \
  --model openai.gpt-5.6-sol \
  -c model_reasoning_effort="<effort>" -
```

The prompt is written to stdin. AFK does not inject API keys or other
credentials. `explorer` uses `medium` reasoning effort; every other role
uses `high`. The model ID is passed literally. `InvokeOptions.model`,
`agent`, and `bare` are ignored by this provider so callers cannot drift
from this policy.

`--ephemeral` makes every invocation independent. The full-trust flag is
consistent with AFK's worktree isolation model and lets generator and
evaluator roles edit and test without interactive approval prompts.

## Streaming and failures

Codex JSONL maps into AFK events as follows:

- `thread.started` becomes `session_id`.
- in-progress agent messages become `text`; completed agent messages
  become `result`.
- started `command_execution` items become `tool_call` and increment the
  invocation's tool-call count once.
- `error` and `*.failed` records become actionable provider errors.

Malformed and unrelated lifecycle records are ignored. Raw stdout and
stderr still flow to the invocation log. Nonzero exits include captured
stderr in the rejection message. Provider errors never trigger fallback
to Claude or Kiro.

The shared 180-second idle timeout, periodic idle warning, 100-tool-call
cap, `AbortSignal` cancellation, and delayed process-tree force kill all
apply. Codex does not report a dollar cost in this stream, so
`toolCallCount` is populated while `costUsd` remains undefined.

## Guardians and isolation

Codex guardians are prompt-only. The existing architect and PM prompt
templates fully define persona, required reading, output files, and
verdict format; no `.codex/agents` files are loaded or required.

The provider name is `codex`, producing `afk-codex/*` slice branches,
`feat-codex/*` feature branches, and provider-specific log/run-state
keys. The public entrypoint is `afk-codex`; local development uses
`pnpm dev:codex`.

## Verification

Unit tests mock the child process and cover exact arguments, stdin,
reasoning policy, JSONL parsing, malformed events, provider failures,
tool caps, cancellation, nonzero exits, and success. The opt-in
`AFK_CODEX_E2E=1` test initializes a temporary Git repository, invokes
the real CLI, and verifies that Codex writes a requested artifact.
