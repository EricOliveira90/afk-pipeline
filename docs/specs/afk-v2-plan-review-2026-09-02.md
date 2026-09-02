# Review: AFK v2 plan after the SDLC-playbook adoption update

Date: 2026-09-02. Reviewer: agent session for the founder. Scope: review only —
no plan, issue, or intent file was edited.

Inputs read: `docs/specs/afk-v2-plan.md` (full), the four intent files under
`docs/intent/` plus the 2026-09-02 adoption context, and issues #152, #71,
#72, #74, #84, #86, #135.

## Verdict

**Plan sound.** All five decided adoptions are present, correctly placed, and
correctly constrained; both explicit non-adoptions stayed out; the seven-PRD
dependency order holds; no new item silently depends on deferred work. Three
moderate findings should be fixed before PRD 6/7 tickets are cut — all three
are drift between the intent files and the issue text, not design defects.

## Pass 1 — Decision fidelity: PASS

- **Tamper guard (item 17).** First among the three main adoptions (PRD 4
  precedes PRD 7 and PRD 6). Deterministic-only, a gate not a hook (§3c
  policy 6 governs; intent restates it). Split matches the intent's resolved
  decisions: #84 owns deleted tests and protected paths, #86 owns
  project-declared skip detection; structured waive-with-reason required;
  file scope never implies a waiver; TS/Vitest detector, no universal regex.
