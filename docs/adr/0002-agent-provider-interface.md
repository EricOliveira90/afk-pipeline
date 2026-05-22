# Single AgentProvider interface over per-backend invokers

We collapsed the duplicated `kiro.ts` and `claude.ts` invokers into a
single `AgentProvider` interface, mirroring Sandcastle's pattern. Each
provider declares a `name` (`"kiro"`, `"claude-code"`), an `invoke()`
function that handles the spawn / idle-timer / stream parsing, and any
provider-specific stdout parsing (e.g. cost extraction for Claude). The
orchestrator no longer carries a `Backend` discriminator — provider
identity flows through `provider.name`, including for branch namespacing
(`afk/<slug>` for Kiro, `afk-claude-code/<slug>` for Claude).

**Why one interface instead of two modules:** the two invokers were ~90%
identical (spawn, idle reset, log streaming, exit handling). Adding a
third agent system meant a third copy. With the provider seam, adding a
backend is a single ~30-line object, and the orchestrator stays
provider-agnostic.

**Why "agent provider" and not "backend" or "agent runtime":** Sandcastle
already defines **agent provider** in its CONTEXT.md as "a pluggable
implementation that builds commands and parses output for a specific
agent." Adopting the existing term keeps vocabulary aligned across the
two codebases. `Backend` is retired; `Invoker` is reserved for the
function-level concept (the seam used by tests), not the type.

**Why `provider.name` drives branch prefixes:** the only reason the
orchestrator needed backend identity at all was to namespace slice and
feature branches so a Kiro run and a Claude run on the same PRD don't
collide. Putting `name` on the provider makes "add a new agent system" a
one-stop change and removes the last `Backend`-typed parameter from the
orchestrator API.

## Considered alternatives

- **Separate `BranchNamespace` config passed to `runPipeline`** —
  cleaner separation of concerns, but introduces a footgun where caller
  passes a Claude provider with a Kiro prefix. Rejected: the namespace
  decision _is_ a property of "which agent did this code come from."
- **Drop per-backend namespacing entirely** — simplest, but breaks
  resumability for anyone with both Kiro and Claude branches in flight.
  Rejected: cost of the breaking change > savings.
