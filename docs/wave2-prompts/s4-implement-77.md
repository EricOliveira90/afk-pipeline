# S4 — implement #77 by hand (Wave 2)

Implement slice #77 of PRD 1 manually, the way slice #76 was finished —
outside the pipeline, on the pipeline's slice branch.

Working directory: `C:\Code\afk-s4` — a dedicated git worktree already
created for you on branch
`afk-codex/afk-v2-evidence-backbone-slice-03-contract-review-fails-closed`,
fast-forwarded to the feature branch tip `ab18bc2` (which already carries
#75 and #76). Run `pnpm install` there first. Read AGENTS.md there first
and follow its test discipline. Do not touch `C:\Code\afk`,
`C:\Code\afk-v2-run`, or the blocked directory
`C:\Code\afk-v2-run\.afk\worktrees\afk-codex-afk-v2-evidence-backbone-s03`
(a leaked process holds a handle inside it; your worktree replaces it).

## The spec

There is NO contract for this slice — #77 died at worktree refresh before
its explorer ever ran, so nothing was negotiated. Your scope is the issue
itself: `gh issue view 77 --repo EricOliveira90/afk-pipeline`. Its
acceptance criteria — including the operator's type-strictness amendment
(third criterion) — are the authoritative scope. In short: the contract
evaluator writes a canonical, versioned verdict artifact (one
ACCEPT/REVISE verdict plus findings with `id`, severity, `evidence`,
`expected`, `observed`, `clearCondition`); the orchestrator parses it
fail-closed; `VERDICT:`/`GAPS:`/`RE_RAISED_GAPS:` marker parsing leaves
the negotiate control flow; every review attempt is archived without
overwriting earlier ones.

## Why the last attempt failed — build your test plan from this

The negotiation record (run-20260825-185429, round 4) shows the planner
lost on falsifiability, and the harvest analysis pinned the mechanism:
**a paraphrase of a compound predicate always drops the conjunct that has
no named example value.** The evaluator checks falsifiability conjunct by
conjunct. So write the test plan the way the amendment is written:

1. One rejection fixture per conjunct of every compound validity rule —
   never one fixture "covering" a compound sentence.
2. Concrete counterexample values, copied from the issue where given:
   `behaviorIds: [1]`, `["a", 2]`; a non-string value in each of `id`,
   `evidence`, `expected`, `observed`, `clearCondition` — one fixture
   asserting rejection for EACH case, per the amendment.
3. Enumerate the field list in tests; never summarize it as "all other
   strings".
4. Malformed/missing/contradictory artifacts (ACCEPT plus a blocking
   finding, two verdicts, duplicate control fields) are terminal artifact
   failures with the artifact named — assert the failure is terminal and
   that nothing advances.

## Learnings from #76 you inherit (slice 02 handoff, on this branch at
`.kiro/specs/afk-v2-evidence-backbone/slices/02-.../handoff.md`)

- Any fixture that negotiates a contract needs a version 2 manifest whose
  `gateIds` name a gate with a command in THAT fixture repo — the catalog
  is resolved per worktree, and a repo with no sanity script cannot lock
  any contract.
- Do not assert an objection against text a rendered prompt template also
  contains — one orchestrator case passed for months on the planner
  template's own `"version": 1` string instead of the refusal message.
- `parseAcceptanceManifest` / the four negotiate-time checks in
  `runSliceNegotiate` are the pattern to match for fail-closed parsing
  and refusal accounting: a refusal spends a round, invokes no evaluator,
  and reaches the next prompt.
- Optional, only if you touch `src/acceptance-manifest.ts` anyway: QA
  accepted a Minor debt there (lines ~156-157, Node imports placed after
  interfaces/functions). Cheap to fix in passing; do not expand scope for
  it.

**Time warning:** this branch predates the 2026-08-26 test-suite work on
main. The full suite here costs ~14-17 minutes, has no budget gate, and
is not hermetic — host git hooks run in its fixtures. Budget the handoff
step accordingly.

Rules:

1. Scope is the issue's acceptance criteria. If the work genuinely needs
   something the issue does not imply, stop and ask the human — do not
   expand scope silently.
2. Verify with `pnpm test:fast` plus the heavy suites your changes touch;
   run the full `pnpm test` once when you believe the slice is done. Only
   one session may run the full suite at a time on this machine — ask the
   human first. All green before handoff.
3. Commit in small conventional commits referencing (#77) on the slice
   branch. Do not merge anywhere; do not touch run state or other
   worktrees.
4. Write the slice artifacts the way slice 02 did: a `handoff.md` (what
   you implemented, decisions, gotchas) under
   `.kiro/specs/afk-v2-evidence-backbone/slices/03-contract-review-fails-closed/`,
   committed on the branch.

Hand off with: what you implemented, the full-suite result, the exact
merge command for the human to run against
`feat-codex/afk-v2-evidence-backbone` (slice 02's was a fast-forward
`git -C C:/Code/afk-v2-run checkout feat-codex/afk-v2-evidence-backbone
&& git -C C:/Code/afk-v2-run merge --no-edit <slice branch>`), and
confirm the run-state entry the human will add after merging — the
`"77"` entry in
`C:\Code\afk-v2-run\.afk\state\afk-v2-evidence-backbone-codex.json`
must become `{ "phase": "PASS", "branch": "<slice branch>",
"mergedToFeature": true }` (replacing the current ERROR entry, and the
`resume."77"` entry can stay), so `--only-failed` stops selecting #77
and `priorCompleted` unblocks #78/#79.
