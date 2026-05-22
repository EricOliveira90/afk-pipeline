# No-sandbox worktree isolation with kiro-cli chat as execution primitive

We chose worktree-based branch isolation over container sandboxing, and
`kiro-cli chat --no-interactive` over the ACP JSON-RPC protocol.

**Worktrees over containers:** Kiro CLI authenticates via IAM Identity
Center with tokens in a local SQLite database. Mounting these into a
Podman container is fragile (file locking, token refresh). Since this is a
solo-developer tool and the agents intentionally have full tool access
(`--trust-all-tools`), container isolation adds complexity without
meaningful safety. Worktrees give branch-level isolation — bad output is a
deleted branch, not a corrupted working directory.

**`chat --no-interactive` over ACP:** The ACP protocol (JSON-RPC over
stdin/stdout) provides structured streaming events but requires managing a
stateful bidirectional session. Our pipeline is a sequence of independent
agent invocations where inter-agent state lives on the filesystem
(contract.md, qa-report.md). Each invocation is fire-and-forget: send
prompt, wait for exit, parse artifacts. `chat --no-interactive` maps
directly to this model. ACP would add a protocol client dependency and a
fundamentally different execution model for no practical benefit.

**Build from scratch over forking Sandcastle:** Sandcastle's value is
provider-agnostic sandbox orchestration. We need neither multiple
providers nor sandboxing. The useful parts (worktree management, git
operations) are ~500 lines of standard git commands. Forking would mean
inheriting 30K+ lines of code (Effect framework, container lifecycle,
session capture, init scaffolding) only to delete 80% of it.

## Considered alternatives

- **ACP protocol** — richer streaming events (tool_call, agent_message_chunk)
  but requires JSON-RPC session management. Rejected: our control flow is
  artifact-based, not stream-based.
- **Container sandbox (Podman)** — process isolation. Rejected: IAM Identity
  Center auth doesn't transfer cleanly into containers, and `--trust-all-tools`
  already grants full access.
- **Sandcastle fork** — reuse existing orchestration. Rejected: more code to
  delete than to write.
