## Problem Statement

AFK already separates exploration, contract negotiation, implementation, slice evaluation, and post-implementation guardian review into focused agent invocations. That separation is valuable, but the pipeline still asks agents to enforce several facts that the orchestrator could prove mechanically.

The most important example is deterministic slice QA. AFK tells the evaluator to run type checking, linting, and tests, then accepts the evaluator's Markdown verdict. The final pre-ship sanity gate is stronger because the orchestrator itself executes commands and reads their exit codes. As a result, a slice can currently reach PASS because an agent said commands passed, skipped a command, misunderstood output, wrote an internally inconsistent report, or changed implementation files while reviewing them.

Other quality controls are similarly advisory:

- The slice contract's declared files influence lane partitioning, but actual changed files are not deterministically checked against the locked declaration.
- Empty or placeholder file declarations can be interpreted as no overlap instead of unknown scope.
- Acceptance scenarios are prose that an evaluator interprets rather than executable evidence owned by the orchestrator.
- Maintainability is judged subjectively after implementation; there is no dedicated repair role driven by measurable complexity, coverage, duplication, architecture, or CRAP-style thresholds.
- Test strength is inferred from coverage and review; there is no mutation-testing stage that proves tests detect meaningful behavioral changes.
- Guardian findings can block shipment, but AFK has no bounded aggregate remediation loop.
- Markdown artifact parsing is intentionally permissive. It can tolerate duplicate markers and does not validate the report as one coherent state.
- Agent providers run with broad write permissions. Prompt-level "read-only" instructions are guidelines, not mechanical isolation.

This matters for agents for the same reason it matters for humans: messy code increases cognitive load. Once enough accidental complexity accumulates, an implementation agent begins to thrash, fixing one behavior while breaking another and repeatedly traversing the same area. More prompt rules do not reliably solve this. Long instruction documents enter the model's context, lose prominence as the context grows, and become guidelines. Deterministic tools remain outside that attention problem and continue to return the same pass or fail result.

A quality gauntlet also needs the correct review order. The behavioral evaluator must review the generated candidate before cleaner or hardener work begins. Otherwise, those roles have no approved behavior baseline to preserve, and later QA cannot distinguish a generator defect from a regression introduced during cleanup or test hardening. Because cleaner and hardener invocations still write files, the final changed tree must be evaluated again before merge.

Role separation fails when every role receives the whole run history. Long prompts create context rot: instruction quality falls as unrelated context accumulates. They also create the "lost in the middle" problem: critical constraints can receive less attention when they sit inside a large prompt. A fresh invocation helps only when its input is also small, ordered, and limited to that role's decision.

Uncle Bob's described response is a focused quality gauntlet:

1. A specifier converts human intent into behavioral acceptance scenarios and a user-level QA procedure.
2. A coder writes tests and implementation that satisfy those scenarios.
3. A cleaner performs code review and repairs measurable maintainability problems, including CRAP-style combinations of complexity and coverage.
4. A hardener runs mutation testing and strengthens tests until meaningful mutants are killed.
5. A QA agent executes the system from the user's point of view and produces a deterministic result.

Each agent is born with a focused context, performs one kind of work, hands artifacts forward, and dies. Fresh contexts reduce "lost in the middle" and prevent an implementation trajectory from becoming its own review trajectory. The agents remain probabilistic; deterministic tools decide whether each stage is complete.

The tradeoff is intentional. Uncle Bob describes a task that one agent might complete in five minutes with questionable quality taking about an hour through the full gauntlet, while still beating roughly half a day of human work by a factor of four or five. AFK needs explicit controls for that tradeoff so expensive checks can be scoped to changed modules and enabled according to project risk without weakening the invariant that configured gates are real gates.

## Solution

Evolve AFK's per-slice pipeline into an orchestrator-owned quality gauntlet:

**Explorer → Planner ↔ Contract evaluator → [Generator → Base and acceptance gates → Candidate behavioral evaluator] × up to three rounds → [Cleaner → Quality and regression gates] × up to three rounds → [Hardener → Mutation and regression gates] × up to three rounds → Final behavioral evaluator or exact-tree PASS reuse → File-scope gate → Merge → Aggregate gates → Architect/PM guardians → bounded Remediator → Draft PR**

AFK's existing planner and contract evaluator together fulfill the specifier responsibility. They will additionally produce and validate a versioned executable-acceptance manifest. The generator remains the coder. The candidate evaluator approves the generated behavior before post-processing begins. New cleaner and hardener roles receive fresh, minimal contexts and repair only their assigned quality class without changing intended business behavior. The final evaluator checks the final tree when a later writing role changes it.

The orchestrator, not an agent, executes configured commands, captures immutable results, validates structured artifacts, enforces file scope, and decides whether a stage advances. Agents receive deterministic failures as repair input but cannot self-certify that a gate passed.

Each role prompt is a small context envelope rather than a copy of the whole run. It states one objective, the allowed write scope, the stop condition, the current checkpoint, and only the unresolved evidence needed for that job. Prior conversations, unrelated documents, passing logs, and findings owned by another role stay out of the prompt.

Projects opt into language- and framework-specific tools through a versioned quality policy. AFK stays language-agnostic: it orchestrates commands and evidence but does not implement its own complexity analyzer, mutation engine, browser automation framework, or architecture checker.

The pipeline remains incremental. It applies the gauntlet to small slices and preserves AFK's DAG, wave, lane, resumption, cancellation, and failure-class behavior. It does not replace small feedback cycles with a large upfront specification.

## User Stories

