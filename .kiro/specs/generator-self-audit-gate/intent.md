# Generator self-audit gate

## Intent

Force the generator to look at its own finished candidate twice before AFK
spends a QA round on it, using a mechanism instead of prompt prose, and
measure whether that second look catches real defects.

The idea is ported from SwarmForge's two-call audit gate
(github.com/unclebob/swarm-forge, `swarm_handoff.sh`): the first handoff
submission is always refused with an audit challenge; the handoff queues only
when the sender resubmits the unchanged candidate. A changed resubmission
proves the audit caught something. The audit is falsifiable and cannot be
skipped, because it is a protocol step, not an instruction.

AFK's current equivalent is the "# Self-audit before commit" section in
`prompts/generator.md` and `prompts/generator-repair.md` — prose the generator
can skip, with no record of whether it ever catches anything. That violates
AFK's own enforcement rule: deterministic gates are the enforcement channel;
prompts carry only obligations no gate can enforce. Self-audit can be a gate.

## Evidence

- The slop-guard self-audit sections exist in both generator prompt templates
  today, unmeasured and unenforceable. No run record can say whether they have
  ever prevented a defect.
- A QA evaluator round is the expensive unit the gate would save: the gate
  cache measured ~13 minutes saved per avoided QA round, and change-summary
  work measured 22.7–30.3 minutes of evaluator re-reading per round
  (docs/specs/afk-v2-plan.md, items 5 and 9).
- Agents are least reliable at the moment they declare done. PRD 1's record —
  3 of 5 slices needing human hands, and #120's generator driving 8 commits
  "to green" over code that did not compile — shows the declare-done moment is
  where defects pass unchallenged.
- SwarmForge's cumulative audit counter demonstrates the mechanism is
  self-measuring: a challenge-caught-something rate is recordable per
  candidate and decides the feature's own future by evidence.

## Decision

Because AFK's generator is an ephemeral invocation rather than a persistent
session, the port is a bounded post-generation audit invocation, not an
in-session refusal:

1. The audit pass sits between the candidate gate phase and QA dispatch: it
   runs only for a candidate that has already passed its required cheap gates
   and is about to be submitted to the QA evaluator. Candidates that fail
   cheap gates return to repair without an audit.
2. The audit is one re-dispatch of the slice's generator in its own worktree
   with an audit envelope: the locked contract pair, the candidate's
   handoff.md, the candidate's change summary, and the audit obligations —
   re-read the contract, trace every done-criterion to code and to test
   evidence, examine boundaries and failure cases; passing checks alone do not
   establish completeness. The envelope instructs: commit fixes if the audit
   finds a gap, otherwise change nothing.
3. The verdict is structural, never agent-certified: the orchestrator compares
   the exact git tree object before and after the audit invocation.
   - Identical tree → outcome `AUDIT_UNCHANGED`; proceed to QA.
   - Different tree → outcome `AUDIT_CHANGED`; the new tree re-runs the
     required cheap gates, then proceeds to QA. A cheap-gate failure on the
     audited tree enters the existing repair loop as usual.
4. Exactly one audit invocation per QA submission. No audit-of-the-audit: a
   changed tree is not re-challenged. Bounded by construction.
5. The audit invocation is not a generator round. It cannot exhaust the
   generator's round budget, and it is classified and retried under the
   existing agent-failure taxonomy; an audit invocation that dies is recorded
   `AUDIT_NOT_RUN` and the candidate proceeds to QA — the gate can only add
   scrutiny, never block a run by its own failure.
6. Outcomes are recorded per candidate in run state and totalled in
   run-summary.md (`AUDIT_UNCHANGED` / `AUDIT_CHANGED` / `AUDIT_NOT_RUN`).
   The rate reports and never gates — same posture as environment-sensitive
   measurements (ADR 0063).
7. The feature ships behind `--self-audit`, default off (new machinery
   defaults off). The default-on decision is taken later, on the recorded
   `AUDIT_CHANGED` rate against the added invocation cost, and is out of scope
   here.
8. When the gate is on, the prompt-prose self-audit section is superseded for
   dispatch paths that use the gate; the prose remains for the off path until
   the default-on decision retires it.

## Scope

- The audit envelope manifest in the context-envelope layer, with the standard
  budget and stricter-only overrides.
- Orchestrator sequencing: audit dispatch after candidate gates, tree
  comparison, cheap-gate re-run on a changed tree, QA dispatch.
- Run-state and run-summary recording of audit outcomes with run-ID
  provenance; resume treats a completed audit as spent.
- The `--self-audit` flag and its plumbing.
- An ADR recording the mechanism, its SwarmForge provenance, and the
  one-invocation bound.

## Out of scope

- Auditing planner, evaluator, explorer, or guardian outputs.
- Any gate or merge decision keyed on the audit rate (report only).
- The default-on decision and prose-retirement.
- A second audit challenge for changed trees.
- In-session (provider hook) enforcement — cut with the 2026-08-29 hook
  proposals; this stays orchestrator-owned.
- Changing QA evaluator behavior, inputs, or the sanity command set.

## Verification seam

Unit-test the orchestration decision, not a spawned pipeline: given a
candidate tree and an audit result tree, assert the outcome classification
(unchanged / changed / not-run), the cheap-gate re-run requirement on a
changed tree, the round-budget non-consumption, and the run-state record.
Envelope assembly asserts the audit manifest's inputs and budget at the
existing context-envelope unit seam. If a spawned assertion is genuinely
needed, add an `it` to an existing spawned scenario per the AGENTS.md
test-placement ladder; do not add a new spawned scenario.
