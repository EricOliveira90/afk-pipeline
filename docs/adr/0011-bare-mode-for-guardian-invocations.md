# Guardian invocations run claude in `--bare` mode

**Date:** 2026-05-26

## Context

PRD 029's run produced these final results from the post-merge guardian
agents:

```
slice-all-architect-review.log:
  result = "<tool_use>\n<server_name>Skill</server_name>\n
            <tool_name>dispatch_skill</tool_name>\n
            <arguments>\n{\"skill_name\": \"brainstorming\"}\n
            </arguments>\n</tool_use>"
  num_turns = 1, duration = 5 s, cost = $0.05
slice-all-pm-review.log:
  result = "<tool_use>\n<server_name>Skill</server_name>...
            <name>brainstorming</name>...</tool_use>"
  num_turns = 1, duration = 5 s, cost = $0.05
```

The orchestrator then logged `Could not parse architect/PM review
verdict — Treating as UNKNOWN (no PR will be opened)`. Both review
files were never written.

The transcript shows the agents emitting an XML `<tool_use>` block as
**plain text** rather than dispatching an actual tool call, then ending
the turn. Inspecting the session-init record explains why:

1. A `SessionStart:startup` hook from the
   `superpowers:using-superpowers` plugin (a third-party Claude Code
   plugin auto-discovered from the user's `~/.claude/plugins/`) injects
   an `<EXTREMELY_IMPORTANT>` directive: *"you ABSOLUTELY MUST invoke
   the skill"* before any response. The hook has a `<SUBAGENT-STOP>`
   guard for in-session subagents but does not detect new top-level
   `claude -p` sessions.
2. The `tools:` list registered for the agent is `[]`. The frontmatter
   `tools: ["read", "write"]` (lowercase YAML array) is silently
   ignored by Claude Code — the expected format is
   `tools: Read, Write` (capitalised, comma-separated string). With no
   tools registered, the agent has no `Skill` tool to invoke.
3. The agent reconciles "must invoke skill" with "no skill tool"
   by emitting a markdown-formatted `<tool_use>` block as plain text
   and ending the turn.

This failure is silent: the orchestrator's parser correctly classifies
the unparseable file as `UNKNOWN`, but the operator only sees a one-line
warning. The whole guardian gate degrades to "no PR opened" with no
indication that the agent was hijacked rather than the code was bad.

## Decision

Guardian invocations (`architect-review`, `pm-review`) run with the
claude CLI's `--bare` flag.

`--bare` strips the entire third-party plugin/hook ecosystem from the
session: SessionStart hooks, MCP servers, plugin-loaded agents, and
CLAUDE.md auto-discovery. The CLI provides exactly the built-in tools
(`Bash`, `Edit`, `Read`) plus whatever `--add-dir` / `--tools` configure.
Concretely the args differ as follows:

```ts
// default mode (planner, explorer, generator, evaluator, ceo-review):
["-p", "--agent", agent, "--dangerously-skip-permissions", ...]
// bare mode (architect-review, pm-review):
["-p", "--bare", "--tools", "default", "--add-dir", cwd,
 "--dangerously-skip-permissions", ...]
```

Two consequences flow from this choice:

- **`--agent` is dropped.** Bare mode does not load plugin- or
  project-installed agents (the init record shows
  `agents: ["claude","Explore","general-purpose","Plan","statusline-setup"]`).
  Passing `--agent architect-review` would silently fall back to the
  default agent. The persona therefore lives entirely in the prompt
  template (`prompts/architect-review.md`, `prompts/pm-review.md`),
  which already contains a complete Identity / Principles / Required
  reading / Task spec.
- **`--add-dir cwd` is required.** Without CLAUDE.md auto-discovery
  the agent has no implicit working-directory access; the orchestrator
  passes `reviewDir` explicitly so the agent can read slice contracts
  and write `review-architect.md` / `review-pm.md`.

Bare mode is **opt-in per invocation**, not session-wide. The other
roles (planner, generator, evaluator-qa, ceo-review) keep the default
flags because they may legitimately need plugin context — e.g. an MCP
server providing repo-specific introspection, or a project-side
`.claude/agents/<role>.md` with custom reading lists. The risk that a
future plugin update will hijack those roles too is real but
unrealised; we will widen `--bare`'s scope reactively if it occurs,
not pre-emptively.

## Consequences

- Guardian agents are immune to `SessionStart` hooks installed by any
  plugin — the same fix protects against the next plugin that decides
  every session must invoke its skill.
- Users who customised their project's `.claude/agents/architect-review.md`
  (per the README's setup instructions) lose that customisation for the
  AFK-driven post-merge review path. The adapt-and-commit flow in the
  README (`cp templates/agents/* .claude/agents/`) was framed for
  interactive `/agent` use as much as for AFK; the AFK side now relies
  on `prompts/architect-review.md` instead. Users who want
  AFK-driven guardian customisation must edit the prompt files in this
  repo (or fork them).
- `templates/agents/architect-review.md` and `pm-review.md` had a
  second, independent bug: lowercase YAML-array `tools: ["read",
  "write"]` registers no tools. Even without the hook hijack, an agent
  loaded from those templates couldn't read or write. Fixed in the same
  commit (`tools: Read, Write, Glob, Grep`). Affects manual
  `/agent architect-review` use only — AFK no longer loads these files
  for guardian runs.
- A `claude.e2e.test.ts` opt-in test (`AFK_E2E=1 pnpm test`) hits the
  real CLI with a tiny fixture and asserts a parseable verdict file is
  written. It catches both this bug and any future plugin update that
  defeats `--bare` — at the cost of ~$0.05 of Bedrock tokens per run.

## Out of scope

- Re-routing guardian customisation through `prompts/architect-review.md`
  with placeholders for project-specific reading lists. The current
  `{{RELEVANT_FILES}}` placeholder is enough for in-tree paths;
  per-project additions can come later if users ask.
- Forwarding the unparseable guardian output to operators for visual
  inspection (handoff issue #6 — review worktree gets wiped before
  output can be inspected). Distinct fix; tracked separately.
- Widening `--bare` to other roles. Wait for evidence of hijack
  rather than over-isolate sessions that may legitimately want MCP /
  CLAUDE.md context.