1. As a run operator, I want AFK itself to execute deterministic gates, so that an agent cannot claim a command passed when it did not.
2. As a run operator, I want every configured gate to have a recorded exit status, duration, tree identity, and log artifact, so that PASS is auditable.
3. As a run operator, I want a required gate failure to stop the slice before merge, so that the feature branch never receives code that failed its declared quality policy.
4. As a run operator, I want independent gates to continue after one failure when safe, so that one repair round receives the complete set of findings.
5. As a run operator, I want infrastructure failures distinguished from implementation failures, so that an outage does not consume a repair round.
6. As a run operator, I want missing required tooling to fail clearly as configuration error, so that skipped enforcement is never mistaken for quality.
7. As a run operator, I want optional gates reported as skipped, so that the quality evidence says what was and was not checked.
8. As a run operator, I want successful expensive gates cached against an immutable tree identity, so that retries do not pay again for unchanged code.
9. As a maintainer, I want one reusable gate-runner interface, so that base, quality, mutation, acceptance, architecture, and aggregate commands share timeout, cancellation, logging, and evidence behavior.
10. As a maintainer, I want project-specific quality commands declared outside prompts, so that changing a prompt cannot weaken enforcement.
11. As a maintainer, I want AFK to remain language-agnostic, so that JavaScript, Go, Java, Clojure, and other projects can select their own tools.
12. As a planner agent, I want each in-scope behavior mapped to an executable acceptance scenario, so that "done" is falsifiable.
13. As a contract evaluator, I want to reject scenarios that require unbounded human judgment, so that the behavioral evaluator can produce pass or fail evidence.
14. As a contract evaluator, I want acceptance scenarios to reference configured gate identities rather than arbitrary shell text, so that executable intent is constrained by project policy.
15. As a generator agent, I want the locked acceptance manifest before implementation, so that I can build toward observable behavior.
16. As a generator agent, I want deterministic base-gate failures returned in a structured report, so that I can repair all known failures in one round.
17. As a generator agent, I want my candidate implementation checkpointed before review, so that later evidence refers to an exact tree.
18. As a generator agent, I want reviewer changes mechanically isolated from my branch, so that review cannot silently modify the implementation it approves.
19. As an evaluator agent, I want immutable gate results supplied as input, so that I can focus on behavior, boundaries, preservation, and judgment instead of re-running baseline commands.
20. As an evaluator agent, I want a fresh context separate from implementation, so that implementation trajectory does not bias review.
21. As a run operator, I want evaluator output validated as a coherent versioned artifact, so that duplicate or contradictory verdict fields cannot pass.
22. As a run operator, I want PASS to require a NONE failure class and no blocking findings, so that report invariants are enforced mechanically.
23. As a run operator, I want malformed or missing canonical artifacts to fail closed, so that prose formatting accidents cannot ship code.
24. As a run operator, I want human-readable reports retained beside canonical structured results, so that auditability does not sacrifice readability.
25. As a run operator, I want actual changed files compared with the locked slice contract, so that implementation cannot silently expand scope.
26. As a run operator, I want unauthorized paths listed exactly, so that the next generator round can revert them without guesswork.
27. As a run operator, I want missing, empty, placeholder, or unknown file declarations treated conservatively, so that uncertain slices cannot run in unsafe parallel lanes.
28. As a planner agent, I want an explicit no-repository-change declaration for slices that truly change no files, so that empty scope is distinct from unknown scope.
29. As a contract evaluator, I want concrete file declarations required before lock, so that lane partitioning and later scope enforcement use the same source of truth.
30. As a cleaner agent, I want a fresh context containing the contract, candidate tree, and measured quality failures, so that I focus only on maintainability.
31. As a cleaner agent, I want to repair complexity, coverage, duplication, formatting, naming, and architecture findings without re-discovering product intent, so that my role remains narrow.
32. As a run operator, I want cleaner progress bounded by a configurable round limit, so that a pathological quality threshold cannot loop forever.
33. As a run operator, I want cleaner exhaustion preserved as structured evidence, so that escalation explains exactly which gates remained red.
34. As a hardener agent, I want mutation survivors tied to source locations and mutations, so that I can strengthen the relevant tests.
35. As a hardener agent, I want to receive only mutation and test-strength evidence, so that my context remains focused.
36. As a run operator, I want mutation testing scoped by project policy, so that high-value modules can be hardened without always mutating the entire repository.
37. As a run operator, I want the mutation threshold owned by the consuming project, so that AFK does not impose one universal percentage on every domain.
38. As a run operator, I want critical surviving mutants to block regardless of aggregate percentage, so that a score cannot hide an important test hole.
39. As a run operator, I want hardener progress bounded by a configurable round limit, so that mutation repair remains operationally predictable.
40. As a product owner, I want candidate and final behavioral QA to receive orchestrator-owned user-level acceptance evidence, so that passing unit tests or evaluator prose alone cannot certify the slice.
41. As a product owner, I want acceptance evidence linked back to slice-contract behavior identifiers, so that every promised outcome has a result.
42. As a product owner, I want preservation scenarios executed alongside new behavior, so that a slice cannot satisfy its new scope by deleting existing affordances.
43. As an architect, I want dependency and module rules enforced by project-owned commands, so that architectural decisions do not rely only on reviewer memory.
44. As an architect, I want architecture failures returned to the cleaner before merge, so that structural debt is repaired while the slice context is fresh.
45. As an architect reviewer, I want guardians to remain read-only, so that independent judgment cannot mutate the branch it judges.
46. As a PM reviewer, I want deterministic aggregate and acceptance evidence available before review, so that I can focus on product outcomes.
47. As a run operator, I want guardian blockers handed to a distinct remediator, so that reviewers do not approve their own edits.
48. As a remediator agent, I want only cited blocking findings and their evidence, so that aggregate repair does not become an unrelated refactor.
49. As a run operator, I want remediation bounded to a small number of rounds, so that a blocked ship cannot loop indefinitely.
50. As a run operator, I want all aggregate deterministic gates and both guardians rerun after remediation, so that a local fix cannot invalidate another guarantee.
51. As a run operator, I want infrastructure or unparseable guardian failures to remain operational failures, so that remediation is not invoked without actionable findings.
52. As a run operator, I want existing PM override semantics preserved, so that explicit human governance still works as documented.
53. As a run operator, I want every gauntlet stage represented in run events and summaries, so that current and future status views can explain where time was spent.
54. As a run operator, I want per-stage elapsed time and repair-round counts, so that quality cost is visible rather than hidden.
55. As a maintainer, I want gate results and reviewer artifacts preserved per attempt, so that later attempts never erase earlier evidence.
56. As a maintainer, I want retries to receive all unresolved prior findings, so that repair does not regress to fixing only the newest symptom.
57. As a maintainer, I want old projects without a quality policy to retain today's baseline behavior initially, so that adoption can be staged.
58. As a maintainer, I want configured enforcement to fail closed once enabled, so that partial rollout cannot silently degrade.
59. As a maintainer, I want cancellation to stop commands and agents through the existing cancellation signal, so that the gauntlet does not create orphan work.
60. As a maintainer, I want resumption to reuse immutable passing evidence only when the tree is unchanged, so that stale quality results are never trusted.
61. As a lead engineer, I want small slices to remain the unit of work, so that added quality does not turn AFK into waterfall planning.
62. As a lead engineer, I want human values enforced through measurable outcomes rather than forcing agents to imitate every human ritual, so that the workflow fits agent strengths.
63. As a lead engineer, I want architecture policy and quality thresholds to remain human-owned strategic decisions, so that tactical agents do not invent governance.
64. As a lead engineer, I want the cost of each added gate observable, so that quality and throughput can be tuned with evidence.
65. As a product owner, I want the evaluator to approve generated behavior before cleaner or hardener work starts, so that later roles preserve a known-good business baseline.
66. As a run operator, I want candidate evaluation bounded to three rounds by default, so that repeated generator review cannot loop forever.
67. As a run operator, I want base and acceptance gates rerun after every cleaner or hardener checkpoint, so that an accidental behavior change stops immediately.
68. As a product owner, I want a fresh final evaluator to review the final changed tree, so that an earlier PASS cannot certify later edits.
69. As a cleaner or hardener agent, I want a prompt that contains only my objective, allowed edits, stop condition, current checkpoint, and unresolved evidence, so that unrelated context cannot distract me.
70. As a maintainer, I want every role to have a versioned context manifest and configurable size budget, so that prompt growth is visible and controlled.
71. As a maintainer, I want each review or repair round to start as a fresh invocation without prior conversation history, so that context rot does not accumulate across rounds.
72. As a maintainer, I want large logs and unrelated documents passed as artifact references instead of inline prompt text, so that critical instructions do not get lost in the middle.

