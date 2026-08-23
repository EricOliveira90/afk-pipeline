# Guardian prompts use Bash for file writes

**Date:** 2026-05-28

## Context

PRD 031 in `rumo-app` produced two consecutive guardian-review runs where
both the architect and PM agents emitted the correct review content — including
a parseable `**Verdict:** SHIP` line — **as plain text** rather than via an
actual tool call. The orchestrator correctly reported `UNKNOWN` (the file was
never created on disk) and refused to open a PR.

Investigation traced the failure to a constraint of `claude --bare` mode
(ADR 0011): the `--tools default` flag in bare mode registers exactly
three tools — `Bash`, `Edit`, `Read`. The `Write` tool is not included,
and adding it explicitly via `--tools "Bash,Edit,Read,Write"` has no
effect (the CLI hardcodes the bare-mode toolset).

With no `Write` tool available, the model falls back to emitting a fake
`<function_calls><invoke name="Write">` XML block inside its text output.
The Claude Code harness treats this as text (not a tool call), so no file
is created. The session ends with `stop_reason: end_turn` after a single
turn of 50,000+ output tokens — all text, zero tool_use blocks.

Contributing factor: the original prompts said "Write `{{SPECS_DIR}}/
review-architect.md`" without specifying which tool to use, relying on
the model to infer `Write`. When `Write` isn't in the schema, the model
has no actionable alternative unless explicitly told to use `Bash`.

## Decision

Guardian review prompts (`prompts/architect-review.md`,
`prompts/pm-review.md`) now:

1. Explicitly instruct the agent to use the **Bash tool** with a heredoc
   (`cat << 'REVIEW_EOF' > path`) to write the review file.
2. Include a verification step (`cat path | head -5`) so the agent
   confirms the verdict line is present before ending.
3. Suppress content duplication ("Do not repeat the review body in your
   final message").

This approach works within bare mode's `[Bash, Edit, Read]` constraint
without requiring changes to the Claude Code CLI, `--bare` semantics, or
the `--tools` flag behavior.

## Consequences

- Guardian agents are no longer vulnerable to the absence of `Write` in
  bare mode. `Bash` is always available and can write arbitrary files.
- The heredoc pattern is slightly more fragile than a structured `Write`
  tool call (the agent could malform the heredoc delimiter), but the
  verification step catches this: if `head -5` doesn't show the verdict,
  the agent can retry within the same session.
- The `claude.e2e.test.ts` smoke test now uses the same Bash-heredoc
  pattern, validating the full code path.
- If a future Claude Code version adds `Write` to bare mode's default
  toolset, the prompts still work — Bash-based file writing is valid
  regardless of whether `Write` is also available.

## Relationship to ADR 0011

ADR 0011 introduced `--bare` mode to prevent plugin SessionStart hooks
from hijacking guardian sessions. That fix was necessary and remains in
place. This ADR addresses a **second failure mode** within bare mode:
the absence of `Write` from the built-in toolset. The two failures have
the same symptom (`UNKNOWN` verdict) but different root causes and
different fixes.
