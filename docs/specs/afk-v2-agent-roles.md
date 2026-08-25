# AFK v2 — Agent role redesign

Session decisions, 2026-08-24. This document records the review of every
agent step in the AFK flow (post-gauntlet), the decisions made, and the
suggested prompt skeletons. It refines and amends
`docs/specs/afk-deterministic-quality-gauntlet.md` (the parent spec).
Where the two disagree, this document wins.

Evidence that motivated the review, from run
`afk-deterministic-quality-gauntlet-codex/run-20260824-174249`:

1. A generator round ran 15 minutes and committed only a docs file while
   two QA findings sat open. Root cause: the prompt made the generator's
   exit state a self-assessed claim ("tests green") and simultaneously
   forbade running the full suite — the only open finding was
   "full suite non-green". The agent was accountable for a fact it was
   banned from measuring.
2. A finding whose fix sat outside the locked file list deadlocked the
   slice twice (STUCK). The generator had no legal move: edit out of
   scope (QA flags it) or stall (round expires). No escalation channel
   existed.

## Guiding principle

Agents choose and interpret; code counts and compares. Every time an
agent counts, compares, or certifies, that is a gate waiting to exist.
Prompts stay one screen: objective, write boundary, stop condition
first; unresolved evidence and output contract last; nothing else.

---

## Cross-cutting mechanisms

### M1. Two artifacts per slice: judged and executed

- `contract.md` — the judged artifact. Prose. Readers: contract
  evaluator, generator, candidate evaluator, babysit agent. Contains
  scope intent, non-goals, preservation intent, citations. No parser
  touches it.
- The acceptance manifest — the executed artifact. Structured,
  versioned, schema-validated. Contains: behaviors (stable behavior ID,
  source citation, Given/When/Then, observable result, preservation
  flag, one or more configured gate IDs), the declared file scope, and
  the migration count. Every field the orchestrator parses lives here.
  Prose parsing for control flow is removed.
- Consistency is a deterministic lock check: every in-scope contract
  behavior appears in the manifest with at least one gate ID.

### M2. The behavior-ID thread and the coverage gate

One string joins obligation, proof, and evidence:

1. Policy declares gate `acceptance:behaviors` with a command like
   `pnpm vitest run --testNamePattern {{BEHAVIOR_ID}}`.
2. The planner binds each behavior ID to that gate in the manifest.
3. The generator names at least one test with the behavior ID.
4. AFK code runs the gate per behavior ID and checks two facts: at
   least one test matched (zero matches = FAIL, behavior untested) and
   the matched tests exit 0.

The planner defines deterministic obligations. It never writes commands
(agent-generated shell text stays banned). An untested behavior is a
mechanical failure naming its ID, not an evaluator observation.

### M3. One finding schema for every judge

All judging roles (contract evaluator, candidate evaluator, final
evaluator, guardians) emit findings with the same shape:

- ID, severity, behavior IDs touched, evidence, expected (quoted),
  observed, and a **clear-condition** — the observable change that
  resolves the finding. "Needs more tests" is not a finding;
  "no test covers empty input on B-03" is.
- Finding states: OPEN, RESOLVED, CONTESTED, WITHDRAWN. Code tracks
  states, counts findings, and detects re-raises. Agents never count
  their own findings and never reconcile prior reports.
- Clear-conditions bind their author: when the condition is met, the
  finding is RESOLVED — the judge may not restate the same objection in
  new words.
- Verdicts live in canonical structured artifacts, schema-validated,
  fail-closed. A favorable verdict cannot coexist with a blocking
  finding. Marker-line parsing (`VERDICT:`, `**Verdict:**`) is removed
  from control flow.

### M4. One escalation mechanism, five consumers

A structured `escalation.md` (schema-validated) written by a writing
role when it cannot proceed legally. Consumers:

1. Generator — a correct fix requires a path outside the declared file
   scope. Routes to contract revision.
2. Cleaner — the approved behavior itself is wrong. Routes to the
   generator loop; downstream evidence is invalidated.
3. Hardener — a surviving mutant exposes a production defect. Routes to
   the generator loop.