## Implementation Decisions

### 0. Terminology: three different manifests

ADR 0034 introduced a file called a manifest after this specification was
written. Three distinct artifacts now carry that word. Always qualify it.

| Term | Artifact | Owner | Purpose |
| --- | --- | --- | --- |
| AFK run manifest | `<prd-dir>/afk.json` | The `to-afk` preparation step | Declares `selectedSlices`, the `migrationPrefixes` reservation pool, and `protectedIssues` for one run (ADR 0034) |
| Acceptance manifest | Versioned artifact beside the slice contract | Planner, locked by the contract evaluator | Maps every in-scope behavior to an executable acceptance gate (§8) |
| Role context manifest | Versioned per-role declaration inside AFK | AFK | Declares one role's objective, write scope, accepted inputs, and size budget (§6) |

These three are unrelated. The AFK run manifest is not a quality policy, does
not describe behavior, and does not configure prompts.

### 1. Delivery shape

- This is a parent specification and must be implemented as small dependent slices, not one agent invocation.
- The required delivery order is:
  1. Canonical reviewer-result schemas and invariant validation.
  2. Orchestrator-owned gate runner and baseline gate evidence.
  3. Candidate checkpoints and mechanically isolated review invocations.
  4. Deterministic changed-file scope enforcement.
  5. Versioned executable-acceptance manifest, configured acceptance gates, and candidate evaluation before post-processing.
  6. Versioned role context manifests, focused prompt assembly, and context-size evidence.
  7. Cleaner role with configurable maintainability, architecture, and behavior-regression gates.
  8. Hardener role with configurable mutation and behavior-regression gates.
  9. Final evaluation of every final tree changed after candidate approval.
  10. Aggregate guardian remediation and complete observability.
- Each slice must preserve AFK's existing DAG, wave, lane, narrowed-invocation, resumption, cancellation, MERGE-PENDING, and blocked-ship semantics.
- Each slice must also preserve the behavior added after this specification was written. Two decisions landed later and are load-bearing:
  - ADR 0033 extracted post-wave shipping into `ship-gate.ts`, the pre-ship sanity command policy into `preship.ts`, and migration validation into `migration-gate.ts`. Aggregate gates, guardian invocation, guardian artifact commits, review caching, and PR planning belong to those modules. A slice that adds aggregate or guardian behavior extends the ship gate through its interface. It does not move the phase back inline into `runPipeline`.
  - ADR 0034 added `afk.json` and pipeline-owned migration claims. Manifest run scope (`selectedSlices` as the default scope, out-of-manifest slices failing closed), the migration prefix pool, per-slice claims in run state, the contract-lock claim gate, the pre-QA and pre-merge generated-migration checks, and the pre-ship trim of unused reservations all remain intact.

### 2. One deterministic gate-runner module

- Introduce one deep gate-runner module used by every command-based quality stage.
- Its interface accepts an immutable candidate tree, working directory, ordered gate declarations, cancellation signal, inactivity timeout, wall-clock ceiling, and evidence destination.
- It returns structured results per gate: identity, stage, PASS/FAIL/INFRASTRUCTURE/SKIPPED status, start and end timestamps, duration, exit code when present, candidate tree identity, and log artifact identity.
- It executes commands itself. Agents never report command success on the orchestrator's behalf.
- Independent gates continue after one failure unless a gate declares a prerequisite on another gate.
- Gate logs stream through the existing command-runtime and liveness mechanisms.
- A missing required executable or invalid gate declaration is a configuration failure, not a skip.
- Optional gates may skip, but the skip is explicit in evidence and summaries.
- A passing result may be reused only for the same gate definition and identical tree identity.

### 3. Versioned project quality policy

