# Contract review — Cleaner loop (round 1 of this negotiation)

## What is strong

This is a precise contract. Most of what I went looking for, I found already
answered, and two of my candidate objections were retired by reading the code
rather than the prose:

- **B-04 against P-04.** I expected routing the clean gates through
  `runCandidateGatePhase` to collide with
  `assertGateEvidenceReleasesEvaluation`'s `!required || PASS` condition, which
  would make B-04's "a required `SKIPPED` releases the tree" unreachable without
  editing `src/candidate-gate-phase.ts` — a file P-04 and the `fileScope`
  both forbid. It does not collide: `runCandidateGatePhase` never calls that
  assertion; its callers do (`src/orchestrator.ts:6369`,
  `src/post-qa-gates.ts:278`). P-04's claim that the stage "reads its own
  results" is literally true, and the pairing is sound.
- **P-09's derivation claim.** "The attempt-record stage validator's accepted
  language derives from that one array, so asserting the array's exact contents
  is the whole assertion" reads like the kind of shortcut that hides a
  one-sided regression surface. It checks out: `src/qa-review.ts:560-567`
  rejects on `!(QA_REVIEW_STAGES as readonly string[]).includes(input.stage)`
  and builds its message from `QA_REVIEW_STAGES.join(", ")`, so pinning the
  array's contents does pin both the rejection of `"cleaner"` and the message.
  Paired with the `RECORD_FILENAME` `(qa|uat|final)` anchor, the widened
  `QAReviewStage` binds both halves of its regression surface without
  `src/qa-review.test.ts` entering scope. That argument is correct, not
  convenient.

The parser surfaces are otherwise well bound: `parseClean` declares an accepted
minimal document *and* three refusals (unknown sub-key, catalog-id collision,
empty `gates`); `parseCleanerEscalation` declares one valid document and three
malformed siblings with a stated non-fatal disposition; the run-state bump
declares the version-6 write *and* the version-5 boundary read that must stay
accepted and must not rewrite the file. B-07's exclusion of the valid-escalation
path, restated as an explicit assertion in the test plan, is the sort of
negative obligation that usually gets discovered during implementation instead.

## Why this comes back

### The branch has already done three of these behaviors

The contract is written as if the tree were greenfield, and it is not. On this
branch:

- `5b77dd1 feat(#87): gatePolicy.clean parsing and the cleaner round bound` —
  `src/gate-policy.ts` +362, `src/bounds.ts` +26, both test files.
- `526260c feat(#87): the suppressions gate and gate evidence version 4` —
  `src/suppression-gate.ts` +222, `src/gate-runner.ts` +52.

`src/gate-runner.ts:51` is already `GATE_EVIDENCE_VERSION = 4` and `:54` is
already `[1, 2, 3, 4]`; `src/gate-policy.ts:38` already carries `"clean"`; and
`src/gate-policy.test.ts`, `src/bounds.test.ts` and `src/suppression-gate.test.ts`
already carry `[behavior:B-01]`, `[behavior:B-05]` and `[behavior:B-10]` tags.
B-01, B-05 and B-10 are done and tagged. The one piece left is
`src/acceptance-gate.test.ts:329`, still `expect(GATE_EVIDENCE_VERSION).toBe(3);`
against a shipped 4 — so `pnpm test:fast` is red the moment the session opens,
which is exactly what `48dec26`'s escalation asked to fix and what this contract
correctly brings into scope.

The premise came from the explorer, whose FACT that "no cleaner-related symbol
exists anywhere in `src/` today" the branch contradicts. Restating B-10 as "goes
3 → 4" is now actively harmful: a generator that executes it as written can only
over-bump to 5 and re-widen an already-widened list. Recording the landed
commits, and narrowing B-10's outstanding obligation to the single pin edit, is
the fix.

### The single-session claim is not defended

Withdrawing the shed order was the honest call — you cannot ship a slice by
dropping declared behaviors, and the Definition of done makes that explicit. But
withdrawing the valve without answering the question it existed for leaves the
feasibility claim resting on nothing. Thirteen outstanding behaviors and nine
preservation behaviors across a 32-path scope: a new stage module carrying the
round loop, the revert and the escalation parse; orchestrator wiring at two
anchors; a `RUN_STATE_VERSION` bump with a new persisted shape, two writers and a
per-baseline reader; a new role with context manifest and prompt; archiving with
two new branches and a new export; the scope gate's first `role`-source rule; a
logger section; the shipped template, its packaging and a README section; and
`ARCHITECTURE.md` — with four of those behaviours' observables landing as new
`it`s on the spawned `qa-orchestration` fixture.

The rate this slice has actually shown is three behaviors and then an
escalation. Either count the landed work and argue the remaining thirteen
concretely, or name a tail and hand it to a follow-up contract. Both B-15
(template, `files`, README) and B-16 (the event and the `## Quality Stages`
header line) are separable from the stage loop, and B-16's own source note
already says this slice owns only the event and the header line. What I need is
for the mandatory set and the defended set to be the same set.

## Smaller notes

- **B-13's zero-consumption promise.** `baselineTreeId` is content-addressed, so
  "a re-approved candidate — a different tree" is an assumption, not a fact. A
  generator that answers the escalation without changing tracked content
  re-approves the *same* tree id, `cleanerRoundsSpent` selects the same record
  member, and the escalating round counts against the new approval. That may be
  the behaviour you want; the contract just states it unconditionally.
- **`acceptance:behaviors` is never declared.** Every behavior carries
  `["typecheck", "tests"]` or `["tests"]`, so per-behavior evidence rests on a
  whole-suite gate — while the catalog offers the gate that runs exactly the
  tagged test the Definition of done's first box demands.
- **B-15's packaging assertion has no home.** "A unit test" with no path, inside
  a scope that admits thirteen test files. Name it. Its exact-set shape is also
  worth a comment, so the next person to add a template knows the failure is
  deliberate.
- **Line-anchor drift.** B-03 and P-01 put `finalTreeId` at
  `src/orchestrator.ts:6796`; the explorer's read of the same statement is
  `:6794`, and the three commits above did not touch `src/orchestrator.ts`.
  Nothing turns on it — the ordering the behaviors describe is unambiguous — but
  the anchors will not resolve as literal line numbers.
