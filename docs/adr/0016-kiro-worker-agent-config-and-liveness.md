# Kiro worker agent config, spinner-proof liveness, wall-clock ceiling

> **Correction (2026-08-09).** The nested-sub-agent reading of the
> generator hang below was wrong. Re-examination of the wedged log
> found zero occurrences of `use_subagent`, `subagent`, `delegate`,
> and `no agent with name` — no subagent tool was ever invoked, and
> the managed `afk-worker` config loaded without failing open. The
> `Dividing up the work...` frames appear immediately after kiro-cli's
> own parallel tool-batch output (`Operation 1: Reading file...`,
> `Operation 2: ...`, `Summary: 2 operations processed`): it is
> kiro-cli's parallel-operation spinner painted while the model
> stalled mid-turn, not evidence of a nested agent. The decisions
> stand on corrected grounds — decision 1 remains valid hardening (it
> removed the leaked MCP servers and the subagent tool from worker
> sessions), and decision 2's progress filter is what made the real
> stall visible at all: idle warnings climbed from 1 to 9 minutes
> where previously every spinner frame reset the watcher forever.
> Read "nested agent wedged" below as "the model stalled mid-turn
> while the CLI painted its spinner". See also ADR 0019, which
> revisits decision 3's 60-minute default.

## Failure mode

Two consecutive runs of the same PRD hung indefinitely on the Kiro
backend, on different slices. Post-mortem of the invocation logs
(`slice-06-generator-r1.log`, `slice-07-generator-r1.log` in the
consuming project) showed one mechanism with two visible shapes:

- **Generator hang.** The agent used Kiro's `use_subagent` tool to
  spawn a nested agent. The nested session wedged; the parent
  `kiro-cli chat` process painted an animated spinner
  (`\r⠋ Dividing up the work...`) to stdout several times per second,
  forever. Every frame arrived as a stdout chunk, and `src/kiro.ts`
  reset the idle watcher on every chunk — so the 600s idle kill
  (ADR 0007's only guard for Kiro, which parses no stream) could
  never fire. Killing the run required terminating ~35 child
  processes.
- **Evaluator-contract silent exit.** The invocation exited without
  emitting a verdict, leaving `contract.md` at `NEGOTIATING`, so the
  slice never locked.

Root cause: the AFK pipeline's Kiro roles are prompt-only — no
`--agent` config gates their tools — so each headless child ran the
**default** agent. Empirically (kiro-cli 2.16.2), the default agent in
a headless child carries the `use_subagent` tool *and* auto-connects
every MCP server from the invoking user's `mcp.json` (four servers
leaked in testing). `--trust-all-tools` then auto-approves all of it.
This is the Kiro twin of the Claude-provider defect fixed with
`--strict-mcp-config` (see the comment in `src/claude.ts`); kiro-cli
has no equivalent flag.

## Decision 1 — managed worker agent config

Prompt-only Kiro invocations now run under a locked-down agent config,
`afk-worker`, that the provider materialises into the **global** agent
directory (`~/.kiro/agents/afk-worker.json`) before each spawn
(idempotent write; drifted copies are overwritten so upgrades
self-heal). Caller-supplied `agent` values still pass through
untouched.

The config:

- `tools`: filesystem, shell, and bookkeeping tools only — no
  `subagent`/`delegate`, so nested-agent spawning is structurally
  impossible, not merely untrusted. The list mixes v2 tool names
  (`fs_read`, `execute_bash`) with v3 category names (`read`,
  `shell`); unknown entries are ignored, so one config covers both CLI
  generations. `excludedTools` adds a v3-only third layer.
- `mcpServers: {}` + `useLegacyMcpJson: false`: no MCP servers, and no
  inheritance from user/workspace `mcp.json`. **Caution:**
  `includeMcpJson` is a serde alias of `useLegacyMcpJson`; a config
  carrying both spellings is rejected as invalid (duplicate field).

Verified against kiro-cli 2.16.2: with the config, a headless child
reports no sub-agent tool and no MCP tools, retains
read/write/shell (surfaced as `execute_cmd` on Windows), and still
loads workspace steering files.

**Why the global directory, not the worktree.** kiro-cli resolves
`--agent` by the JSON `name` field against `~/.kiro/agents/` and the
cwd's `.kiro/agents/` (workspace wins on conflict). Writing into the
per-slice worktree would risk the generator committing the file into
the consuming repo; the global copy works from every worktree.

**Why not `--trust-tools`.** It controls auto-approval, not
availability — the sub-agent tool would remain in the model's toolset
and merely fail when called, and the failure shape in non-interactive
mode is not contractually documented.

**Fail-open tripwire.** When `--agent` can't be resolved (config
missing or invalid), kiro-cli does *not* exit — it logs
`no agent with name <x> found. Falling back to user specified default`
and continues with the unrestricted default agent, silently
reintroducing the defect. The provider watches the head of
stdout/stderr for that marker and kills the invocation, surfacing a
distinct error instead of running unguarded.

## Decision 2 — progress-filtered liveness (src/liveness.ts)

Raw chunk arrival is no longer the liveness signal. A chunk resets the
idle watcher only when it contains *meaningful* output:

- a newline committing a line with non-whitespace content, or
- the current line growing beyond the longest it has been since the
  last commit (covers text streamed without newlines).

Spinner frames rewrite one line in place via carriage return (or
`ESC[nG`/`ESC[nK`, treated as CR) to a constant width and never commit
it — after the first frame they contribute nothing, so a session
producing only decorative animation goes idle-silent and the existing
idle kill fires. ANSI escapes are stripped first, with a bounded carry
for sequences split across chunk boundaries.

Only the Kiro provider consumes the filter: Claude and Codex emit
structured JSONL where every line is a real event, and their tool-call
ceilings (ADR 0007) already cover the talky-loop case.

## Decision 3 — wall-clock ceiling (all providers)

`maxDurationMs` (default **3_600_000**, 60 min) joins ADR 0007's idle
floor and tool-call ceiling as a third, independent bound, enforced by
all three providers. It is the backstop for whatever the other two
can't see: any hung session that keeps emitting *something* — spinner
variants the filter doesn't recognise, periodic real lines from a
wedged loop — dies within the ceiling and lands the slice in `STUCK`
through the same rejection path. 60 minutes is comfortably above a
legitimate generator invocation (slices are thin tracer bullets; the
hung runs above showed healthy invocations finishing well under it);
per-invocation override via `InvokeOptions` is preserved, matching
ADR 0007's "bound the common case" philosophy.

## What stays untouched

- `IdleWatcher` — same shape; only who calls `reset()` changes.
- ADR 0007's idle floor and tool-call ceiling defaults.
- Prompt-only persona delivery — role personas still live in the
  rendered prompt; `afk-worker` carries no `prompt` field.
- Claude's `--strict-mcp-config` / `--bare` paths (ADR 0011).