- Add one optional, versioned project quality policy consumed by all providers.
- The policy lives in its own file, separate from the AFK run manifest (`afk.json`). It is not a section inside `afk.json`. Three reasons:
  - `to-afk` writes `afk.json` per run. The quality policy is human-owned strategic configuration that outlives any single run (§14, user story 63).
  - `afk.json` is a cross-repository contract parsed strictly by this pipeline and by the consuming repository's preflight through the `./afk-manifest` entry point (ADR 0034). Adding an unrelated schema there gives one file two owners and two reasons to change.
  - Absence of `afk.json` is documented legacy mode. Absence of a quality policy is the staged-adoption baseline. The two must fail independently, so they cannot share a version field.
- The policy declares named gates for these stages: base, acceptance, clean, harden, architecture, and aggregate.
- A gate declaration includes a stable ID, command, required/optional status, scope, prerequisite IDs, timeout override when needed, and whether a passing result is cacheable.
- Acceptance scenarios reference gate IDs, never agent-generated arbitrary commands.
- The policy may declare role-specific write scopes. Hardener scope defaults to tests and test-support files; cleaner scope may include implementation files but never locked control artifacts.
- AFK owns versioned role context manifests. Project policy may set stricter inline-size budgets but cannot add undeclared context classes without a manifest-version change.
- AFK continues to derive its existing typecheck, lint, and test commands when no policy exists.
- Cleaner, hardener, mutation, and additional architecture stages remain disabled until their gates are configured.
- Once a stage is configured, its required gates fail closed.
- Consuming repositories own language-specific tools and thresholds. AFK owns orchestration, evidence, retries, and stage transitions.

### 4. Canonical structured artifacts

- Reviewer decisions gain canonical versioned structured artifacts. Markdown remains a human-readable companion, not the control-plane source.
- Contract review, candidate behavioral QA, final behavioral QA, architect review, and PM review each have a strict schema with one verdict, one failure classification where applicable, and a findings collection.
- Candidate and final behavioral artifacts record their exact checkpoint, behavior-baseline identity, review attempt, and whether AFK reused an exact-tree PASS.
- Schema parsing validates the entire artifact, rejects unknown required values, and rejects contradictory states.
- PASS requires no implementation or infrastructure failure classification and no blocking finding.
- FAIL requires an actionable implementation finding or explicit infrastructure evidence.
- Favorable guardian verdicts cannot coexist with blocking findings.
- Missing, malformed, duplicate, or contradictory control fields are terminal artifact failures; permissive "last marker wins" behavior is removed from control flow.
- The orchestrator attaches gate-result references to canonical artifacts. An agent cannot replace deterministic evidence with prose.
- Every attempt is archived. Later attempts identify resolved and unresolved prior findings without overwriting history.

### 5. Candidate checkpoint, behavior baseline, and reviewer isolation

- After every writing-agent invocation, AFK creates an orchestrator-owned candidate checkpoint representing the exact tree to be gated.
- Base, quality, mutation, acceptance, and scope evidence is keyed to that checkpoint.
- After generation, required base and acceptance gates run before the candidate behavioral evaluator. A failed deterministic gate returns directly to the generator and does not consume an evaluator round.
- The candidate evaluator inspects a detached disposable worktree and focuses on external behavior, preservation, boundaries, and product intent.
- Candidate evaluation is bounded to three review rounds by default. Each FAIL returns structured findings to a fresh generator invocation, and every changed candidate must pass base and acceptance gates before the next review.
- A canonical candidate-evaluator PASS establishes the approved behavior baseline. It is keyed to the exact checkpoint, locked contract, acceptance manifest, and gate evidence.
- Cleaner and hardener stages cannot start until that approved behavior baseline exists.
- Evaluators and guardians inspect detached disposable worktrees created from the relevant candidate checkpoint.
- Only allowlisted review artifacts are copied back by the orchestrator. Any source edits in a disposable review worktree are discarded and recorded as a reviewer contract violation.
- Reviewers never share a writable checkout with each other.
- A failed review leaves the candidate branch available to the responsible writing-agent round together with focused review evidence.
- The implementation branch is never advanced by evaluator or guardian edits.

### 6. Minimal role prompts and context envelopes

- Every agent role has one versioned context manifest. The manifest declares its objective, non-goals, allowed write scope, stop and escalation conditions, accepted input artifacts, output artifact, input order, and configurable inline-size budget.
- Prompt assembly is role-specific. It must not concatenate the whole run history or reuse another role's prompt as a prefix.
- Put the role objective, write boundary, and stop condition first. Put current unresolved evidence and the required output contract last. Keep supporting context between them small.
- Start every agent round as a fresh invocation. Do not include prior conversation messages, hidden reasoning, or another role's conversation.
- Include only the current checkpoint identity, the smallest required contract view, unresolved findings owned by that role, and evidence needed for the current decision.
- Exclude unrelated planning prose, resolved findings, successful raw logs, outputs from unrelated roles, and repository documents that do not govern the current task.
- Keep large logs and full supporting documents as immutable artifacts. Give the agent an exact artifact reference and a short canonical finding summary instead of inserting the full content inline.
- Preserve stable behavior IDs, gate IDs, finding IDs, source locations, and checkpoint IDs during any schema-driven compaction. Never truncate an authoritative contract or unresolved finding silently.
- Record assembled prompt size, included artifact IDs, omitted artifact classes, and context-manifest version in run evidence. Record provider token counts when the provider exposes them.
- If required content exceeds the configured budget, AFK fails prompt preparation with a clear configuration result. It does not drop required content or ask the agent to work from an incomplete contract.
- The same logical context envelope applies across Kiro, Claude Code, Codex, and future providers even when provider-specific wrapper syntax differs.
- Deterministic gates, not extra prompt prose, enforce facts that the orchestrator can check.
- Prompt assembly is deterministic for the same context-manifest version and artifact set, except for explicit run and checkpoint identities.
- Small contract and evidence views are deterministic schema projections, not new agent summaries. They retain all governing IDs, constraints, and unresolved findings.

The context manifests implement these narrow role contracts. The table defines logical content, not exact prompt wording.

