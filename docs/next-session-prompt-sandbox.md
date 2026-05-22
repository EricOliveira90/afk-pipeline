Continue improving the afk/ pipeline orchestrator at C:\Code\sandcastle\afk\
based on patterns from the parent Sandcastle codebase at C:\Code\sandcastle\src\.

Background — already landed in afk/CONTEXT.md and ADRs 0002–0004:

- AgentProvider interface (afk/src/agent-provider.ts) replaces per-backend
  invokers. Branch prefixes derive from provider.name.
- AbortSignal cancellation: SIGINT → controller.abort() → in-flight agent
  processes get SIGTERM → unstarted slices marked CANCELLED. Worktrees
  preserved for resume.
- Idle watcher (afk/src/idle-watcher.ts): periodic idle warnings (60s)
  separate from the hard idle timeout (10min). Warnings routed to slice logs
  via logger.writeIdleWarning.
- Stream events (claude provider): parseStreamLine yields typed events;
  invocation stats (costUsd, toolCallCount) aggregated as slice totals + run
  totals in run-summary.md. ADR 0004 documents why parsing is opt-in per
  provider.

Now tackle item 3 — Sandbox / isolation for agent execution.

# The problem

Today the explorer / planner / generator / evaluator agents all run on the
host with `--dangerously-skip-permissions` (claude) or `--trust-all-tools`
(kiro). Worktrees give branch isolation but not filesystem isolation:

- A misbehaving generator can read ~/.aws, ~/.ssh, ~/.kiro auth tokens
- It can write outside the worktree (node_modules, ~/.bashrc, etc.)
- It can run arbitrary `execute_bash` against host services
- Nothing constrains network egress

Sandcastle's whole reason for existing is solving this — see
src/sandboxes/docker.ts, src/sandboxes/podman.ts, src/SandboxFactory.ts,
src/SandboxLifecycle.ts. ADR 0001 explicitly rejected sandboxing for afk
("solo-developer tool, --trust-all-tools already grants full access"). With
the AgentProvider seam now in place that calculus may shift — sandboxing is
no longer a wholesale architectural decision, it can be a per-provider
choice.

# Goal

Add an optional sandboxed execution mode to AgentProvider.invoke so a
provider can run the agent inside a Docker/Podman container with the
worktree bind-mounted, while keeping no-sandbox as the default for
backwards compat. Specifically:

1. Define how a provider declares "I can run sandboxed" without forcing
   every provider to (kiro can't easily — see ADR 0001's IAM Identity
   Center auth note).
2. Decide whether to consume Sandcastle's SandboxProvider directly (import
   from `@ai-hero/sandcastle/sandboxes/docker`) or build a thin wrapper
   suited to afk's per-invocation lifecycle.
3. Sort out auth-token forwarding: claude needs ANTHROPIC_API_KEY or a
   subscription cookie; kiro needs the SQLite token DB. What's safe to
   bind-mount, what gets denied, what's the failure mode when missing.
4. Decide what afk's worktree-per-slice means inside a container —
   bind-mount the worktree, or sync via Sandcastle's "isolated provider"
   pattern? (afk uses Docker/Podman locally, so bind-mount is fine.)

# What I want from you

1. Re-read ADR 0001 in afk/docs/adr/. The "no sandbox" decision is the
   thing being challenged here. Open the discussion by asking whether the
   conditions that justified ADR 0001 still hold, or whether the threat
   model has shifted enough to warrant a new ADR that supersedes it.

2. Run /grill-with-docs to stress-test the design against afk/CONTEXT.md
   and the existing ADRs. Resolve terminology before any code:
   - afk/CONTEXT.md retires "sandbox" as a term (it currently maps to
     worktree). If we add containers, do we adopt Sandcastle's full
     sandbox/sandbox-provider vocabulary, or coin afk-specific terms
     ("sandboxed invocation"?) so worktree stays the dominant isolation
     concept in afk?
   - "no-sandbox provider" already means something specific in
     Sandcastle. If afk providers default to no-sandbox, do we use the
     same term, or something like "host-mode invocation"?
   - What's the per-slice integration boundary called now that there
     are two layers of isolation (container around worktree)?

3. Update afk/CONTEXT.md and add an ADR (likely 0005) capturing the
   decision. If ADR 0001 is being superseded, mark it with
   `Status: superseded by ADR-0005` and explain why the calculus changed.

4. Implement once design is settled. Likely shape:
   - New optional `sandbox?: SandboxConfig` on InvokeOptions (or on the
     provider itself, depending on grilling outcome)
   - Container lifecycle integrated into invoke(): pull image, mount
     worktree, exec agent CLI, capture stdout, tear down
   - Tests covering the host-mode path (existing) + sandboxed path
     (new), with the sandboxed path skipped when Docker isn't available
   - Verify with:
       node_modules/.bin/tsgo --noEmit -p afk
       cd afk && ../node_modules/.bin/vitest run

Be concise during grilling — one question at a time, paragraph-sized
recommendations. Reference Sandcastle's implementation
(src/sandboxes/docker.ts, src/SandboxFactory.ts, src/SandboxLifecycle.ts,
src/EnvResolver.ts) when proposing solutions, and call out where afk's
per-invocation model diverges from Sandcastle's per-iteration model.