- **Eval harness (item 18 / PRD 7 / #152).** Weekly + manual-on-change
  cadence, never per-PR. Report-only stated four times (item 18, §3 cut list,
  §6 standing trigger, #152 out-of-scope) — over-determined, which is right
  for a non-adoption boundary. Consumer-pack requirement carried: AFK owns
  runner and schema, consumers own packs, prompt-plus-expected-disposition
  scenarios supported (Rumo's open question resolved in #152), Rumo
  governance pack explicitly out of scope. Exact structured dispositions,
  model-call cap, `INCOMPLETE` — all present.
- **Mistake-twice loop (item 19 / #74).** Threshold two ("second exact
  occurrence"), canonical `learning-proposals.json`, class/count/target
  asset/proposed diff, committed proposals, never auto-edits steering,
  classifier similarity out of scope. One constraint dropped — see finding 2.
- **Guardian review policy (item 20).** Placed in the deferred
  guardian-convergence follow-up after PRD 3's measured guardian run, exactly
  as the context doc approved (not live PRD 3). #74 correctly assumes it
  already applies by PRD 6.
- **#135 cheap half (item 21).** Manual, after PRD 3 and before PRD 4;
  provider-specific projection (not inherit-and-strip); names-not-values
  evidence rule; OS sandbox / network allowlist / role policy excluded. Issue
  and plan match.
- **Non-adoptions.** Merge gating on eval pass-rate: absent everywhere, with
  a §6 re-open trigger. Plan-interrogation: on the §3 cut list, not tracked
  anywhere. Both confirmed out.

## Pass 2 — Plan coherence: PASS with one ambiguity

Dependency order holds: 17 → PRD 4 (rides #84/#86, which ride the slice-01
gate runner); 18 → PRD 7 after PRD 4; 19 → PRD 6 after PRD 7's format;
20 → follow-up after PRD 3 evidence, before PRD 6 consumes it; 21 → manual
slot between PRDs 3 and 4, which §4 shows. PRD 7 does not touch deferred
work: it needs no live cross-provider matrix (stub providers for runner
tests; live calls at eval time are operational, not story 16), and no durable
supervision (also reaffirmed in prd3 intent non-goals). No pre-existing
item's scope changed beyond what the adoptions require; §3d explicitly avoids
renumbering 1–16, and #86's early-delivery section credits PRD 3 without
moving PRD 4's ownership.

The one ambiguity is finding 4 (PRD 6 concurrency wording).

## Pass 3 — Issue consistency: PASS with drift noted

#152, #71, #72, #74, #84, #86, #135 all match the plan's scope and
constraints. The tree-ID-not-HEAD rule, the early-#86 sequence, the waiver
rules, and the advisory-gate attribute read identically in plan and issues.
The drift found is intent→issue (findings 2 and 3), not plan→issue.

## Pass 4 — Intent reconciliation: two silent drops

- Eval-harness intent's open question (consumer prompt+disposition
  scenarios) — resolved in #152 with evidence. ✔
- prd3-sequencing intent's completion evidence — satisfied by #86's early
  section plus the plan's §3d closing paragraph. ✔
- Mistake-twice intent's Rumo convergence constraint — dropped (finding 2). ✘
- Eval-harness intent's named seed corpus — dropped (finding 3). ✘

---

## Proposed improvements, ranked

### Moderate

**1. PRD 7 is named as owner of the item-19 proposal format but never
deliverables it.**
Target: issue #152 (Solution / Implementation Decisions); plan §2 rows 6–7;
plan §6 bullet "PRD 6 waits for PRD 7's versioned format only for item 19".
Plan §2, §6, and #74 all say item 19 consumes "PRD 7's versioned proposal
and disposition format" — but #152 defines only a scenario-pack schema and
disposition comparison. No #152 deliverable, user story, or test covers a
learning-proposal schema. As written, PRD 7 can ship complete without
producing the artifact PRD 6 waits for. Fix either way: (a) add to #152's
Solution a bullet — "Define the versioned learning-proposal schema (finding
class, occurrence count, target asset, proposed diff) alongside the
scenario-pack schema; PRD 6 item 19 and consumer repos write this shape" —
plus one unit-test line; or (b) cut the dependency, let item 19 own its
shape (the four fields are already fixed by the intent), and reduce PRD 6's
dependency row to "4". Option (a) matches the founder's context-doc
decision ("item 3 in PRD 6 after the eval format exists") and is preferred.

**2. The cross-repo format-convergence constraint was silently dropped.**
Target: plan §3d item 19; issue #74 (Implementation Decisions).
The mistake-twice intent makes convergence with Rumo's Close learning pass
(rumo-app #809) a hard constraint: "one shared shape for
recurrence-triggered proposed diffs." Neither plan item 19 nor #74 mentions
it. The four fields happen to match today, but nothing tells the PRD 6 run
agent the shape is externally constrained, so a harmless-looking field
rename would break the convergence unnoticed. Add one sentence to #74's
Implementation Decisions and to plan item 19: "The proposal shape is shared
with rumo-app's Close learning pass (rumo-app #809); changing fields
requires cross-repo coordination."

**3. The eval harness's initial scenario corpus has no owner.**
Target: issue #152 (User Stories / Testing Decisions); plan §3d item 18.
The intent commits to 20–50 seed scenarios from named sources: PRD 1
recorded envelopes, reliability-wave incidents #111–#121, evaluator verdict
cases, classifier cases. #152 carries only the forward-looking rule ("every
relevant future incident becomes a permanent scenario"). A runner with an
empty AFK-owned pack satisfies every current acceptance criterion. Add a
user story — "As a maintainer, I want the AFK-owned pack seeded from
recorded PRD 1 envelopes, the #111–#121 wave incidents, and evaluator and
classifier verdict cases, so the first scheduled run measures something" —
and mirror the seed sources in plan item 18's description.

### Minor

**4. PRD 6 launch condition is stated three ways.**
Target: plan §2 (row 6 + closing prose), §6 deferred-stories bullet; issue
#74 Further Notes. §6 says PRD 6 waits on PRD 7 "only for item 19"; #74 says
PRD 6 "is the final implementation run after PRD 7 defines that format"; §4's
diagram is strictly serial. If the intended rule is "whole PRD 6 launches
after PRD 7 merges", say that in §6 and delete "only for item 19"; if
#88/#93/#98 may launch during PRD 7 with item 19 ticketed later, say that in
#74. One sentence, one place, referenced from the others.

**5. PRD 7's dependency reason is untestably vague.**
Target: issue #152 (Dependencies and Sequencing); plan §2 row 7. "Depends on
PRD 4's exact-tree evidence and gate-policy foundations" names no concrete
artifact. The real binding prerequisite is that the candidate/final evaluator
roles and their canonical verdict artifacts — the things evaluator-verdict
scenarios replay against — exist only after PRD 4. Name that, so a future
re-scoper can check whether the dependency still binds instead of inheriting
it as ritual.

**6. The weekly cadence has no execution venue.**
Target: issue #152 or plan §3d item 18. "Run weekly" names no runner:
operator-invoked or CI cron? A CI cron needs provider credentials in CI,
which interacts directly with item 21's environment-minimization posture.
One sentence decides it; suggested default: operator-run weekly (calendar
discipline), with CI scheduling deferred until item 21's filtered-environment
pattern proves out.

### Nits (capped at five)

1. §3d lacks §3b/§3c's provenance note. §3b flags "ratings are the
   proposer's own, not debate-rated"; §3d's five rated items carry no
   equivalent. Add the same one-line disclaimer for comparability honesty.
2. Numbering collision: plan "item 17" (tamper guard) vs "#71 story 17"
   (deterministic assembly) vs "#73 story 17" (ROI evidence). The plan
   mostly qualifies story references with their issue — make it always,
   especially §2 row 3's bare "story 17's determinism requirement".
3. The tamper-guard intent's Proposed Outcome still says the gate "rides
   item 2's gate-derivation machinery", but the resolved decisions and #84
   put deleted-test/protected-path detection in the file-scope gate. The
   resolved decisions win; a one-line correction in the intent would stop
   the stale sentence from misleading a future reader. (Intent edit —
   flag only, per review scope.)
4. Item 21's "after PRD 3" qualifier is unexplained; the context doc said
   only "before PRD 4". If the reason is avoiding concurrent edits to
   provider dispatch files during PRD 3's run, say so in §5's table row;
   otherwise drop the qualifier and let it ship any time before PRD 4.
5. The 8 GB launch floor for remaining PRD 3 runs lives only in §3d's
   closing paragraph; §4 (the section a launch operator actually follows)
   never mentions it. Add it to the PRD 3 line in the §4 diagram notes.

## Bottom line

No adoption was mis-scoped, weakened, or smuggled past its constraints, and
the two non-adoptions are fenced with re-open triggers. The three moderate
items are all one-to-three-sentence fixes to #152, #74, and plan §3d, and
should land before PRD 7 slices are ticketed — finding 1 in particular
determines what PRD 7 must deliver.