| Role | Sole objective | Include | Exclude | Write access |
| --- | --- | --- | --- | --- |
| Explorer | Find facts and unknowns needed for one run | Request, governing documents, targeted repository evidence | Implementation instructions, review history, unrelated documents | Explorer artifact only |
| Planner | Define one small executable slice | Explorer findings, selected scope, policy gate IDs, governing product constraints | Implementation conversation, later-stage findings, raw logs | Proposed contract and acceptance manifest |
| Contract evaluator | Accept or reject the proposed slice contract | Proposed contract, acceptance manifest, governing constraints, configured gate catalog | Generator output, cleanup concerns, unrelated run history | Review artifact only |
| Generator | Implement the locked business behavior | Locked contract, acceptance manifest, allowed file scope, unresolved generator or candidate-evaluator findings | Cleaner, hardener, guardian, and resolved findings | Declared slice files |
| Candidate evaluator | Decide whether generated behavior is correct | Locked behavior view, checkpoint, base and acceptance evidence, prior unresolved candidate findings | Generator conversation, maintainability analysis, mutation results | Review artifact only |
| Cleaner | Repair measurable maintainability failures | Approved baseline IDs, current checkpoint, quality failures, cleaner write scope | Generator conversation, product redesign, mutation and guardian findings | Configured cleaner files |
| Hardener | Strengthen tests against surviving mutants | Approved baseline IDs, current checkpoint, mutation evidence, test-file scope | Generator and cleaner conversations, product redesign, unrelated quality logs | Tests and test support by default |
| Final evaluator | Decide whether the final tree preserves approved behavior | Locked behavior view, final checkpoint, passing regression evidence, orchestrator-generated baseline change summary | Full prior conversations, maintainability and mutation analysis | Review artifact only |
| Architect and PM guardians | Judge the integrated feature branch from one strategic view | Aggregate checkpoint, governing architecture or product documents, aggregate gate evidence | Slice conversations, unrelated logs, the other guardian's output | Review artifacts only |
| Remediator | Repair cited aggregate blockers | Selected blocker IDs, cited evidence, allowed run scope, governing documents | Favorable findings, unrelated backlog, full guardian conversations | Configured remediation scope |

### 7. Locked file scope as an enforceable contract

- The contract must declare concrete repository-relative paths or an explicit "no repository files change" state before it can lock.
- Missing sections, empty sections, rough placeholders, and unknown placeholders mean undeclared scope.
- Undeclared scope conflicts with every sibling for lane partitioning and causes the contract evaluator or contract-lock gate to request revision.
- The deterministic scope gate compares all tracked and untracked candidate changes against the locked declaration and an AFK-owned artifact allowlist.
- After each writing role, AFK also compares paths changed since that role's input checkpoint with its configured role write scope. A violation rejects the checkpoint before later gates run.
- Any undeclared implementation path fails the slice and lists the exact paths.
- The generator must revert unauthorized changes. A writing agent cannot expand a locked contract.
- If the slice genuinely needs additional scope, it escalates for contract revision rather than silently self-authorizing.
- The same normalized declaration feeds lane partitioning, lane-shared-resource recognition, contract-lock gates, and final scope enforcement.
- "The same declaration" means one shared source, not the only input. Migration-bearing slices carry an additional, separate lane resource key (ADR 0027) and additional contract-lock and pre-merge gates (ADR 0034). The scope work composes with them and replaces neither:
  - Lane partitioning reads the normalized declaration **and** the migration resource key. A slice that serializes only on declared file overlap breaks ADR 0027's migration lane grouping.
  - Contract lock runs the scope check **and** `validateContractMigrationClaim`. A contract that uses a prefix outside its claim is refused and spends a contract round, exactly like a scope refusal.
  - Pre-merge enforcement runs the changed-file gate **and** `validateGeneratedMigrations`, which diffs generated migration files against both the contract and the claim.
- The AFK artifact allowlist must account for paths the orchestrator itself writes. `<prd-dir>/afk.json` is one: before the ship gate, AFK trims unused migration reservations and commits that change on the reviewed feature branch (ADR 0034). Per-slice artifacts under `.kiro/specs/<prd>/slices/<slice>/` are another. An allowlist derived only from agent-written paths will reject the orchestrator's own commits.

### 8. Executable acceptance manifest and regression baseline

- Contract negotiation produces a versioned acceptance manifest beside the human-readable slice contract.
- Every in-scope behavior has a stable behavior ID, source citation, Given/When/Then description, observable result, preservation relevance, and one or more configured acceptance gate IDs.
- Every acceptance scenario is written from an external user, CLI, API, or UI perspective.
- The contract evaluator refuses lock when an in-scope behavior lacks an executable mapping, requires unbounded human judgment, or references an undefined gate.
- The generator receives the locked acceptance manifest and implements the code and tests needed to satisfy it.
- The orchestrator executes acceptance gates before each candidate behavioral evaluation. Their results, not evaluator prose, decide whether review can start.
- After candidate approval, the locked contract, acceptance manifest, candidate PASS, and passing gate results form the approved behavior baseline.
- After every cleaner or hardener checkpoint, the orchestrator reruns base and acceptance gates plus all previously passed gates that the edit can affect.
- A later writing role cannot change the locked contract, acceptance manifest, or approved evaluator artifact. A failed regression gate blocks progress and names the changed behavior IDs.
- The behavioral evaluator remains useful for boundary, preservation, error-handling, and product judgment, but cannot override a failed acceptance gate.

### 9. Cleaner loop

- Add a dedicated cleaner writing role with a fresh context after the candidate evaluator approves generated behavior.
- Input is limited to the approved checkpoint, the smallest required contract and behavior-baseline view, measured quality failures, applicable quality-policy rules, allowed edit scope, and unresolved cleaner findings.
- The cleaner repairs maintainability without intentionally changing external behavior, business rules, acceptance criteria, or the approved behavior baseline.
- The cleaner may change implementation structure and related tests inside its configured write scope. It cannot edit the locked contract, acceptance manifest, or evaluator artifacts.
- Typical project-selected gates include coverage, cyclomatic complexity, CRAP-style complexity/coverage scoring, duplication, formatting, static analysis, dependency cycles, forbidden imports, and architecture rules.
- AFK does not calculate these metrics itself. The project-selected tools return pass or fail.
- After every cleaner checkpoint, the orchestrator runs quality gates and the regression bundle. The regression bundle includes base and acceptance gates and any previously passed gate affected by the change.
- If cleanup causes a behavior regression, the cleaner may only restore the approved behavior or revert its refactor. It cannot redefine the expected behavior.
- If a cleaner finding reveals that the approved business behavior itself is wrong, the cleaner emits a structured escalation. AFK returns the slice to the generator and candidate-evaluator loop and invalidates downstream evidence.
- The orchestrator alternates cleaner invocation and gates for at most three rounds by default.
- All independent gate failures are returned together.
- Exhaustion produces structured escalation with remaining failed gates and preserves the slice branch.
- The cleaner is judged by human values such as clarity, locality, testability, and disciplined module interfaces; it is not required to imitate a prescribed human refactoring ritual.