4. Negotiation — a CONTESTED finding held after max rounds is an
   impasse. Routes to the human.
5. Remediator — a fix needs a path outside the run's diff. Terminates
   the run as a blocked ship with the explanation attached.

Routing model: the parked slice becomes blocked on an external
dependency. Human decisions arrive as `adjudication.md` in the slice
directory (schema-validated: finding ID, winning position or third
instruction, author). When the file appears, the slice is dispatchable
again like any slice whose dependencies completed. The wait is bounded;
after timeout the slice parks permanently and the next run resumes it.
The human decision resolves a finding, not the contract: one mechanical
apply-and-lock step runs before the generator starts.

The babysit agent is the courier, not the judge: it watches for impasse
artifacts, presents the contested question verbatim (both positions,
both evidences, no summary bias), and writes the validated
`adjudication.md`. It does not vote.

### M5. Context envelopes

- Envelope order: objective, write boundary, stop condition first;
  small supporting context in the middle; unresolved evidence and
  output contract last.
- Every round is a fresh invocation. No prior conversation, no other
  role's conversation, no resolved findings, no passing raw logs.
- Two templates per role: initial and revision/repair. Situation
  variants (resume, resume-stuck) become data blocks in the repair
  template, not separate templates.
- Large logs and documents pass as artifact references plus a short
  canonical summary, never inline.
- Size budgets fail closed: over-budget required content stops prompt
  preparation; nothing is silently truncated.
- Explorer output is selected by *section*, not by per-item role tags.

### M6. Test cost policy

- Two test gates: `test:related` (required, every checkpoint) and
  `test:full` (required, final checkpoint before merge, plus the
  aggregate pre-ship gate).
- Tree-identity caching: a green gate result on an identical tree is
  never re-paid.
- Gate prerequisites: expensive gates (coverage, mutation) declare
  prerequisites on cheap ones (typecheck), so no suite runs on a tree
  that does not compile. Independent failures are still collected
  together for one repair round.
- Mutation scope is the slice's changed files. Whole-repository or
  critical-module mutation, if ever wanted, is a separately configured
  aggregate gate.

### M7. Reviewer isolation is mechanical

- Evaluators and guardians inspect detached disposable worktrees at an
  exact checkpoint. Any edit there is discarded; only allowlisted
  review artifacts are copied back.
- **Probe-as-evidence:** a reviewer may write and run a test in its
  disposable worktree; the file is discarded, the code and observed
  result travel inside the finding as evidence. The generator commits
  an adapted version under its own authority. The clear-condition is
  "behavior case covered", never "commit my code". One writer per
  branch, always.
- `handoff.md` is excluded from all reviewer inputs: judge the tree,
  not the author's story.

---

## Per-role decisions

### 1. Explorer

**Owns:** which repository facts, and which unknowns, the planner gets
to see for one slice.

Decisions:

- Output is one `context.md` evidence map with **four sections**: files
  and current behavior (with the preservation catalog); patterns and
  test harness (with **blast radius** — the harness and config files
  changes in this area typically drag in); data and integration
  (optional); unknowns.
- **Citation rule** (one sentence): a statement with a citation is
  `FACT`; without one it is `INFERENCE`; a question is `UNKNOWN`.
- No per-item role tags. Downstream roles receive sections: planner
  gets all; generator gets patterns and harness; evaluators get
  behavior and preservation.
- No re-exploration loop. Replaced by three rules: the planner may do
  targeted reads to resolve a named UNKNOWN (citing what it reads); a
  blocking UNKNOWN at lock time fails the lock; the explorer always
  runs at slice start against the current base (lane sequencing already
  guarantees freshness).
- No escalation section: the explorer labels, the planner carries, the
  contract evaluator refuses.
- Drop the persona line; the objective sentence does the job.
- Spec table amendment: explorer evidence enters the include lists of
  the generator, candidate evaluator, and contract evaluator (as
  sections), which the parent spec's role table omits.

Prompt skeleton:

```markdown
# Objective
Convert the repository into a compact, cited evidence map for this
slice. You do not refine intent, choose a design, or lock scope.

# Write boundary
Write only {{SLICE_DIR}}/context.md.

# Citation rule
A statement with a file/symbol/command citation is FACT. Without one it
is INFERENCE. A question is UNKNOWN. Label every statement.

# Task — four sections
1. Files and current behavior — relevant files/symbols; for any file
   this slice may touch, what currently works that must keep working.
2. Patterns and test harness — conventions, test commands, and blast
   radius: harness/config files changes in this area typically drag in.
3. Data and integration (omit if not applicable).
4. Unknowns — what you could not confirm; questions the planner must
   resolve before lock.

Slice: GH issue #{{GH_ISSUE}} — "{{TITLE}}"
{{SLICE_BODY}}

# Budget
{{SIZE_BUDGET}}
```

### 2. Planner

**Owns:** what "done" means for one slice — which behaviors, proved by
which executable scenarios, inside which declared files.

Decisions:

- Produces **two artifacts**: `contract.md` (judged prose) and the
  acceptance manifest (executed structure — behaviors with IDs,
  citations, Given/When/Then, observable result, preservation flag,
  gate IDs from the configured catalog; file scope; migration count).
- **Delete the DoD boilerplate** — "All tests pass locally", "No
  regression in existing suite", "Evaluator has signed off". These are
  orchestrator gates, uniform across slices. Embedding whole-repository
  criteria in a scoped contract caused the observed deadlock class. The
  DoD carries scope-local criteria only.
- **Three-way scope rule** replaces `<unknown>`: concrete paths, or the
  explicit "No repository files change" declaration, or resolve the
  unknown with a targeted read before proposing. Undeclared scope
  cannot lock and conflicts with every lane sibling.
- File scope is reframed: "this list is the generator's entire write
  boundary, mechanically enforced — include the blast-radius files from
  the explorer's harness section."
- Keep: NEGOTIATING status invariant (orchestrator owns LOCKED, ADR
  0008), non-goals before in-scope, preservation as default,
  rewrite-in-place (no negotiation transcript), citation principle,
  migration reservation handling.
- Drop the "grep for docs/adr/" instruction: the explorer cites; the
  planner reads what is cited.
- Revision template (rounds 2+): receives open findings with
  clear-conditions; revises only affected sections; may answer a
  finding with CONTESTED plus evidence instead of complying.

### 3. Contract evaluator

**Owns:** whether the proposed contract and manifest become binding —
honest, falsifiable, and deliverable against the repository as it is.

Decisions:

- A **deterministic lock gate runs first**, before the evaluator is
  invoked: manifest schema, behavior coverage, gate-ID existence,
  contract-manifest consistency, concrete scope. A failure there
  returns to the planner **without consuming an evaluator round** (the
  ADR 0028 pattern).
- The evaluator keeps only judgment: would a green result on the bound
  gate convince you the behavior exists? Is the scenario set honest?
  Single-session feasibility. At least one non-goal.
- **Reality check added:** inputs gain the manifest, the gate catalog,
  and the explorer's evidence sections. Two rejection rules: file scope
  unsupported by evidence (including missing blast-radius files), and
  any blocking UNKNOWN neither resolved nor declared irrelevant.
- Every REVISE finding carries a clear-condition. The evaluator is
  bound by it (M3).
- The planner may CONTEST; the evaluator withdraws or holds. A held
  finding at round exhaustion is an **impasse** routed to the human
  (M4). Two exhaustion shapes are distinguished in the artifact:
  impasse (adjudicate the point) and non-convergence (fix the ticket).
- Round 2+ scope rule: judge only whether conditions are met; a new
  finding must cite text the revision changed. A gap missed in round 1
  locks — accepted trade; the downstream net (base gates, acceptance
  gates, candidate evaluator, scope gate) still exists.
- `GAPS:` and `RE_RAISED_GAPS:` self-counts are removed; code counts.
- Verdict becomes a canonical structured artifact.
- Max rounds stays 2. Contract escalation is the cheapest escalation in
  the flow — no generator tokens were spent. Park early; the tie-breaker
  works.

### 4. Generator

**Owns:** given the locked contract and the current failure set, what
code change to make inside the declared file scope — nothing else.

Decisions:

