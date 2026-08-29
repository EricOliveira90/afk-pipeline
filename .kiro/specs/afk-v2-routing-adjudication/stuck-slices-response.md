# Stuck-slice QA response — PRD 2 (afk-v2-routing-adjudication)

Answers the open QA blockers on the two slices that ran out of
implementation rounds: #89 (slice 03, "A human decision resumes the
parked slice") and #82 (slice 04, "Stuck diagnosis assembled by code").
Written by hand on `fix/prd2-stuck-slices`, branched from
`feat-codex/afk-v2-routing-adjudication` at `06a4e2f`, then merged back.

Neither slice lost work: both branches merged into this one cleanly, so
everything below is added on top of what the run produced.

Verification: `pnpm typecheck`, `pnpm test:fast`,
`pnpm run test:heavy:orchestrator`, `pnpm run test:heavy:resume`,
`pnpm run test:heavy:qa`. Not the full suite — the operator reopens the
pre-ship gate afterwards, which runs it on the merged branch, and a
parallel session was active on the same machine.

## #89 — slice 03

### Round 3, Finding 1 — successful evaluator and third-instruction adjudications are not proved through generation

**Fixed.** The multi-slice adjudication fixture in
`src/orchestrator-runs.test.ts` ("an impasse parks its slice and holds
only DAG dependents") gained two lanes rather than two runs, because the
state they need — a parked slice with a valid decision — is what that
fixture already builds and only the decision form differs:

- slice 09 / #8189, an `EVALUATOR` winner;
- slice 10 / #8190, a `thirdInstruction`.

Both fixtures declare `revisedFiles` different from `files`, so the
post-apply artifacts are observably the revised ones and not the
pre-apply proposal carried through. Per lane the test asserts:

- exactly three planner invocations — rounds 1 and 2 are the negotiation
  that deadlocked, the third is the one apply round;
- exactly two `evaluator-contract` invocations, so the human decision
  is not sent back for another adjudication;
- the apply planner's prompt contains the decision bytes the fixture
  wrote (captured in `writtenDecisions`), the contested finding's
  `plannerEvidence` and `evaluatorEvidence`, and the
  "Apply this decision exactly once" instruction — verbatim, not
  paraphrased;
- the `contract.md` committed to the feature branch equals an exact
  literal (`**Status:** LOCKED` over the revised file list), and the
  committed `acceptance-manifest.json` carries the revised `fileScope`
  paths and the unchanged `B-01` behavior;
- exactly one generator invocation, starting no earlier than the apply
  planner finished, with the slice's run.log showing
  "accepted adjudication for F-IMPASSE; contract LOCKED" *before*
  "implementing (round 1" — generation only after the gates passed.

The refusal lanes (#8186, #8187, #8188) already proved the gates can stop
generation. These prove the same path reaches generation once they pass,
which is the half a refusal case cannot show.

### Round 2, Finding 1 — planner-applied renumbering lacks orchestration-level generator-suppression proof

**Already satisfied by round 3's commits; verified, not assumed.** Slice
08 / #8188 of that same fixture is an orchestration lane: its provider
renumbers the applied manifest's behavior `B-01` → `B-02` on the apply
planner invocation, and the test asserts the slice ends `ESCALATE` with
"behavior ID stability refused: unchanged behavior renumbered B-01 ->
B-02", its `contract.md` not `LOCKED`, three planner invocations, and no
generator record at all. Unlike the earlier `runSliceNegotiate` test, a
generator record here is something the fixture would actually have
produced, so its absence is evidence.

### Round 2, Finding 2 — orchestration refusal tests bypass the injected post-lock callback seam

**Already satisfied by round 3's commits; verified, not assumed.** The
fixture now passes `onContractLocked` into `runPipeline` and returns the
per-slice refusal only when `adjudication.md` sits beside the contract,
so #8186 (planner-winner route) and #8187 (planner-apply route) fail at
the lock-then-reopen callback, not at pre-lock manifest binding. Both
assert an unlocked contract, no generator invocation, and the injected
refusal text in the persisted error and in run.log.

Neither round-2 finding needed new code. They were open only because
round 3's report did not restate them.

## #82 — slice 04

### Finding 1 — shared resume drops unresolved-finding fields

**Fixed.** `formatUnresolvedQAFindings` (`src/orchestrator.ts`) now
renders `severity`, `state`, `unresolved` and `remedy` alongside the id,
summary, clear condition and artifact references it already emitted —
the whole of `QAReviewAttemptFinding`.

The function is now exported, which is what makes the field set assertable
without spawning a pipeline. The template test in `src/resume.test.ts`
supplies its own `UNRESOLVED_FINDINGS` string, so a shrinking formatter
was invisible there by construction. Coverage, in the fast suite:

- `formatUnresolvedQAFindings` renders every field of a finding seeded
  with a distinct value per field (`ADVISORY`, `OPEN`, `SCOPE_AMENDMENT`,
  and three markers), compared against an exact expected string;
- a second case walks the field list and ends with
  `expect(Object.keys(finding)).toHaveLength(8)`, so a ninth field added
  to the record type fails here rather than shipping unrendered;
- the empty case still renders `(none)`.

The heavy resume suite asserts the same fields survive to a real prompt:
"carries every unresolved-finding field into the repair input" reads the
`# Current unresolved findings` block out of the STUCK-resume generator's
actual prompt and checks each labelled line.

### Finding 2 — shared STUCK resume does not preserve stuck.md through PASS

**Fixed**, in the prompt and in the orchestrator, because a prompt rule
alone cannot guarantee bytes.

`prompts/generator-resume.md` now names `{{SLICE_DIR}}/stuck.md` in
Required reading and carries an invariant that it is read-only evidence —
never deleted, moved, rewritten or edited, because the pipeline owns the
file and rewrites it itself if the attempt fails.

`runSliceExecute` captures the diagnosis bytes at entry when
`ctx.resume?.mode === "stuck"` and restores them on the successful path,
before the commit, so the diagnosis the slice ships is the one the
operator read. `src/artifacts.ts` gained `readStuckDiagnosis` and
`restoreStuckDiagnosis`; the latter reports whether it changed anything,
and the orchestrator logs a line when it did. A *failed* attempt is
deliberately left alone — rewriting the diagnosis from the new round's
evidence is `finishStuck`'s job, which is B-04.

Coverage, both in the existing STUCK re-entry scenario in
`src/resume-integration.test.ts` (no new spawned run):

- run 2's slice-01 generator now deletes `stuck.md`, simulating exactly
  the misbehaviour the prompt forbids;
- "ships the named slice's pre-resume diagnosis byte-for-byte after PASS"
  compares the copy committed to the feature branch against the bytes
  captured after run 1 and asserts the restore line in the slice's
  run.log.

A unit case in `src/prompt-template.test.ts` asserts the template's
Required-reading entry and the invariant text, so the prompt half cannot
silently regress either.

### Incidental — the retirement check was pinned to a slice-base commit

`src/prompt-template.test.ts` proved AC6's "historical mentions stay" half
with `git diff --exit-code <slice-base> HEAD -- docs/adr docs/specs`. That
passed in the slice's own worktree and fails on any branch that later adds
a doc — including this one, because Track A added
`docs/adr/0050-...`, and including `main` from the next ADR onwards.

Replaced with the base-independent form of the same claim: `git grep -l`
over `docs/adr` and `docs/specs` must still list
`docs/adr/0019-configurable-wall-clock-ceiling.md` and
`docs/specs/afk-v2-agent-roles.md`. That asserts what AC6 actually asks —
the check must not scan or remove the history — without a pinned commit.
The retirement scan itself is unchanged and still scoped to `src/` and
`prompts/` only, per #82's fourth revision.