### 10. Hardener loop

- Add a dedicated hardener writing role with a fresh context after cleaner quality and regression gates pass.
- Input is limited to the approved behavior-baseline view, current checkpoint, configured test-file scope, mutation results, applicable hardening rules, and unresolved hardener findings.
- Mutation testing is project-configured and normally scoped to changed or explicitly critical modules.
- Mutation evidence identifies the source location, mutation operator, affected gate, and survivor/killed status.
- The project owns aggregate mutation thresholds and any critical-mutant rules.
- A critical surviving mutant blocks regardless of aggregate score.
- The hardener strengthens tests and test support code without changing intended business behavior, the locked contract, the acceptance manifest, or evaluator artifacts.
- The hardener cannot edit production files by default. A project may widen that role scope only through explicit policy, and regression gates still protect the approved behavior baseline.
- If a surviving mutant exposes a production defect or a wrong business rule, the hardener emits a structured finding for the generator. It does not repair production behavior itself.
- After every hardener checkpoint, the orchestrator runs the mutation gate and the regression bundle.
- The hardener must not silence useful mutants through broad exclusions or weaker assertions.
- The orchestrator alternates hardener invocation and gates for at most three rounds by default.
- Exhaustion preserves complete mutation evidence and escalates the slice.

### 11. Final behavioral QA and merge boundary

- A fresh final behavioral evaluator reviews the final checkpoint after cleaner and hardener stages complete and all configured deterministic gates pass.
- If no writing stage changed the exact candidate-approved tree, AFK may reuse the candidate PASS because its tree identity still matches.
- If any later writing stage changed the tree, AFK cannot reuse the earlier PASS. The final evaluator receives the locked behavior view, final checkpoint, passing gate evidence, and a concise baseline-to-final change summary.
- The final evaluator focuses only on external behavior, preservation, boundaries, and product intent. It does not repeat maintainability or mutation analysis.
- A regression finding returns to the writing stage that introduced it when the stage can restore the approved behavior within its remaining round budget. That role cannot redefine business behavior.
- A finding that shows the approved behavior itself is wrong returns to the generator and candidate-evaluator loop. AFK invalidates cleaner, hardener, and final-review evidence tied to the old baseline.
- Final evaluation is bounded to three review attempts by default. Every repair produces a new checkpoint and reruns all affected deterministic gates before another final review.
- The deterministic file-scope gate runs against the final candidate before merge.
- A slice reaches PASS only when all required gates pass, the candidate evaluator artifact and final review decision apply to their exact checkpoints, canonical artifact validation passes, and the scope gate passes.
- The slice branch merge remains serialized through the existing merge mutex.
- The aggregate pre-ship gate reruns configured feature-branch checks because independently passing slices can still fail in combination.

### 12. Guardian remediation

- Architect and PM guardians remain parallel, independent, and mechanically read-only.
- A real FIX-BEFORE-SHIP verdict with structured blocking findings may invoke a distinct remediator writing role.
- Infrastructure failures, missing artifacts, and unparseable guardian results do not invoke remediation.
- The remediator receives only the selected run scope, blocking findings, cited evidence, feature-branch checkpoint, and governing product/architecture documents.
- Remediation is bounded to two rounds by default.
- After each remediation checkpoint, all configured aggregate gates and both guardians rerun.
- A still-blocked branch after the final round remains a blocked ship.
- Existing explicit PM override behavior remains available and is recorded exactly as today.

### 13. Failure classification, resumption, and evidence

- Deterministic gate failure is an implementation failure unless command execution itself provides structured evidence of an infrastructure cause.
- A timeout alone is not automatically infrastructure; it may represent an implementation performance defect.
- Infrastructure retries do not consume generator, cleaner, hardener, evaluator, or remediation rounds.
- Every stage emits structured run events for start, end, round, attempt, tree identity, gate IDs, outcomes, and duration.
- Run summaries show which stages were enabled, passed, failed, skipped, cached, or exhausted.
- Resumption reuses only canonical PASS evidence tied to the current tree and unchanged policy definition.
- Gauntlet evidence extends the run-state schema; it does not rewrite it. Run state already carries an optional `migrations` field holding the prefix pool and per-issue claims (ADR 0034, extending ADR 0018). A slice keeps its claimed prefixes across rounds and across runs, and claim state is validated on every load. New gate, checkpoint, and stage evidence must preserve that field and its validation.
- Cancellation uses the existing cancellation signal and process-tree termination behavior.
- No retry may erase evidence from an earlier attempt.

### 14. Throughput and strategic control

- Base enforcement remains the minimum for every slice.
- Cleaner and hardener stages activate only when project policy declares their gates.
- Expensive tools should support changed-module or risk-based scopes, but the consuming project's command owns that optimization.
- AFK records elapsed time per gate and stage so maintainers can decide whether an added check still preserves an acceptable productivity advantage.
- AFK records prompt size and provider token use per role so maintainers can find context growth that increases cost, latency, or error rate.
- Candidate evaluation prevents expensive cleaner and hardener work on behavior that is already wrong.
- Exact-tree evidence lets AFK reuse candidate PASS when no post-approval write occurred. It never pays for final review only to review an unchanged tree.
- Focused context envelopes reduce prompt tokens and agent search work while deterministic gates carry repeatable facts outside the prompt.
- The objective is not maximum checks at any cost. The objective is the strongest configured evidence that still keeps AFK materially faster than equivalent human implementation.
- Human maintainers remain responsible for strategic choices: slice boundaries, product intent, module design policy, architecture rules, mutation thresholds, and quality budgets.
- AFK continues to favor small slices, rapid feedback, and reorganization over large upfront plans.

