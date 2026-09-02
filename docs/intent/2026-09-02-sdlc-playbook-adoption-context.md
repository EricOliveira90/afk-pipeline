# Context: AI-native SDLC playbook adoption decisions (2026-09-02)

Handoff for the AFK planning session. Read this together with the three intent
files in this folder. Source material: Anthropic's "The AI-native SDLC playbook"
(claude.com/blog/the-ai-native-sdlc-playbook), reviewed against the AFK v2 plan
on 2026-09-02 with the founder.

## Framing from the review

The playbook's core claim — build collapsed, the bottleneck moved to the
human-speed stages around it — is the problem AFK exists to solve. Most of the
playbook's build-stage plays exist in AFK in stronger form: the artifact chain
(PRD → linted tickets → locked contracts), worktrees/lanes/merge mutex,
fresh-context verification (evaluator-qa split), executable bindings (#76)
generalizing failing-test-first. Hooks were evaluated 2026-08-29 and rejected
(§3c policy 6: deterministic checks belong in the gate catalog). Adoption value
is in the gaps below, not in re-doing covered ground.

## Decided adoptions, in implementation order

The founder reordered the original ranked list by value-per-cost: ship the
cheap deterministic guard first, then the expensive high-value harness.

### 1. Feedback-loop tamper guard — do first

Intent: `feedback-loop-tamper-guard.intent.md`.

Deterministic changed-tree gate on the generator diff: deletes/skips a test,
edits the gate catalog, or touches suite-budgets.json outside contract →
surfaced finding, fail-closed, waive-with-reason override (same as item 6).
Rides item 2's gate-derivation machinery. Near-zero cost, covers the defect
class that silently corrupts everything downstream (same class as #111–#121:
output that misleads the next actor). Turns §3c policy 1's prompt text into an
enforced check. Not a hook — a gate, per the 2026-08-29 decision.

### 2. Agent-behavior eval harness — plan item

Intent: `agent-eval-harness.intent.md`.

The biggest genuine gap: orchestrator code is regression-tested, but
`prompts/`, `agents/`, and envelope policy are verified only by the next live
PRD run. Replay 20–50 recorded cases (PRD 1 envelopes, reliability wave
#111–#121, evaluator verdict cases, classifier cases) against roles on config
change, on a cadence — not per-PR (model-call cost). Every incident becomes a
permanent scenario. Feeds item 13 measurement culture and story 17 ROI framing.

Explicit non-adoption attached to this item: do NOT gate merges on eval
pass-rate, despite the playbook recommending it. Noisy measurements report and
never block (the test:budgets lesson — a false red teaches people to raise
numbers). Results land as item-13-style first-class measurements with a
standing trigger.

Cross-repo commitment: AFK owns the runner; consuming repos own scenario
packs. Rumo will add a governance scenario pack later (rumo-app
`docs/prds/governance-evals/intent.md`, explicitly deferred until this harness
exists). Design the runner so a consumer pack can express prompt +
expected-disposition scenarios, not only envelope replay — Rumo's open
question, resolve it here.

### 3. Mistake-twice → memory proposal loop — lightweight

Intent: `mistake-twice-memory-loop.intent.md`.

When a finding class recurs (second occurrence) across rounds or runs, the run
summary / guardian output proposes amendments to AGENTS.md / ARCHITECTURE.md /
prompts/ as ordinary diffs in the draft PR. Formalizes what run 5 proved
expensive to do by hand (8 generator commits burned on the AGENTS.md
launch-command mistake before a Track 4 hand task fixed it). Pairs with §3c
policy 3's ARCHITECTURE.md honesty guards.

Cross-repo commitment: the proposal format converges with Rumo's Close
learning pass (rumo-app `docs/prds/close-learning-pass/intent.md`, spec issue
EricOliveira90/rumo-app#809): one shared shape for recurrence-triggered
proposed diffs — finding class, occurrence count, target asset, proposed diff.

## Smaller adoptions decided (no intent files)

4. Structured review policy for guardians (the playbook's REVIEW.md pattern):
   named passes (bugs / security / contract-compliance), explicit "Important"
   definition, hard nit cap, do-not-report list. Attacks the measured
   evaluator/review reading cost (22.7–30.3 min per round) from the output
   side; item 5's change-summary envelope attacks the input side. Pure prompt
   text in `agents/` — cheap, high value-per-cost. Approved placement is the
   deferred guardian-convergence follow-up after PRD 3's measured guardian
   run, not live PRD 3.
5. Promote #135 before PRD 4, cheap half only: scrubbed/allowlisted env for spawned
   provider processes. The playbook's managed-settings worked example (deny
   ~/.ssh and ~/.aws reads, strip named secrets, network allowlist) is
   external corroboration that this is the standard control set. Windows makes
   OS-level sandboxing awkward; env scoping alone is most of the value.

Dropped as a tracked item: plan-interrogation prompt text ("what could this
break, riskiest step, rejected options"). Marginal — negotiation already does
most of it. Acceptable as a two-line prompts-v2 addition if convenient; do not
plan it.

## Rumo lane status (for coordination awareness only)

Rumo runs its own lane in parallel; no file overlap with AFK. State as of this
handoff: governance restructure merged (rumo PR #810); spec #808 (griller
state machine) in implementation; spec #809 (Close learning pass) queued
behind it; governance evals deferred until item 2 above exists.

## What the planning session should produce

Incorporate items 1–5 into the AFK v2 plan: item 1 in PRD 4, item 2 as PRD 7
with the non-gating rule and consumer-pack requirement, item 3 in PRD 6 after
the eval format exists, item 4 in the deferred guardian-convergence follow-up,
and item 5 as manual security work before PRD 4. The three intent files carry
the per-item constraints and approved decisions.