- Exit state is a committed candidate checkpoint. Gates decide
  everything else. No self-certification anywhere: no "when all
  behaviors are green", no handoff status claims.
- Coverage obligation stated as fact: "the acceptance gate runs per
  behavior ID; a behavior with no tagged test fails." This replaces the
  TDD ritual section entirely.
- **Escalation channel** (M4): a fix outside the declared files is
  never the generator's to make — escalate, do not edit, do not stall.
- Repair input is the orchestrator-computed unresolved set: finding IDs
  with clear-conditions plus gate failures with gate IDs, one uniform
  block, last in the prompt.
- Dead content: TDD ritual, five-point reasoning protocol, streaming
  invariant (busy probe, ADR 0021), LOCKED status check (orchestrator
  guarantees it), craft principles (cleaner owns quality), sibling
  handoffs and ADR grep (moved upstream), "state facts not judgments".
- Kept: `{{TEST_COMMAND}}` verbatim for local runs (drift wastes the
  generator's own time), migration assignment verbatim.
- **Two templates**: initial and repair. Resume is a repair round with a
  commit-log situation block. `generator-resume-stuck.md` is deleted;
  its one good idea — "fix causes, not the listed examples" — moves
  into every repair round.
- `generator-stuck.md` (the stuck-diagnosis agent) is deleted: the
  stuck diagnosis is assembled deterministically by code from archived
  findings, escalations, and gate results. No best-guess synthesis; the
  human adjudicates from evidence.
- `handoff.md` has three sections — what shipped (behavior ID → file
  and symbol), decisions (choices the contract left open, one line of
  rationale), gotchas ("for the slices that build on this", not "the
  next planner"). Excluded from all reviewer inputs (M7).

Prompt skeleton (the full prompt, not an excerpt):

```markdown
# Objective
Implement the locked contract for this slice: every behavior in the
acceptance manifest, inside the declared file scope, committed.

# Write boundary
You may change only these files:
{{FILE_SCOPE}}

{{MIGRATION_RESERVATION}}

The scope gate rejects any checkpoint that touches other paths, and
lists them exactly. If a correct fix requires a path outside this list,
write `{{SLICE_DIR}}/escalation.md` and stop — the pipeline routes it
to contract revision. Never edit the contract, the manifest, or review
artifacts.

# Task
1. Read `{{SLICE_DIR}}/contract.md`, the acceptance manifest, and the
   ADRs the contract cites.
2. Implement each manifest behavior. Name at least one test with its
   behavior ID — the acceptance gate runs per ID, and an ID with no
   matching test fails.
3. Behaviors in touched files keep working unless the contract
   authorizes the change.
4. Verify locally with `{{TEST_COMMAND}}`. Commit per behavior
   (conventional commits, reference the GH issue).
5. Write `{{SLICE_DIR}}/handoff.md`: what shipped (behavior ID → file
   and symbol), decisions made, gotchas for the slices that build on
   this. No status claims — gates report status.

# Patterns and harness
{{EXPLORER_SECTION}}

# Current failure set
{{FAILURE_SET}}
```

Repair template: same skeleton, failure set populated, plus "fix
causes, not the listed examples" and the commit-log block when the
round resumes prior work.

### 5. Candidate behavioral evaluator (new role)

**Owns:** given a checkpoint that already passed every base and
acceptance gate, whether the generated behavior is *right*.

Decisions:

- Never runs the suite; gate evidence is supplied. A red suite never
  reaches this agent (a failed base gate returns to the generator
  without consuming an evaluator round).
- Judges **four questions**: intent (does each behavior do what the
  contract means, not merely what its scenario encodes); boundaries
  (edge cases the manifest missed); preservation (anything lost nobody
  listed); **test honesty and sufficiency** (would the tagged tests
  fail if the behavior were wrong; do the tests per behavior
  collectively pin it down). Sufficiency is judged against the
  contract's behaviors, not an imagined ideal; a sufficiency finding
  names the concrete missing case as its clear-condition.
- Quality/craft review is removed (cleaner owns it). Failure-class
  trichotomy shrinks (the gate runner owns command-level infrastructure
  evidence).
- Probe-as-evidence (M7): may write and run tests in the disposable
  worktree as finding evidence; never authors into the branch.
- PASS establishes the **approved behavior baseline** (checkpoint +
  locked contract + manifest + gate evidence). Cleaner and hardener
  cannot start before it exists.
- Three rounds; FAIL routes findings to a fresh generator round.
- Shared-preview UAT (ADR 0014) is explicitly out of scope of this
  role's redesign; it stays a separate assigned scope until acceptance
  gates can target a preview URL.

Prompt skeleton:

```markdown
# Objective
Decide whether the generated behavior is correct. Every deterministic
gate already passed — that evidence is attached, do not re-run it.
You judge what gates cannot: intent, boundaries, preservation, and
whether the tests honestly and sufficiently prove their behavior IDs.

# Isolation
You are in a disposable review worktree at checkpoint {{CHECKPOINT_ID}}.
Any file you change is discarded. Write only the review artifact.
You may run ad-hoc probes (a CLI call, an edge-case input, a probe
test); their results are your evidence, not gate results.

# Judge four questions
1. Intent: does each behavior do what the contract means, not merely
   what its scenario encodes?
2. Boundaries: error paths, edge cases, misuse the manifest missed.
3. Preservation: does anything in the touched area stop working that
   nobody listed?
4. Tests: would each behavior's tagged tests fail if the behavior were
   wrong — and do they collectively pin the behavior down? Name the
   concrete missing case in any sufficiency finding.

# Prior unresolved findings
{{UNRESOLVED_FINDINGS}}

# Output
The canonical review artifact: one verdict; findings with ID, severity,
behavior IDs, evidence, expected (quoted), observed, and a
clear-condition each. PASS with a blocking finding is invalid — code
rejects the artifact.
```

### 6. Cleaner (new role)

**Owns:** how to restructure code inside its write scope so the
measured quality gates pass, without changing the approved behavior
baseline.

Decisions:

- Thinnest prompt in the flow; the tools carry the content. No quality
  lecture.
- Default write scope: the slice's declared files plus their test
  files. Widening is a per-project policy choice.
- **No-new-suppressions gate** (deterministic): the diff may not add
  suppression directives, threshold edits, or delete tests.
- Two anti-gaming lines adopted into the prompt: avoid abstractions
  that only move code without reducing complexity; prefer deep modules
  with small interfaces.
- On regression, exactly two legal moves: restore the behavior or
  revert the refactor. Never adjust an expectation.
- Escalation (M4) when the approved behavior itself is wrong.
- No handoff artifact; commit messages carry rationale; exhaustion
  evidence is assembled by code.
- Three rounds, fresh each, all independent failures delivered
  together.
- A recommended starter quality policy ships as a template (see action
  items): format, lint, typecheck, changed-code coverage, complexity
  and CRAP thresholds, duplication, architecture rules — each a named
  gate with required/optional status, expensive checks scoped to
  changed modules.

Prompt skeleton:

```markdown
# Objective
Make the failed quality gates below pass, without changing approved
behavior (baseline {{BASELINE_ID}}).

# Write boundary
You may change only: {{CLEANER_SCOPE}}
Never the contract, manifest, or review artifacts. The scope gate
rejects violations; the regression bundle reruns after your commit.

# Rules
1. If a repair requires changing external behavior, write
   `{{SLICE_DIR}}/escalation.md` and stop.
2. If a regression gate goes red, restore the behavior or revert your
   refactor. Never adjust the expectation.
3. A silenced gate is not a repaired gate: no new suppression
   directives, no threshold edits, no deleted tests.
4. Avoid abstractions that only move code without reducing complexity.
   Prefer deep modules with small interfaces.

# Current failure set
{{QUALITY_FAILURES}}
```

### 7. Hardener (new role)

**Owns:** which assertions to add or strengthen so the surviving
mutants die — without touching production code or approved behavior.

Decisions:

- Mutation scope is the slice's changed files (M6). Per-slice mutation
  is minutes, not overnight.
- Write scope: tests and test-support files only, mechanically
  enforced. Production defects found via mutants are escalated to the
  generator (M4), never fixed here.
- **Justified-exclusion pairing** (replaces an absolute ban, because
  equivalent mutants exist): the suppression gate allows a new mutant
  exclusion only when the same commit adds a justification entry naming
  the mutant. Exclusion without justification fails the gate.
- Survivor report convention (project-owned adapter script, normalized
  JSON): file, line, mutation operator, status, severity
  (critical/normal), covering tests; behavior-ID mapping optional.
  A critical survivor blocks regardless of aggregate score.
- Three technique-matching lines in the prompt; proactive hardening
  without gate evidence is rejected (no gate defines "done" for it —
  the stop condition would dissolve into judgment).
- Brittle-but-killing assertions have no deterministic catch and no
  downstream judge: accepted residual risk, one prompt rule against it.
- Three rounds; mutation gate + regression bundle rerun per checkpoint;
  exhaustion escalates with full survivor evidence preserved.

Prompt skeleton:

```markdown
# Objective
Strengthen tests so the surviving mutants below are killed. Approved
behavior (baseline {{BASELINE_ID}}) stays unchanged.

# Write boundary
Tests and test-support files only: {{HARDENER_SCOPE}}
The scope gate rejects any production-file change. Never the contract,
manifest, or review artifacts.

# Rules
1. Kill a mutant by asserting observable behavior, not internal
   representation.
2. Never exclude, disable, or configure a mutant away without a
   justification entry naming it — the suppression gate checks the
   pairing. A silenced mutant is not a killed mutant.
3. If a survivor exposes a real production defect, write
   `{{SLICE_DIR}}/escalation.md` naming the defect, and stop.
   Production fixes are the generator's job.
4. Pick the technique that fits the code: a property test for a
   business-rule invariant, a boundary test for edge conditions, a
   transition test for a state machine.

# Surviving mutants
{{MUTATION_EVIDENCE}}
```

### 8. Final behavioral evaluator (new role)

**Owns:** whether the final tree still delivers the approved behavior
baseline, after cleaner and hardener edits changed it.

Decisions:

- Often never runs: exact-tree reuse of the candidate PASS when no
  post-approval writer changed the tree. Pay-per-use second judgment.
- Judges **two questions**, not four: preservation, and gate-invisible
  behavior drift. Intent and sufficiency were judged at candidate time
  against an unchanged contract; re-judging would re-litigate an
  approved decision.
- Key input is the code-generated **change summary**: the orchestrator
  diffs the candidate-approved checkpoint against the final checkpoint,
  per post-approval role (commits, files, diff stats).
- Finding routing is code's job: the evaluator states the behavioral
  fact with evidence; the orchestrator attributes it to the
  post-approval role whose diff touched the implicated code. Restore is
  that role's only legal move. A baseline-is-wrong finding routes to
  the generator loop and invalidates downstream evidence.
- Three attempts; each repair produces a new checkpoint and reruns
  affected gates before another review. After PASS: file-scope gate,
  then merge through the existing mutex.

Prompt skeleton:

```markdown
# Objective
Decide whether the final tree still delivers approved baseline
{{BASELINE_ID}}. The tree changed after approval; every deterministic
gate already passed on this final checkpoint — evidence attached,
do not re-run it.

# Isolation
Disposable worktree at {{CHECKPOINT_ID}}. Edits are discarded. Write
only the review artifact. Probes allowed; their results are evidence.

# Judge two questions
1. Preservation: does every approved behavior still work as approved?
2. Drift: did post-approval edits change any external behavior, error
   path, or affordance the gates cannot see?

# What changed since approval
{{CHANGE_SUMMARY}}

# Prior unresolved findings
{{UNRESOLVED_FINDINGS}}

# Output
Canonical review artifact. Findings carry behavior IDs, evidence, and
a clear-condition each. No maintainability or mutation commentary.
```

### 9–10. Architect and PM guardians (reshaped)

**Own:** architect — whether the integrated feature branch is
structurally sound *as a whole* (how slices compose); PM — whether the
delivered behaviors compose into the user outcome the PRD promised,
within the run scope.

Decisions:

- **Notes-first.** ACCEPT-WITH-NOTES is the expected normal outcome.
  FIX-BEFORE-SHIP is reserved for one class: a citable violation of a
  standing document (an ADR contradicted, a PRODUCT.md invariant
  broken, a promised-and-selected outcome absent). "The PRD should
  change" is a note for the human, never a blocker.
- **Blocking power requires the governing doc.** No `ARCHITECTURE.md`,
  no architect blockers: the guardian degrades to notes-only or is
  skipped. Power comes from configured, citable ground truth.
- **The artifact is written for the human**, in attention-control
  style: verdict first, blockers before notes, action-first sentences,
  one meaning per word. It is the human's PR-review digest; feeding the
  remediator is secondary.
- **No CEO guardian.** Business judgment ("is this worth building")
  belongs before the run, at grilling and PRD approval. A
  post-implementation business finding has no actionable output class.
- Isolation becomes mechanical (M7): the independence paragraph in both
  prompts ("the other guardian's finding is not evidence") shrinks to a
  property of the filesystem — the other guardian's artifact is not in
  the disposable worktree.
- The heredoc write ritual and `cat | head -5` verification die
  (ADR 0029 workaround); schema validation plus orchestrator copy-back
  replace them. The `**Verdict:**` marker becomes a canonical artifact.
- Both gain aggregate gate evidence as input: the architect receives
  architecture-rule results (judging what rules cannot encode, not
  re-checking what code proves); the PM receives per-slice acceptance
  evidence (judging whether green behaviors add up to the promised
  experience).
- Trimmed overlap: per-slice concerns ("missing error handling") belong
  to the candidate evaluator; no second pass here.
- Kept: proportional response, "evaluate what ships", cite the
  convention, PM run-scope with out-of-scope gaps recorded but never
  driving the verdict, "edge cases are product decisions".
- Guardian rerun after remediation uses the revision-template rule:
  prior blockers plus a change summary; a new blocker must cite
  remediation-changed code.

Architect skeleton (PM differs in lens and inputs):

```markdown
# Objective
Judge the integrated feature branch as a whole: does the composition of
these slices create structural pain at scale — coupling, abstraction
leaks, drift across slices? Per-slice review already happened; judge
what no per-slice role could see.

# Isolation
Disposable worktree at aggregate checkpoint {{CHECKPOINT_ID}}. Edits
discarded. Write only the review artifact.

# Evidence supplied — do not re-run
{{AGGREGATE_GATE_EVIDENCE}}

# Ground rules
1. Cite the governing document for every finding (ARCHITECTURE.md,
   CONVENTIONS.md, an ADR). No governing document, no blocker.
2. Proportional response: a three-slice button PRD is not a new data
   model.
3. A blocking finding carries your own evidence: file, location, what
   you read or ran.
4. Write the artifact for the human: verdict first, blockers before
   notes, action-first sentences.

# Run scope
{{RUN_SCOPE}}

# Output
Canonical review artifact: one verdict, findings with ID, severity,
evidence, clear-condition. FIX-BEFORE-SHIP findings go verbatim to a
remediation agent — write them so a stranger can act on them.
```

### 11. Remediator (new role, kept in scope)

**Owns:** how to change the merged feature branch so each cited
blocker's clear-condition is met, without breaking anything the run
already proved.

Decisions:

- A generator-shaped role at aggregate scope. Its failure set is the
  guardian blockers — after the reshape, only citable standing-document
  violations with ID, evidence, and clear-condition.
- Default write scope: the files this run changed on the feature
  branch. Policy may widen. An out-of-scope fix escalates and
  terminates the run as a blocked ship with the explanation attached
  (there is no contract to revise at aggregate level).
- Input is blockers only. Notes and favorable findings never reach it
  (anti-scope-creep).
- Two rounds, fresh each; all aggregate gates and both guardians rerun
  per round (guardians under the revision-template rule). Still blocked
  after round two: blocked ship, PM override preserved.
- **Second trigger — aggregate gate failure.** The remediator is also
  invoked when the merged feature branch fails the aggregate gates
  (pre-ship sanity, aggregate architecture gates), before the guardians
  run. Today that failure is an unrepairable blocked ship; post-v2 it
  becomes one bounded repair loop with the gate failures as the blocker
  set. Semantic integration breakage — every slice green alone, the
  combination red — is exactly this trigger.
- **No dedicated merge-conflict agent.** Slices merge incrementally
  through the merge mutex, not in one end-of-run step. Lanes serialize
  overlapping scopes, lane successors build on the refreshed base, and
  the v2 scope gate makes actual changes match disjoint declarations —
  so textual conflicts between passing slices are structurally near
  impossible. A real git CONFLICT means a scope declaration lied;
  it stays a human escalation (the `resolving-merge-conflicts` skill is
  the babysitter's tool for that rare case), and MERGE-PENDING keeps
  handling the mechanical migration-prefix retry.

Prompt skeleton:

```markdown
# Objective
Repair the cited blockers on the merged feature branch. Each blocker
is a violation of a governing document; its clear-condition defines
"repaired".

# Write boundary
Files this run changed: {{REMEDIATION_SCOPE}}
Never contracts, manifests, or review artifacts. If a correct fix
needs a path outside this scope, write `escalation.md` and stop —
the run ends as a blocked ship with your explanation attached.

# Rules
1. Fix only the cited blockers. Notes and favorable findings are not
   your input; improve nothing else.
2. The aggregate gates and both guardians rerun after your commit —
   do not undo what the run already proved.
3. Commit per blocker, referencing its finding ID.

# Blockers
{{BLOCKERS}}
```

---

## Rejected or deferred

- **Re-exploration loop** — rejected. Covered by planner targeted
  reads, contract-evaluator refusal, and slice-start freshness. Revisit
  only if prompt-size evidence shows planners burning context on
  repository search.
- **Per-item role tags in explorer output** — rejected in favor of
  section-level selection.
- **Declarative external-seam acceptance runner** — deferred until run
  evidence shows the gap (behaviors at CLI/API seams currently proven
  via tagged tests).
- **Preservation attribution gates** — deferred; the full-suite gate
  already catches regressions, attribution only improves the message.
- **Proactive hardening (property/fuzz/differential without gate
  evidence)** — rejected as a hardener duty; available as optional
  configured gates.
- **CEO guardian** — rejected; business judgment happens before the
  run.
- **Evaluator-authored tests entering the branch** — rejected;
  probe-as-evidence instead.
- **Generator self-certification, agent-counted metadata
  (`GAPS:`), marker-line verdicts, heredoc write rituals** — removed by
  design.
- **Cleaner/hardener/final-evaluator and remediator** — in scope
  (user decision), with per-stage time and round evidence collected so
  ROI can be evaluated after real runs.

## Action items

1. Move the `babysit-afk` skill from
   `C:\Code\rumo-app\.agents\skills\babysit-afk` into this repo; install
   globally; add the impasse-courier duties (watch for impasse
   artifacts, present the contested question verbatim, write validated
   `adjudication.md`; carry the message, do not vote).
2. Ship a starter quality-policy template (`templates/`): format, lint,
   typecheck, changed-code coverage, complexity and CRAP thresholds,
   duplication, architecture rules — named gates with required/optional
   status; expensive checks scoped to changed modules; mutation tools
   listed (Stryker, PIT, Infection, Mutmut) as project choices.
3. Guardian review artifacts adopt attention-control style.
4. After the live run ends, profile the test suite
   (`pnpm vitest run --reporter=verbose`, per-file durations); then
   decide fixture reuse against test demotion with data. Implement the
   `test:related` / `test:full` split.
5. Amend the parent spec's section 6 role table: explorer evidence
   sections enter the generator, candidate evaluator, and contract
   evaluator include lists.

## Open points

- Shared-preview UAT stays outside the candidate evaluator redesign
  until acceptance gates can target a preview URL.
- Brittle-assertion residual risk in the hardener: accepted.
- Behavior-ID → survivor mapping in mutation reports: optional,
  best-effort.
- Wave scheduler dynamics (dynamic dispatch against static waves)
  decide the adjudication-injection implementation cost; check
  `src/wave.ts` before designing the routing slice.