## Testing Decisions

### Primary seam

- The primary test seam is the existing full-pipeline filesystem contract: a real temporary git repository, a real DAG of slices, the real orchestrator, a stub agent provider, and fake deterministic gate executables.
- Tests assert only externally observable behavior: branches and commits, canonical artifacts, archived attempts, command logs, run events, run state, summaries, and terminal pipeline result.
- This one seam proves that an agent invocation cannot advance the pipeline without satisfying orchestrator-owned evidence.

### Focused module tests

- Gate-runner tests cover ordered execution, independent failure collection, prerequisites, timeout and cancellation behavior, exit evidence, optional skips, required-tool failures, and tree/policy cache keys.
- Structured-artifact tests cover valid states and every contradictory or malformed combination.
- Acceptance-manifest tests cover behavior coverage, undefined gate IDs, duplicate behavior IDs, source citations, and executable mappings.
- Scope tests cover normalization, concrete paths, explicit no-change contracts, unknown declarations, tracked changes, untracked changes, and AFK artifact allowlists.
- Candidate and final evaluator tests cover stage order, exact-tree evidence, three-round bounds, return to the correct writing role, and invalidation after a baseline reset.
- Cleaner and hardener orchestration tests cover blocked start before candidate PASS, pass on first attempt, behavior regression, fail then repair, infrastructure retry, round exhaustion, and preservation of every attempt.
- Context-envelope tests cover role input allowlists, excluded artifact classes, fresh invocation state, stable identifier preservation, input order, size evidence, and over-budget failure without silent truncation.
- Guardian remediation tests cover favorable first review, one-round repair, two-round exhaustion, infrastructure failure without remediation, and existing PM override behavior.

### Required end-to-end scenarios

1. An evaluator writes PASS while a base command exits non-zero; the slice does not merge.
2. An evaluator writes PASS with an infrastructure failure class; canonical validation rejects it.
3. An evaluator writes multiple or contradictory verdict fields; canonical validation rejects it.
4. An evaluator edits source in its disposable worktree; the edit is discarded and never reaches the candidate branch.
5. A generator changes an undeclared source path; the scope gate fails with the exact path.
6. A contract uses an unknown file placeholder; it cannot lock and is conservatively lane-conflicting.
7. A contract explicitly declares no repository changes and changes none; it can pass.
8. A base gate fails, the generator repairs it, and the next checkpoint passes without losing the first failure evidence.
9. Two independent base gates fail; both failures reach the same repair round.
10. A required command is missing; the run reports configuration failure rather than skip.
11. An optional quality gate is absent; the run records SKIPPED and continues.
12. A passing expensive gate is reused for an identical tree and rerun after the tree changes.
13. A cleaner receives complexity and coverage failures, repairs them, and cannot pass until the tools pass.
14. A cleaner exhausts three rounds; the slice escalates with all remaining gate failures.
15. Mutation testing reports a survivor, the hardener adds a meaningful assertion, and the next mutation run kills it.
16. A critical mutant survives despite an acceptable aggregate score; the hardening stage remains failed.
17. A hardener exhausts three rounds; the slice escalates with mutation evidence intact.
18. An acceptance gate fails while unit tests pass; behavioral QA cannot pass.
19. Every in-scope behavior has a passing acceptance result linked by behavior ID.
20. A preservation scenario fails; the slice does not merge.
21. All slices pass independently but an aggregate architecture gate fails; guardians and PR creation do not run.
22. A guardian returns structured blockers; the remediator fixes them and all aggregate gates and guardians rerun.
23. Remediation remains blocked after two rounds; the run ends as a blocked ship.
24. A guardian dies or produces no canonical artifact; no remediator runs.
25. Cancellation during a deterministic command kills its process tree and preserves resumable evidence.
26. Resumption on an unchanged tree reuses passing evidence; changed policy or changed tree invalidates it.
27. A repository without a quality policy retains the existing baseline command discovery and pipeline behavior.
28. Kiro, Claude Code, and Codex providers produce identical stage transitions because orchestration is provider-independent.
29. The first candidate evaluator returns FAIL; cleaner and hardener never start, a fresh generator receives the findings, and a later candidate must pass gates before review.
30. A base or acceptance gate fails before candidate review; the generator receives the failure and no evaluator round is consumed.
31. Candidate evaluation returns PASS; only then can the cleaner start from that exact approved checkpoint.
32. A cleaner refactor changes an approved behavior; the regression bundle fails with the behavior ID and the hardener never starts.
33. A cleaner or hardener tries to edit the locked contract, acceptance manifest, or evaluator artifact; role-scope enforcement rejects the checkpoint.
34. A default-scope hardener edits a production file; role-scope enforcement rejects the checkpoint and preserves the attempted-change evidence.
35. A hardener finds a production defect through mutation evidence; AFK returns the finding to the generator instead of letting the hardener change business behavior.
36. Cleaner or hardener work changes the candidate tree; the earlier evaluator PASS cannot certify it, and a fresh final evaluator reviews the final checkpoint.
37. No post-approval writing stage changes the candidate tree; AFK reuses candidate PASS only because the tree identity is identical.
38. Final evaluation finds a cleanup regression; the responsible role can only restore approved behavior, then affected gates and final evaluation rerun.
39. Final evaluation finds that the approved behavior itself is wrong; AFK returns to generation and invalidates all downstream evidence for the old baseline.
40. Prompt assembly for the hardener excludes generator conversation, cleaner conversation, passing raw logs, and unrelated documents while preserving current mutation finding IDs.
41. A required role context exceeds its configured inline-size budget; AFK stops prompt preparation instead of truncating the contract or unresolved findings.
42. A second cleaner round starts with no prior conversation messages and receives only current unresolved cleaner findings.

### Test quality rules

