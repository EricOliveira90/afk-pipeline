# Contract review — slice 01 audit invocation, round 1

## What is settled

Both prior findings are cleared, and I verified the fixes against the code
rather than taking the citations on faith.

The source-order scan (now B-03) names anchors that resolve. `await
runQAStage(` matches the deterministic dispatch at `src/orchestrator.ts:6415`
and the remote one at `:6501`, but never the declaration at `:4737`, which
reads `export async function runQAStage(`. `requiredFailures =
collectRequiredGateFailures(` matches only the assignment at `:6337`, not the
exported declaration at `:5529`. `assertGateEvidenceReleasesEvaluation(` is
unique at `:6385`. The manifest also states the declaration-exclusion rule in
its own words, so the rule survives a future anchor edit.

The QA-receives obligation took the narrowing route, which is the right one
here. B-09 now claims only what its stage test can fail on — the returned
`{ ran, verdict, treeId }`, exactly one dispatch, and both passed objects
still deep-equalling their `structuredClone` snapshots after the await — and
the value-level claim about the dispatch arguments is routed to #300 by name
rather than dropped. That routing is coherent against the code: at
`src/orchestrator.ts:6415-6432` the dispatch passes `qaBaseGate` as a bare
identifier with no spread override, and `checkpoint.treeId` /
`checkpoint.commitSha` as the separate position argument, so the substitution
the earlier round warned about would be a change #300 has to make, not
something this slice can ship quietly.

The explorer left the context-envelope layer as an unverified UNKNOWN and
asked for a re-check before relying on it. I did the re-check, and the
contract's numbers hold: `PromptAssemblyRole` is at
`src/context-envelope.ts:827`; `assembleContextEnvelope` begins at `:1282`
and its stricter-only clamp is exactly `Math.min(input.inlineSizeBudgetBytes
?? input.manifest.inlineSizeBudgetBytes,
input.manifest.inlineSizeBudgetBytes)` at `:1327-1330`, documented as
stricter-only at `:1290-1293`; all seven existing manifests declare
`inlineSizeBudgetBytes: 65_536`, so "the standard budget" is a real
convention and not a guess. B-05's out-of-order case is reachable, because
`validateRenderedBlockOrder` at `:1332` checks the rendered prompt against
the ordered artifacts. That UNKNOWN is retired; it is not blocking anything.

The rest of the scope evidence checks out too. `recordPrompts` is at
`src/cli-options.ts:65`, `:255`, `:289` with its test at
`src/cli-options.test.ts:139`, and `PipelineConfig.recordPrompts` at
`src/orchestrator.ts:544` — the pattern B-01 mirrors. All three CLI entries
really do spread `...runtimeOptions` (`src/afk.ts:314`,
`src/afk-claude.ts:276`, `src/afk-codex.ts:276`), so `fileScope` is right to
omit the entry files. `RUN_STATE_VERSION = 6` is at `src/run-state.ts:67` and
the three literal-`6` pins are exactly where B-10 says they are
(`src/eval-boundary.test.ts:127`, `src/qa-orchestration.test.ts:1028`,
`src/qa-orchestration-gates.test.ts:1043`). Widening `PromptAssemblyRole` is
safe within this `fileScope`: its only outside consumers are
`src/logger.ts:45` (a four-literal `Set`) and `src/run-events.ts:107`/`:131`
(payload unions), and there is no `Record<PromptAssemblyRole, …>` anywhere
that a fifth member would break. `resolveCandidateTreeId`
(`src/gate-runner.ts:280`), `decideFinalReuse`
(`src/final-evaluation.ts:117`) and the injected-dispatch precedent
(`src/cleaner-stage.ts:745`) are all where they are cited, and
`prompts/generator-audit.md` does not yet exist.

## What still needs a change

**The stage's run-state write is unobserved.** This is the one thing standing
between this contract and a lock, and it is the same defect shape as the
finding that was just cleared — a claim no declared observation can fail on.
The scope lock and the Definition of done both say an identical tree *records*
`AUDIT_UNCHANGED` in run state, which is #299 AC10. But B-10's observation is
a `src/run-state.test.ts` unit test that exercises `recordSelfAuditOutcome`
and `selfAuditsFor` directly, so it stays green whether or not any stage ever
calls the writer. B-09 is the only behavior that runs the stage down the
AUDIT_UNCHANGED path and it says nothing about run state, and B-02's
`selfAuditsFor` assertion is a negative that a never-writing stage also
satisfies. So a candidate can ship `recordSelfAuditOutcome` with no caller and
pass typecheck, tests and the acceptance gate — the inverse of the
ARCHITECTURE.md line B-10 itself quotes.

The fix is cheap because B-02 already declares the harness: a temporary
run-state directory and a `selfAuditsFor(loadRunState(...), ghIssue)` read
against the same entry point. Extending B-09 to assert one
`AUDIT_UNCHANGED` entry whose `candidateTreeId` and `auditedTreeId` are both
the released checkpoint tree id closes it without a new seam.

## Worth stating, not worth blocking on

No declared observation binds the callback the orchestrator injects to a real
generator invocation in the candidate worktree. B-03 asserts only the call
site's source position, and every dispatch observation is a spy. Given that
`--self-audit` is default-off and a spawned scenario is an explicit non-goal
— which is the correct call under this repo's test-loop cost discipline — the
wiring's only proof is that typecheck accepts the callback's type. That is a
reasonable tradeoff to make deliberately; it is a bad one to make by
accident, so either extend B-03's scan to reach into the injected callback's
body or say plainly that this slice carries the wiring on typecheck alone.

## Feasibility

One session can deliver this. Fifteen paths sounds like a lot, but three are
one-line version-pin updates, the ADR and the prompt are new files with a
documented structure to follow, and every new mechanism has a named precedent
in the repo — `recordPrompts` for the flag, an existing manifest plus
`assembleContextEnvelope` for the envelope, `decideFinalReuse` for the pure
classifier, `ctx.dispatch` for the injected callback, and the v4/v5/v6 bumps
for the schema. Nothing here needs a spawned pipeline scenario, the migration
count of 0 is right for an additive record, and the declared gates
(`typecheck`, `tests`, `acceptance:behaviors`) can each produce evidence for
the behaviors that name them. The non-goals do real work: the changed-tree
wiring and the `src/orchestrator.ts:6415` argument edit go to #300, the
failure taxonomy and status surfaces to #301, and the generator prompt prose
stays untouched, which P-04 backs with a `fileScope` exclusion.
