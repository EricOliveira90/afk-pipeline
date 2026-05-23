# AFK Pipeline

Automated multi-agent orchestration pipeline that implements PRD slices
using Kiro CLI agents, with worktree-based branch isolation and
artifact-driven control flow.

## Language

**AFK Pipeline**:
The orchestration script that runs Kiro agents autonomously to implement
PRD slices without human interaction.
_Avoid_: "sandbox", "sandcastle", "CI pipeline"

**Slice**:
A thin vertical tracer-bullet through all integration layers, represented
as a GH issue. The atomic unit of work the pipeline processes.
_Avoid_: "task", "ticket", "issue" (ambiguous — issue is the GH container)

**Slice contract**:
The `contract.md` file that defines scope, test plan, and done-criteria
for a single slice. Negotiated between planner and evaluator, then locked.
_Avoid_: "spec", "requirements"

**Worktree**:
A git worktree created per-slice on its own branch. Provides branch-level
isolation without containers.
_Avoid_: "sandbox", "workspace", "clone"

**Feature branch**:
The `feat/<prd-slug>` branch that all slice branches merge into. Created
from `main` at pipeline start.
_Avoid_: "integration branch", "develop"

**Agent invocation**:
A single non-interactive call to an agent system (e.g. `kiro-cli chat
--no-interactive --trust-all-tools --agent <name>` or `claude -p --agent
<name>`). The atomic execution unit.
_Avoid_: "iteration", "run", "session"

**Agent provider**:
A pluggable adapter that knows how to invoke a specific agent system
(Kiro, Claude Code) — builds the spawn command, parses streamed output,
and contributes its `name` to branch namespacing. Injected into
`runPipeline` so backends are swappable without orchestrator changes.
Stream parsing is opt-in per provider (see **stream event** + ADR 0004).
_Avoid_: "backend", "invoker", "agent driver", "agent adapter"

**Idle warning**:
A periodic informational log line emitted while the spawned agent
process produces no stdout (default: every 60s). Distinct from the
**idle timeout** — the 10-minute hard kill. Warnings make long-running
invocations legible in slice logs and run-summary.md.
_Avoid_: "heartbeat" (implies the agent emits it), "liveness ping"

**Idle timeout**:
The hard-kill threshold (default: 10 minutes) for an agent invocation
producing no stdout. Reached only after many **idle warnings**.

**Stream event**:
A typed event parsed from a provider's streamed stdout — one of
`text`, `tool_call`, `result`, `session_id`. Only providers that emit
structured streams (e.g. `claude --output-format stream-json`)
implement parsing; for others the stream is treated as opaque stdout.
See ADR 0004.
_Avoid_: "agent stream event" (the AgentProvider scope is implicit)

**Invocation stats**:
Per-`invoke` aggregates returned on `InvokeResult` — `costUsd`,
`toolCallCount`. Populated by providers that parse **stream events**;
left undefined otherwise.

**Slice totals**:
Sum of **invocation stats** across all agent invocations for a single
slice (explorer, planner rounds, generator rounds, evaluator rounds).
Surfaced as a column in run-summary.md.

**Run totals**:
Sum of **slice totals** across all slices in a pipeline run. Surfaced
as a footer row in run-summary.md.

**Artifact**:
A structured file produced by an agent invocation that the pipeline parses
to determine the next step (contract.md, qa-report.md, handoff.md,
context.md, review-\*.md, stuck.md).
_Avoid_: "output", "result"

### Agents (execution layer)

**Explorer**:
Read-only agent that searches the codebase before planning/implementation
and writes `context.md` with relevant findings. Context engineering — keeps
noisy search out of other agents' context windows.

**Planner**:
Drafts the slice contract from a GH issue + memory files. Mode A only
(per-slice) in the AFK pipeline.

**Generator**:
Implements a locked contract via TDD. Writes code, tests, commits, and
`handoff.md`.

**Evaluator**:
Independent QA. Two modes: contract review (ACCEPT/REVISE) and slice
evaluation (PASS/FAIL).

### Agents (guardian layer)

**Architect reviewer**:
Post-implementation review of all slices against ARCHITECTURE.md and
CONVENTIONS.md. Writes `review-architect.md`.

**PM reviewer**:
Post-implementation review of all slices against PRODUCT.md. Writes
`review-pm.md`.

### Pipeline concepts

**DAG**:
Directed acyclic graph built from the `issues.md` dependency table.
Determines which slices can run in parallel.

**Round**:
One attempt at a pipeline step. Contract negotiation has max 2 rounds.
Generator implementation has max 3 rounds (1 initial + 2 retries).

**Escalation**:
When max rounds are exhausted, the pipeline stops the slice, writes
`stuck.md`, preserves the worktree, and continues with other slices.