- Do not test prompt wording unless it is itself a public contract.
- Test the context envelope as a public orchestration contract: included artifact classes, excluded artifact classes, ordering, stable IDs, size evidence, and fresh invocation state.
- Do not mock internal helper call sequences.
- Prefer real temporary files, git commits, executable fixtures, and parsed artifacts.
- Assert that failed evidence prevents merge and PR creation, not merely that an internal function returned false.
- Keep deterministic tools deterministic in tests; agent stubs may attempt to lie or mutate so the orchestrator's protections are actually exercised.

### Test harness constraints on Windows

The gauntlet multiplies the number of tests that spawn real processes. Three
harness rules keep that suite honest, because a flaky suite cannot gate a
slice:

- Remove fixture directories through the shared `rmDirWithRetry` helper, never a bare `rmSync`. A just-exited git child can still hold a handle, which makes teardown throw `EBUSY` and fails a passing test.
- Do not rely on the default per-test timeout for a git-heavy case. The global ceiling is generous on purpose; a suite that needs a tighter bound sets it per `describe`.
- Do not depend on test console output reaching the reporter. Passing tests run with their console output suppressed, because forwarding every pipeline log line over the reporter RPC backs up under load and fails an otherwise green run with `Timeout calling "onTaskUpdate"`. Assert against artifacts, events, and run state instead of captured stdout.
- Cover both AFK run manifest modes. A run with `afk.json` present and a legacy run without it take different scope and migration paths, so a gauntlet gate must be proven in both.

## Out of Scope

- Building language-specific CRAP, coverage, complexity, duplication, mutation, browser, or architecture-analysis tools inside AFK.
- Mandating 100% coverage or one universal mutation score for every project.
- Automatically designing module boundaries or replacing human strategic architecture decisions.
- Replacing AFK's small-slice workflow with a large persistent upfront specification.
- Forcing agents to follow human TDD mechanics when deterministic outcomes already enforce the intended value.
- Automatically correcting wrong product intent or an incorrectly scoped slice.
- Formally proving semantic equivalence beyond configured acceptance gates, deterministic regression checks, and independent evaluator judgment.
- Allowing a writing agent to expand a locked slice contract without escalation.
- A general security sandbox for untrusted agent providers, network access, or arbitrary external commands.
- Cross-run quality analytics and trend dashboards.
- The live visual pipeline dashboard; this specification only emits the structured stage evidence that such a view can consume.
- Removing existing Markdown reports, run logs, or human-readable summaries.
- Changing agent-provider model selection or authentication.

## Further Notes

- Uncle Bob's core observation is that agents are fast enough to make previously impractical quality techniques practical, but they remain sensitive to messy code. When code becomes sufficiently tangled, agents thrash just as humans do.
- The design therefore favors short prompts, focused contexts, fresh agent invocations, and deterministic tools after the fact. It does not try to encode an entire clean-code book into every generator prompt.
- Context rot means useful instructions lose practical force as the prompt accumulates history, logs, documents, and earlier decisions. More available text does not mean more reliable attention.
- "Lost in the middle" means a model can underweight critical information placed inside a long context. AFK therefore puts the current objective and boundaries first, current failures and output contract last, and excludes unrelated material.
- "Born, do the task, and die" is a context-management strategy. The cleaner, hardener, evaluator, and guardians must not inherit the generator's conversation. Each new round also starts fresh and receives only canonical unresolved state.
- Uncle Bob's described gauntlet ends with user-level QA. AFK keeps that final QA and adds candidate evaluation before cleanup because AFK already reviews each generated slice and later writing roles need an approved behavior baseline.
- The two evaluator points answer different questions. Candidate evaluation asks whether the generator built the right behavior. Final evaluation asks whether later quality work preserved that approved behavior.
- "Do not change business logic" is not trusted as prompt text alone. Locked artifacts, role write scopes, regression gates, exact-tree evidence, and final evaluation enforce that boundary together.
- Deterministic gates create repair loops: change the candidate, run the tool, consume concrete failures, and repeat until the tool passes or the bounded stage exhausts.
- Quality costs time. Uncle Bob's reported example increased a questionable five-minute agent task to roughly an hour, still around four to five times faster than a human half-day. AFK must expose equivalent timing rather than pretending quality is free.
- Human values should be imposed; human rituals need not be. Cleanliness, coverage, test strength, observable behavior, modularity, and architecture are required outcomes. The exact sequence of edits an agent uses to reach them is not.
- Heavy upfront plan generation is deliberately rejected. AFK should continue processing one or two small slices, collecting feedback, and reorganizing when actual code reveals what the initial plan missed.
- The final implementation and executable evidence are more authoritative than decorative planning prose. Slice contracts remain concise working artifacts, not attempts to describe the whole system forever.
- Architecture policy is deterministic only after a human defines it. The system may enforce permitted dependencies, forbidden imports, module cycles, or interface rules, but the lead engineer remains responsible for choosing those rules.
- This specification is expected to produce multiple implementation issues. Its ordering is part of the decision: evidence integrity and orchestrator-owned baseline gates come before adding more agent roles.
- Relevant existing decisions include orchestrator ownership of contract status, evaluator QA using the sanity command set, deterministic/shared-preview QA separation, guardian review failure classes, per-run evidence directories, per-slice state persistence, invocation bounds, cancellation, lane continuation, lane-shared resources, contract-lock gates, MERGE-PENDING, and blocked-ship semantics.
- Two decisions landed after this specification was written and change where gauntlet code belongs. Read both before planning a slice that touches shipping, scope, or migrations:
  - ADR 0033 (ship gate extraction): `preship.ts` owns sanity command discovery and `runPreShipSanity`; `migration-gate.ts` owns `verifyMigrationSync` and `sliceTouchedMigrations`; `ship-gate.ts` owns the post-wave shipping decision through one `runShipGate` interface. `classifyReviewFailure` stays in `artifacts.ts`.
  - ADR 0034 (AFK manifest and migration claims): `afk.json` is the pipeline's first config file, and the pipeline allocates migration prefixes from its pool. Agents never calculate a migration prefix; they receive an exact claim.
