# Hooks in AI Code Pipelines & Governance Practices That Translate to Agent Hooks

Research date: 2026-08-29. All sources accessed 2026-08-29 unless noted. Claims are paraphrased from the linked sources; content was rephrased for compliance with licensing restrictions.

> **Revised 2026-08-29** after two adversarial reviews and a primary-source re-check (`2026-08-29-hooks-review-source-check.md`). Four corrections applied inline: (1) Codex *does* ship a hooks framework — the "no hooks" claim was stale; (2) the cross-tool portability headline is narrowed to the shared JSON/exit-code substrate only; (3) a load-bearing caveat added: hook semantics are documented for interactive sessions, and AFK invokes providers with permission-bypass flags under which enforcement is demonstrably different and buggy; (4) the Liquibase AI-SQL claim is downgraded to vendor positioning.

---

## 1. Summary — most actionable findings

- **A shared hook *substrate* has emerged — but portability is limited to it**: JSON on stdin → decision via exit code + JSON on stdout, with `exit 2 = block`. Claude Code defined it; [Cursor explicitly matches it "for compatibility"](https://cursor.com/docs/agent/hooks) and [Gemini CLI copies it too](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), including a `CLAUDE_PROJECT_DIR` compatibility alias in both. *(Corrected: only this stdin-JSON/exit-code convention is shared. Event names, matchers, decision vocabularies, config locations, precedence, and trust models all differ per tool — Gemini itself documents limited Claude compatibility rather than drop-in portability. "Write once, port across three agents" holds only for the simplest hooks.)*
- **Fail-open is the dangerous default everywhere.** Cursor documents that hook crashes/timeouts let the action proceed unless `failClosed: true` is set; Claude Code treats a mistyped hook path as a non-blocking notice while "the gate is silently disabled" ([Claude Code hooks reference](https://docs.claude.com/en/docs/claude-code/hooks)). Security-critical hooks must be explicitly fail-closed and monitored for startup failures.
- **The decision vocabulary is converging on four verbs**: allow, deny, ask (escalate to human), and mutate (rewrite tool input/output). Claude Code adds a fifth, `defer` (pause and resume later for embedding hosts). Precedence when hooks disagree is deny > defer > ask > allow ([Claude Code](https://docs.claude.com/en/docs/claude-code/hooks)).
- **Blocking with a *reason* is a steering channel, not just a gate**: on PreToolUse deny, the reason is shown to the model, which retries differently; Stop-hook blocks feed the reason back as the agent's next instruction — this is how "don't stop until tests pass" loops are built ([Claude Code](https://docs.claude.com/en/docs/claude-code/hooks), [Cursor `followup_message`](https://cursor.com/docs/agent/hooks)).
- **Loop limits on stop-hooks are a first-class safety feature**: Claude Code caps consecutive Stop-hook continuations at 8; Cursor defaults `loop_limit` to 5. Any auto-continue hook needs a bounded iteration count.
- **LLM-evaluated hooks now exist alongside script hooks**: both Claude Code (`type: "prompt"` and `type: "agent"` with tool access) and Cursor (prompt-based hooks) let a fast model evaluate a natural-language policy and return `{ok, reason}` — policy without writing scripts, at the cost of determinism.
- **Enterprise distribution and precedence are built in**: Cursor merges Enterprise → Team → Project → User hook configs; Claude Code's managed policy settings can't be disabled by lower levels (`allowManagedHooksOnly`, `disableAllHooks` hierarchy). Org-level guardrails survive local tampering.
- **Codex now ships hooks too; Copilot stays environment-level** *(corrected — the original draft claimed Codex had no hook system)*: Codex has a [lifecycle hooks framework](https://developers.openai.com/codex/hooks/), enabled by default, alongside its OS-enforced sandbox (no network, workspace-only writes by default — [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing/)) and approval policy. Enforcement is weaker than Claude's: matching command hooks for the same event launch concurrently, so one hook cannot prevent another from starting, and some execution paths remain outside complete interception. Copilot's cloud agent uses a network firewall allowlist plus branch protections and CODEOWNERS as its guardrails ([GitHub guardrails tutorial](https://docs.github.com/en/copilot/tutorials/cloud-agent/build-guardrails)). Hooks and sandboxes remain complements, not substitutes.
- **Hook semantics are documented for *interactive* sessions — headless/bypass modes are a different, buggier regime.** This is the load-bearing caveat for any orchestrator (AFK included) that launches providers with trust flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--trust-all-tools`). Under Claude Code's bypassPermissions there are open reports of PreToolUse hooks firing but not blocking ([anthropics/claude-code#20946](https://github.com/anthropics/claude-code/issues/20946)), hooks silently ceasing to take effect mid-session ([#47810](https://github.com/anthropics/claude-code/issues/47810)), and the `ask` verb being silently auto-approved while only `deny` blocks ([#77212](https://github.com/anthropics/claude-code/issues/77212)). Anthropic's own docs advise the permission system — the thing the bypass flag disables — over hooks for hard guarantees. Any enforcement claim in this document must be re-tested under the actual invocation flags before it is relied on.
- **Post-edit validators with feedback loops are the highest-reported-value production use**: Aider auto-lints and auto-tests after every edit and feeds errors back for repair ([aider lint/test docs](https://aider.chat/docs/usage/lint-test.html)); Cursor's partner ecosystem ships Semgrep hooks that "regenerate code until security issues are resolved" ([Cursor partner integrations](https://cursor.com/docs/agent/hooks)).
- **Interception at the tool-call boundary is where the security industry is landing for MCP**: gateways apply pre-call policy checks and post-call injection scanning to every tool invocation, checking agent identity, the user acted for, the tool, and the arguments ([Cerbos on policy-driven MCP routing](https://cerbos.dev/blog/policy-driven-mcp-routing-tool-gating)).
- **Fifty years of git/CI governance maps almost 1:1 onto agent hook events**: pre-commit ≈ pre-action gate, required status checks ≈ stop/ship gate, CODEOWNERS ≈ path-scoped human-approval escalation, deployment protection rules ≈ environment-scoped ask, policy-as-code (OPA/Kyverno) ≈ deterministic deny at a choke point.
- **Secret scanning belongs at two hook points, not one**: pre-write/pre-commit (gitleaks-style, block the leak at the source — cheap) and pre-read (block `.env` from ever entering model context — a uniquely AI-era need Cursor's `beforeReadFile` and Claude Code permission rules both target).
- **Migration governance (reserved prefixes, policy checks on every changeset) is directly encodable**: Liquibase's framing — the same standard applied to every change regardless of author — is exactly the property agent hooks need. *(Corrected: its "validating AI-generated SQL" material is vendor product positioning, not independent practice evidence — an existence proof of the pattern at most, and this repo's ADR 0027/0028/0034 already prove the pattern internally.)* ([Liquibase policy checks](https://www.liquibase.com/pillars/policy-checks))
- **Audit evidence should be a byproduct of hook execution, not a separate task**: SOC 2 CC8.1 asks you to show each production change was authorized, tested, and applied by the right identity; pipelines generate that trail automatically at each gate ([Unleash on SOC 2 change management](https://www.getunleash.io/blog/streamlining-change-management-for-soc-2-compliance)). Agent-run logs at PreToolUse/PostToolUse/Stop are the same evidence.
- **Classify failures at the hook, not later**: DORA's four keys separate throughput from stability metrics ([dora.dev four keys](https://dora.dev/guides/dora-metrics-four-keys/)); a PostToolUseFailure/stop-event hook that tags each failure (build vs. test vs. gate vs. infra) at capture time is what makes agent-fleet DORA-style dashboards possible.

---

## 2. AI tools — hook systems

### 2.1 Claude Code (Anthropic)

Source: [Hooks reference — Claude Code docs](https://docs.claude.com/en/docs/claude-code/hooks) (accessed 2026-08-29).

Hooks are user-defined shell commands, HTTP endpoints, MCP tool calls, LLM prompts, or subagents that fire at lifecycle points. Configured in settings JSON at user/project/local/managed-policy/plugin/skill/subagent scopes; entries merge across levels and managed hooks can't be disabled from below.

| Event (selection) | Decision powers | Common uses |
|---|---|---|
| `SessionStart` / `Setup` | Inject context (`additionalContext`, `initialUserMessage`), set env vars, set session title; no blocking | Load git state, issues, env setup |
| `UserPromptSubmit` | Block prompt (`decision:"block"`), inject context | Prompt validation, context injection |
| `PreToolUse` | `permissionDecision`: allow / deny / **ask** (force human prompt) / defer; `updatedInput` rewrites tool args; deny reason shown to model | Block `rm -rf`, gate SQL writes, redact outbound input |
| `PermissionRequest` | Allow/deny on the user's behalf; can attach permission-rule updates | Auto-approve safe patterns, programmatic policy |
| `PostToolUse` | `decision:"block"` feeds reason to model; `updatedToolOutput` rewrites result; `additionalContext` | Format-on-save, lint feedback, result redaction |
| `PostToolUseFailure` / `PostToolBatch` | Add context; batch hook can halt the loop | Error tracking, batch-level context |
| `Stop` / `SubagentStop` | Block stopping (reason becomes next instruction); 8-consecutive-block cap | "Keep going until tests pass" |
| `TaskCreated` / `TaskCompleted` / `TeammateIdle` | Block completion / keep teammate working | Enforce completion criteria (tests green) |
| `PreCompact` / `PostCompact`, `ConfigChange`, `FileChanged`, `Notification`, `SessionEnd`, `PreModelSwitch`, `WorktreeCreate/Remove` | Varies: ConfigChange can block settings changes; PreModelSwitch can deny/ask; WorktreeCreate replaces git worktree behavior entirely | Audit config edits, cost gates on model switch, custom VCS |

Semantics worth copying:
- Exit 0 + JSON = structured decision; exit 2 = hard block that JSON can't override; other exit codes = non-blocking error (fail-open) with a transcript notice.
- The `ask` decision labels which config source requested confirmation and cannot be silently overridden by the auto-approval classifier.
- Matchers filter by tool name (exact, list, or regex); an `if` field matches tool arguments with permission-rule syntax (e.g. `Bash(git *)`), including subcommands inside `$()`.
- Prompt hooks (`type:"prompt"`) and agent hooks (`type:"agent"`, up to 50 tool-using turns) return `{ok, reason}` for LLM-evaluated policy.
- Async hooks run in background and deliver results next turn; they cannot block.
- Docs explicitly warn to treat the `if` filter as best-effort and use the permission system for hard guarantees.

### 2.2 Cursor

Source: [Hooks — Cursor docs](https://cursor.com/docs/agent/hooks) (accessed 2026-08-29).

Spawned processes exchanging JSON over stdio; can observe, block, or modify agent behavior. Three surfaces: Agent hooks, Tab (inline completion) hooks, and app-lifecycle hooks — enabling different policies for autonomous vs. user-directed operations.

| Event (selection) | Decision powers | Common uses |
|---|---|---|
| `preToolUse` | `permission` allow/deny, `updated_input` | Generic tool gate |
| `beforeShellExecution` / `beforeMCPExecution` | Permission decision; matcher runs against the command string | Gate `curl|wget|nc`, approve network calls |
| `beforeReadFile` / `beforeTabFileRead` | allow/deny | **Block sensitive files from reaching the model** |
| `afterFileEdit` / `afterTabFileEdit` | Observe (formatters, accounting) | Format-on-save, audit AI-written code |
| `postToolUse` | `updated_mcp_tool_output`, `additional_context` | Analytics, context injection, MCP output rewriting |
| `subagentStart` / `subagentStop` | Deny subagent creation; `followup_message` auto-continues (loop-limited, default 5) | Control Task-tool fanout, iteration loops |
| `beforeSubmitPrompt` | `continue: false` blocks submission | Prompt policy |
| `stop` | `followup_message` auto-submits next message (loop-limited) | Iterate-until-done flows |
| `sessionStart` / `sessionEnd` / `preCompact` / `afterAgentThought` | Observe / inject env + context | Telemetry, env setup |

Distinctive properties:
- `failClosed: true` per hook makes crash/timeout/invalid-JSON block instead of pass — the docs call this out for security-critical hooks. Default is fail-open; exit 2 blocks (documented as Claude Code-compatible).
- Config precedence Enterprise → Team → Project → User, with MDM and cloud distribution for org-wide rollout; cloud agents run repo-committed hooks.
- Documented partner production uses: Semgrep scanning AI-generated code with regenerate-until-clean loops; Endor Labs intercepting package installs to catch malicious dependencies; Snyk reviewing agent actions for prompt injection and dangerous tool calls; 1Password validating env mounts before shell commands; MintMCP/Oasis/Runlayer for MCP inventory, least-privilege, and audit trails.

### 2.3 OpenAI Codex (CLI / IDE / cloud)

Sources: [Codex hooks](https://developers.openai.com/codex/hooks/), [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security/), [Sandboxing concepts](https://developers.openai.com/codex/concepts/sandboxing/), [Exec policy](https://developers.openai.com/codex/exec-policy), [Config reference](https://developers.openai.com/codex/config-reference/) (accessed 2026-08-29).

*(Corrected — the original draft claimed Codex had no user-scriptable hook system.)* Codex ships a **lifecycle hooks framework**, enabled by default (`[features] hooks = false` in `config.toml` disables it; admins can force it off in `requirements.toml`). Documented uses include conversation logging, prompt scanning to block pasted API keys, memory summarization, and Stop-time validation checks. Enforcement semantics are weaker than Claude Code's: matching hooks from multiple files all run, and multiple matching command hooks for the same event launch concurrently — one hook cannot prevent another matching hook from starting — so hooks are not a complete interception layer for every execution path.

Its primary guardrail model remains two orthogonal environment-level controls:
- **Sandbox** — OS-level enforcement (defaults: no network, writes limited to the workspace; on Windows the constraint propagates down the whole process tree — [Codex Windows sandbox post](https://openai.com/index/building-codex-windows-sandbox/)). The sandbox defines technical boundaries.
- **Approval policy** — decides when Codex must stop and ask before crossing a boundary (leaving the sandbox, network access, untrusted commands). With Smart approvals, Codex can propose a `prefix_rule` during escalation that the user reviews — human-ratified allowlist growth. Admin config can forbid dangerous combinations (e.g. disallowing `approval_policy = "never"` or full-access sandbox, per [config basics](https://developers.openai.com/codex/config-basic/)).

Decision powers, mapped: the sandbox is a static always-deny; the approval policy is a human-approval escalator; exec-policy prefix rules are a mutable allowlist; hooks add an observe/inject/validate channel with concurrent (non-blocking-of-each-other) execution. Note that AFK invokes Codex with `--dangerously-bypass-approvals-and-sandbox`, which removes both environment-level controls from the picture entirely.

### 2.4 GitHub Copilot coding agent

Sources: [Building guardrails for Copilot cloud agent](https://docs.github.com/en/copilot/tutorials/cloud-agent/build-guardrails), [Customizing or disabling the firewall](https://docs.github.com/copilot/customizing-copilot/customizing-or-disabling-the-firewall-for-copilot-coding-agent), [Customize the agent environment](https://docs.github.com/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-environment) (accessed 2026-08-29).

Copilot's agent runs in GitHub Actions and reuses the platform's existing governance as its hook surface:
- **Network firewall**: default allowlist of hosts; admins customize or disable per org/repo — an environment-level pre-action gate on all network egress.
- **CODEOWNERS on agent-config files**: GitHub's own guardrails tutorial recommends protecting Copilot/MCP configuration files with CODEOWNERS plus required code-owner review, so edits to the agent's instructions need human approval — governance of the governor.
- **Branch protections and required checks** apply to agent PRs like human PRs; the agent works on a branch and a human merges.
- **`copilot-setup-steps.yml`**: a workflow file that pre-configures the agent's environment — the SessionStart equivalent.

### 2.5 Gemini CLI (Google)

Sources: [gemini-cli hooks docs (repo)](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), [hooks reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md), [Google developers blog announcement](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/) (accessed 2026-08-29).

Synchronous script hooks in the agent loop; the CLI waits for hooks before continuing.

| Event | Impact | Common uses |
|---|---|---|
| `SessionStart` / `SessionEnd` | Inject context / advisory | Init, cleanup |
| `BeforeAgent` / `AfterAgent` | Block turn + context / retry or halt | Prompt validation, output review |
| `BeforeModel` / `AfterModel` | Block turn, mock response / redact | Prompt rewriting, response filtering — a hook point Claude Code and Cursor don't expose |
| `BeforeToolSelection` | Filter the tool list offered to the model | Dynamic least-privilege tool exposure |
| `BeforeTool` / `AfterTool` | Block or rewrite tool call / block result, add context | Validate args, run tests |
| `PreCompress`, `Notification` | Advisory | State save, alerts |

Semantics: exit 0 + JSON decision preferred; exit 2 = critical block using stderr as reason; other codes = warning, action proceeds (fail-open). Stdout must be pure JSON — pollution makes the CLI default to allow. Project hooks are fingerprinted: if a hook's command changes (e.g. via `git pull`) it's treated as new and untrusted, and the user is warned — a supply-chain defense for the hooks themselves.

### 2.6 Aider

Source: [Linting and testing — aider docs](https://aider.chat/docs/usage/lint-test.html) (accessed 2026-08-29).

No general hook system; instead two hardwired post-edit validators: aider can automatically lint (on by default, with built-in linters per language, overridable via `--lint-cmd`) and test (`--test-cmd` + `--auto-test`) after every change it makes, and when either fails it shows the errors to the LLM and asks for a fix — the archetypal post-action validator with a repair loop. This predates the hook systems above and is the pattern they generalize.

### 2.7 OpenHands (formerly OpenDevin)

Sources: [Security & Action Confirmation (SDK guide)](https://allhandsai.mintlify.app/sdk/guides/security), [security API reference](https://allhandsai.mintlify.app/sdk/api-reference/openhands.sdk.security), [headless mode docs](https://docs.all-hands.dev/usage/how-to/headless-mode) (accessed 2026-08-29).

Two composable mechanisms: a **confirmation policy** deciding when user approval is required, and a **security analyzer** that assigns each action a risk level; the policy consults the risk level to decide whether to pause for confirmation. The CLI exposes `--always-approve` and `--llm-approve` (LLM-based analyzer approving actions). Notable honesty in the docs: headless mode always auto-approves and this cannot be changed — and direct tool execution bypasses the confirmation/analyzer path entirely, placing safety responsibility on the caller. Lesson: risk-classify-then-escalate is a good architecture, but every execution path must route through it.

### 2.8 SWE-agent

Source: [SWE-agent repository](https://github.com/SWE-agent/SWE-agent) (accessed 2026-08-29).

Gates actions structurally rather than via hooks: its Agent-Computer Interface constrains the agent to a curated command set inside a sandboxed (Docker) environment, so the "policy" is the interface itself — an allowlist-by-construction. Relevant as the third strategy alongside hooks (Claude/Cursor/Gemini) and sandbox+approvals (Codex): shrink the action space so fewer gates are needed.

### 2.9 Orchestration frameworks (LangChain/LangGraph, and peers)

Sources: [LangChain middleware overview](https://docs.langchain.com/oss/python/langchain/middleware/overview), [custom middleware](https://docs.langchain.com/oss/python/langchain/middleware/custom), [guardrails guide](https://docs.langchain.com/oss/javascript/langchain/guardrails), [NVIDIA NeMo Guardrails LangChain middleware](https://docs.nvidia.com/nemo/guardrails/integration-with-third-party-libraries/langchain/agent-middleware) (accessed 2026-08-29).

LangChain agents expose an `AgentMiddleware` protocol with hooks before/after the agent run, around each model call, and around each tool call; middleware runs inside the compiled graph, and the docs frame guardrails as middleware intercepting execution at these points. NeMo Guardrails ships a `GuardrailsMiddleware` that runs safety checks before and after every model call including intermediate tool-calling steps — third-party guardrail vendors plugging into the same seam that hooks occupy in the CLIs. CrewAI and AutoGen offer comparable callback/guardrail seams (task callbacks / intervention functions), but LangChain's middleware is the most explicitly hook-shaped API among the frameworks.

### 2.10 MCP-era guardrail patterns

Sources: [Cerbos — policy-driven MCP routing](https://cerbos.dev/blog/policy-driven-mcp-routing-tool-gating), [API7 — secure MCP tool calls](https://api7.ai/blog/secure-mcp-tool-calls-guardrails-rate-limits), [InfoQ — least-privilege AI agent gateway with MCP + OPA](https://www.infoq.com/articles/building-ai-agent-gateway-mcp/), [Cursor partner integrations](https://cursor.com/docs/agent/hooks) (accessed 2026-08-29).

The recurring architecture is a **gateway/proxy in front of MCP servers** that intercepts every tool call and evaluates policy before execution — considering the agent identity, the user it acts for, the tool, and the arguments; denied calls never execute (Cerbos). API7's decomposition: caller identity, tool authorization, upstream credentials, and runtime limits/content policies are four separate controls. InfoQ documents wiring OPA as the policy engine for an agent gateway, noting agents granted broad persistent permissions inherit privileged-operator access without the judgment or accountability. Client-side, the same interception appears as `beforeMCPExecution` hooks (Cursor) and `mcp__server__tool` matchers (Claude Code); MCP elicitation (server requests user input) gets its own hookable events in Claude Code (`Elicitation`/`ElicitationResult`). Commercial wrappers (MintMCP, Runlayer, Oasis) add inventory, response scanning for sensitive data, and audit trails.

---

## 3. Governance practices → agent-hook mappings

### 3.1 Pre-commit hook ecosystems (pre-commit framework, husky, lint-staged)

- **Failure mode prevented**: broken, unformatted, or non-compliant code entering shared history, where fixing it costs a revert + re-review instead of seconds. The [pre-commit framework](https://pre-commit.com/) manages multi-language hook suites declaratively; [husky](https://typicode.github.io/husky/) wires native git hooks into JS projects and [lint-staged](https://github.com/lint-staged/lint-staged) runs checks only on staged files to keep the gate fast.
- **Agent-hook mapping**: PostToolUse(Edit|Write) → run formatter + linter on the touched file, feed failures back as block-with-reason so the agent repairs immediately (Aider's built-in behavior; Cursor's quickstart example). Keep it scoped to changed files, exactly like lint-staged, or hook latency compounds across hundreds of agent edits.

### 3.2 Secret scanning (gitleaks, trufflehog)

- **Failure mode prevented**: a credential committed once lives in history forever; remediation means rotation and incident response. [Gitleaks](https://github.com/gitleaks/gitleaks) and [TruffleHog](https://github.com/trufflesecurity/trufflehog) scan for API keys/tokens at pre-commit and in CI to block the leak at the cheapest point.
- **Agent-hook mapping**: two hooks. (1) PreToolUse(Write|Edit) / pre-commit: run a secret scanner over the diff, deny with reason on a hit. (2) **beforeReadFile / PreToolUse(Read)**: deny reads of `.env`, key files, credential stores so secrets never enter model context or logs — the agent-specific leak path that git hooks never had to consider (Cursor documents this as the primary use of `beforeReadFile`; Claude Code's security best practices say skip `.env`, `.git/`, keys).

### 3.3 Commit-message conventions (Conventional Commits)

- **Failure mode prevented**: unusable history — no automated changelogs, no semantic versioning, no way to trace intent. [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specifies a machine-readable commit format enforceable by commit-msg hooks.
- **Agent-hook mapping**: PreToolUse with `if: Bash(git commit *)` → validate the message format, deny with the expected pattern in the reason; the agent reformats and retries. Agents follow format specs reliably once the gate names the rule.

### 3.4 Branch protection, required status checks, CODEOWNERS

- **Failure mode prevented**: unreviewed or failing code reaching a shared branch; single-actor changes to critical paths. GitHub branch protection can require approving reviews, passing status checks, signed commits, and block force-pushes/deletion ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches)); CODEOWNERS routes required review to owning teams per path.
- **Agent-hook mapping**: three hooks. (1) PreToolUse(Bash `git push *`) → deny pushes to main/master. (2) Stop/ship gate → require the project's check suite green before the agent may declare done (Claude Code prompt-hook Stop examples do exactly this; this repo's pre-ship sanity gate is the same pattern). (3) Path-scoped escalation: PreToolUse(Edit) matching protected paths (CI config, hook config, migration dirs) → `ask` instead of allow — CODEOWNERS as a hook matcher. GitHub itself recommends CODEOWNERS-protecting agent config files ([Copilot guardrails tutorial](https://docs.github.com/en/copilot/tutorials/cloud-agent/build-guardrails)).

### 3.5 Protected environments, deployment approvals, CAB / separation of duties

- **Failure mode prevented**: a single actor (or a compromised pipeline) pushing changes to production without independent review; no pause point before irreversible actions. GitHub deployment protection rules require manual approval, a wait timer, or branch restrictions before a job touching the environment proceeds, and can prevent self-approval of one's own deployment ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [reviewing deployments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments)) — separation of duties encoded as pipeline config, replacing the classical Change Advisory Board meeting with an asynchronous gate.
- **Agent-hook mapping**: PreToolUse matching deploy/infra commands (`kubectl apply`, `terraform apply`, `aws * delete*`, prod hostnames) → `ask`, never auto-allow; the "no self-approval" rule maps to "the approving identity must not be the agent," which is exactly what the `ask` decision guarantees. Codex's approval policy and OpenHands' confirmation policy are this practice generalized to all boundary-crossing actions.

### 3.6 Policy-as-code (OPA/Conftest, Sentinel, Kyverno)

- **Failure mode prevented**: policy living in documents nobody reads, enforced inconsistently by tired reviewers, drifting between environments. [OPA](https://www.openpolicyagent.org/) evaluates Rego policies as a decision service; [Conftest](https://www.conftest.dev/) runs those policies against structured configs in CI; [Kyverno](https://kyverno.io/docs/introduction/) runs as a Kubernetes admission controller that validates/mutates/rejects API requests at the choke point; [HashiCorp Sentinel](https://developer.hashicorp.com/sentinel) embeds policy between Terraform plan and apply. The shared idea: a deterministic policy engine sits at a mandatory choke point and returns allow/deny/mutate with reasons.
- **Agent-hook mapping**: the most direct translation of all. A PreToolUse hook that shells out to `opa eval`/`conftest` with the tool-call JSON as input turns the hook event into an admission controller for agent actions — one policy bundle shared by CI and agents, avoiding the policy-drift problem. This is exactly the architecture InfoQ documents for MCP gateways ([InfoQ agent gateway article](https://www.infoq.com/articles/building-ai-agent-gateway-mcp/)); Cursor's Kubernetes-manifest-guard example (parse YAML before `kubectl apply`) is a hand-rolled version of the same.

### 3.7 Supply-chain security (pinning, SLSA, provenance, license/typosquat scanning)

- **Failure mode prevented**: malicious or tampered dependencies entering the build — dependency confusion, typosquats, compromised build steps. [SLSA](https://slsa.dev/spec/v1.0/levels) defines levels of build provenance: a signed record of what entity built an artifact, by what process, from what inputs, with higher levels hardening against tampering. Lockfile pinning constrains what can be installed; tools like [Socket](https://socket.dev/) and Endor Labs flag typosquats and malicious packages at install time.
- **Agent-hook mapping**: PreToolUse matching `npm install *` / `pip install *` / `cargo add *` → scan the named package for typosquats/known-malicious status and deny or `ask` (this is a shipping product: Endor Labs' Cursor hook intercepts installs to stop supply-chain attacks, per [Cursor partner docs](https://cursor.com/docs/agent/hooks)). A PostToolUse hook can enforce that manifest changes pin exact versions. Provenance thinking also applies to the agent pipeline itself: record which agent/model/prompt produced each commit — SLSA for agent-authored changes.

### 3.8 Database migration governance (reserved prefixes, review gates, policy checks)

- **Failure mode prevented**: two concurrent changes claiming the same migration slot; destructive or non-rollbackable DDL reaching production; schema changes skipping review. [Liquibase policy checks](https://www.liquibase.com/pillars/policy-checks) are automated rules evaluating every database change before deployment, applying the same standard to every change regardless of author. Its material on [validating AI-generated SQL before deployment](https://www.liquibase.com/blog/how-to-validate-ai-generated-sql-before-deployment) and [policy checks as guardrails on top of RBAC](https://docs.liquibase.com/secure/leading-practices-5-2-2/audit-and-compliance-solution-guide-access-controls-separation-of-duties-best-practices) is vendor product positioning — treat it as an existence proof of the pattern, not independent evidence that it improves outcomes.
- **Agent-hook mapping**: PreToolUse(Write) matching the migrations directory → validate the filename claims a reserved prefix from a manifest and the SQL passes lint (no `DROP` without an approved marker, rollback present); deny with the specific violated rule so the agent self-corrects. Reserved-prefix claims are how multi-lane agent pipelines avoid migration collisions — this repo's ADR 0027/0028/0034 (migrations as a lane resource key; contract-lock prefix gate; manifest migration claims) are an existence proof of the pattern in an agent orchestrator.

### 3.9 Audit trails and compliance (SOC 2 / ISO 27001)

- **Failure mode prevented**: inability to demonstrate, months later, that a production change was authorized, tested, and applied by the right identity — SOC 2 CC8.1's core demand ([Unleash on SOC 2 change management](https://www.getunleash.io/blog/streamlining-change-management-for-soc-2-compliance)). Mature orgs make the audit trail a byproduct of pipeline execution, with controls enforced in the pipeline and evidence generated continuously as a chain from change to build to deployment ([Cloudaware on DevSecOps compliance](https://cloudaware.com/blog/devsecops-compliance/)). For automated identities specifically, the expected evidence set includes which identity initiated the action, the policy that allowed it, any human approvals, and the full command stream ([hoop.dev on SOC 2 for autonomous agents](https://hoop.dev/blog/soc-2-for-autonomous-agents-keeping-automated-access-compliant-on-ci-cd-pipelines)).
- **Agent-hook mapping**: append-only observers on PreToolUse (what was attempted + the policy decision), PostToolUse/PostToolUseFailure (what happened), SessionStart/SessionEnd and ConfigChange (who ran what config, and whether anyone changed the guardrails mid-session — Claude Code's ConfigChange event exists precisely for security auditing). Hooks writing JSONL per event produce the SOC 2 evidence chain for free; the run journal in this repo (ADR 0031) is the same shape.

### 3.10 Metrics/telemetry (DORA, failure classification)

- **Failure mode prevented**: not knowing whether delivery is getting better or worse, and treating all failures as one bucket so nothing gets systematically fixed. DORA's four keys — deployment frequency, lead time for changes, change failure rate, failed-deployment recovery time — pair throughput measures with stability measures ([dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)).
- **Agent-hook mapping**: SessionEnd / Stop / postToolUseFailure observers emitting structured telemetry: slice lead time (dispatch → merged), agent "change failure rate" (slices needing rework or reverted after ship-gate), recovery time (failure → green). Crucially, classify the failure cause **at the hook**, when context is richest — Cursor's own docs ship a stop-hook example forwarding per-conversation failure counts to a telemetry endpoint and auto-scheduling a retry after two consecutive failures ([Cursor hooks examples](https://cursor.com/docs/agent/hooks)). Misclassified failures cascade (this repo's issue #120: a gate failure misclassified as agent failure killed a slice), so classification-at-capture is a correctness feature, not just reporting.

---

## 4. Synthesis — hook archetypes

Six recurring categories cover essentially every hook and governance practice above.

### A. Pre-action gate (deterministic deny/allow before execution)
Decide before the side effect exists. Exemplars: Claude Code `PreToolUse` deny, Cursor `beforeShellExecution`/`beforeReadFile`, Gemini `BeforeTool`, MCP gateways with OPA/Cerbos, Kyverno admission control, gitleaks pre-commit, Endor Labs install interception, Liquibase policy checks, branch-protection push rules. Design notes: fail-closed for security gates (Cursor `failClosed`; Claude Code exit-2); deny **with a reason** so the agent can self-correct; deterministic script/policy-engine checks beat LLM evaluation here.

### B. Post-action validator (check the result, feed errors back)
The side effect happened; verify it and route failures back as instructions. Exemplars: Aider auto-lint/auto-test, Cursor `afterFileEdit` formatters and Semgrep regenerate-until-clean, Claude Code `PostToolUse` block-with-reason and `TaskCompleted` test gates, CI required status checks, husky/lint-staged. The block-reason channel makes this a repair loop, not just a report.

### C. Context injector (mutate what the model knows, not what it does)
Exemplars: Claude Code `SessionStart`/`additionalContext`/`UserPromptSubmit` stdout, Cursor `sessionStart` env + context, Gemini `BeforeAgent`/`BeforeModel`, LangChain `before_model` middleware, Copilot `copilot-setup-steps.yml`. Governance analogue: templates and org defaults. Claude Code's docs add a subtle rule: injected text should read as factual project statements, or the model's injection defenses may flag it.

### D. Session auditor (observe everything, block nothing)
Exemplars: Cursor `afterShellExecution`/`afterMCPExecution` audit hooks and MCP-partner audit trails, Claude Code `InstructionsLoaded`/`ConfigChange` logging, Gemini AfterModel logging, SOC 2 evidence chains, DORA telemetry capture. Cheap, async-friendly, and the foundation for compliance; auditing config/hook changes themselves (ConfigChange, Gemini's hook fingerprinting, CODEOWNERS on agent config) guards the guardrails.

### E. Human-approval escalator (pause for a person at the boundary)
Exemplars: Claude Code `permissionDecision: "ask"` (which even overrides silent auto-approval) and `defer` for embedding hosts, Codex approval policy + Smart-approval prefix rules, OpenHands confirmation policy driven by a risk analyzer, GitHub deployment protection rules with no-self-approval, CAB/separation-of-duties. The pattern: risk-classify, then escalate only above a threshold, and ensure the approver is not the actor.

### F. Budget/limit enforcer (bound loops, time, and spend)
Exemplars: Claude Code Stop-hook 8-continuation cap and per-hook timeouts, Cursor `loop_limit` on stop/subagentStop follow-ups, Codex sandbox as a hard resource boundary, rate limits in MCP gateways (API7), wall-clock ceilings and invocation bounds in this repo (ADR 0007/0019), suite time budgets (`suite-budgets.json`). Every auto-continue mechanism ships with a cap because unbounded agent loops are a spend and safety hazard; budget checks belong at Stop/loop events and in the environment, not in the prompt.

Cross-cutting lessons:
1. **Layer archetypes**: the strongest setups pair an environment boundary (sandbox/firewall) with pre-action gates for policy, post-action validators for quality, and an auditor for evidence — Codex (sandbox+approvals) and Claude/Cursor (hooks) are converging from opposite ends.
2. **Every gate needs a reason channel** — for the human (audit) and for the model (self-repair).
3. **Fail-open vs. fail-closed must be a per-hook decision**, with fail-closed for security and fail-open for convenience hooks, and monitoring for hooks that fail to start.
4. **Policy engines beat bespoke scripts at scale**: one OPA/Conftest bundle evaluated at git, CI, and agent choke points prevents the drift that per-tool scripts reintroduce.