**Lane**:
A serial chain of slices in a single wave whose declared file lists
overlap (transitive closure on shared files). Lanes run in parallel;
within a lane, each slice runs to completion and merges into the
**feature branch** before the next lane-mate starts. Computed by
`partitionLanes` from each slice's `contract.md` "Files expected to
change". See ADR 0005.
_Avoid_: "batch", "group" (too generic), "wave" (a wave contains lanes,
not the other way around)

**Lane leader**:
The first slice in a lane (by ascending slice number). Negotiates its
contract during the wave's parallel Phase A like any other slice;
unlike non-leaders, it does not pay the cost of a second negotiate
pass on a refreshed base.
_Avoid_: "lane head"

**Lane-cancelled**:
A slice deferred by the orchestrator because an earlier lane-mate
failed (STUCK / ESCALATE / ERROR / CONFLICT). Recorded as the
`LANE-CANCELLED` status. Distinct from **cancellation** (user-initiated)
and **escalation** (the agent gave up). Lane-cancelled slices are
re-eligible on the next pipeline run once the predecessor is fixed.
_Avoid_: "skipped" (HITL slices are skipped; lane-cancelled is
deferral, not skip), "blocked" (DAG-blocked is a separate concept)

**Pre-ship sanity gate**:
The post-merge check that runs the project's `typecheck`, `lint`, and
test scripts against the merged feature branch before the guardian
reviews and PR creation. Same guard a human's pre-push hook would
apply — necessary because every AFK commit uses `git commit --no-verify`,
so husky never runs during the pipeline. Steps not defined in
`package.json` are skipped, not failed. Failure short-circuits the
guardians and the PR; the run-summary records the failing step names.
_Avoid_: "QA gate" (the evaluator already owns that term), "pre-push hook"

**Cancellation**:
External termination via `AbortSignal` (typically SIGINT / Ctrl-C).
In-flight agent invocations are killed immediately, unstarted slices are
marked CANCELLED, and worktrees are preserved so a re-run resumes from
the artifact state on disk. Distinct from **escalation** (agent gave up)
and from `ERROR` (unexpected exception).
_Avoid_: "abort" (overloads with `git merge --abort`), "interrupted"

## Relationships

- The **AFK pipeline** reads `issues.md` to build a **DAG** of **slices**
- Each **slice** gets its own **worktree** on a dedicated branch
- The per-slice pipeline runs: **explorer** → **planner** → **evaluator** (contract) → **generator** → **evaluator** (QA)
- **Evaluator** contract review may trigger planner revision (max 2 **rounds**)
- **Evaluator** QA may trigger generator retry (max 3 **rounds**)
- After max rounds, the pipeline triggers **escalation** (stuck.md)
- On PASS, the slice branch merges into the **feature branch**
- After all slices merge, the **pre-ship sanity gate** runs (typecheck + lint + tests) on the **feature branch**
- If the **pre-ship sanity gate** fails, **architect reviewer** / **PM reviewer** / PR creation are skipped
- Otherwise, **architect reviewer** and **PM reviewer** run against the **feature branch**
- HITL slices are skipped entirely by the pipeline
- Parallel slices merge in completion order; merge conflicts trigger **escalation**
- The pipeline is resumable: slices with existing `qa-report.md` PASS are skipped

## Example dialogue

> **Dev:** "I have a PRD with 5 slices. Slices 1 and 2 are independent, 3 depends on 1, 4 depends on 1 and 2, and slice 5 is HITL."
>
> **Pipeline:** "I'll create `feat/<prd-slug>` from main. Slices 1 and 2 start in parallel. When 1 finishes, 3 starts. When both 1 and 2 finish, 4 starts. Slice 5 is HITL — skipped. After 1-4 pass, architect and PM review the merged feature branch."

> **Dev:** "Slice 3's generator failed 3 rounds. What now?"
>
> **Pipeline:** "Slice 3 is stuck. I wrote `stuck.md` in its folder and preserved the worktree. Slices 1, 2, 4 continued normally. Fix slice 3 manually, then re-run the pipeline — it'll skip the completed slices."

## Flagged ambiguities

- **"Issue"** — overloaded: GH issue (the container) vs slice (the work unit). Use **slice** for the work, "GH issue" for the tracker item.
- **"Agent"** — could mean the Kiro agent config or the conceptual role. Always qualify: "explorer agent", "planner agent", or "the `@planner` Kiro agent config."
- **"Branch"** — could mean slice branch or feature branch. Always qualify.
- **"Backend"** / **"Invoker"** — retired terms. Use **agent provider** for the pluggable adapter; reserve "invoker" only for the function call itself, not the type.
- **"Heartbeat"** / **"liveness ping"** — not used. The orchestrator observes stdout silence; the agent doesn't emit a keep-alive. Use **idle warning** (informational, periodic) and **idle timeout** (hard kill).
- **"Telemetry"** / **"metrics"** — overpromise infrastructure afk doesn't have. Use **invocation stats**, **slice totals**, **run totals**.
- **"Abort"** — reserved for `git merge --abort`. For pipeline-level termination via `AbortSignal`, use **cancellation** / `CANCELLED`.
