# Contract feedback — round 7 (cleaner loop, #87)

The contract locks. What follows is why, and the one non-blocking note.

## The scope claim is verifiable and it verifies

This contract's central and riskiest move is to declare that almost all of the
slice is already landed at `b817ef2`, and that the whole remaining obligation is
two stale run-state version literals. That claim is not taken on trust here — it
is the kind of claim a reviewer can check cheaply, so it was checked, and it
holds exactly:

- `src/run-state.ts:67` reads `RUN_STATE_VERSION = 6`.
- `src/eval-boundary.test.ts:127` reads `expect(RUN_STATE_VERSION).toBe(5)` and
  `src/qa-orchestration-gates.test.ts:1016` reads `expect(bumped.version).toBe(5)`.
  Those are the only two `5` pins against that constant anywhere in `src/`;
  `src/run-state.test.ts:990` already reads `6`.
- Both files are in the manifest's `fileScope`, so the remaining edits are
  inside the declared scope rather than requiring a mid-build widening. The
  contract's justification for that widening — that the earlier map named
  `src/run-state.ts` and `src/qa-orchestration.test.ts` but neither the sibling
  half of the split suite nor the `eval-boundary` leaf test, and that a
  file-scope map is exhaustive only for the files it names — is the right
  reading, and it names the ADRs it rests on.
- The claims the contract says are already true are true: `src/cleaner-stage.ts`,
  `src/suppression-gate.ts`, `prompts/cleaner.md` exist; `CLEANER_STAGE_ID` at
  `src/final-evaluation.ts:49`; `CLEANER_CONTEXT_MANIFEST` at
  `src/context-envelope.ts:771`; `MAX_CLEANER_ROUNDS`/`cleanerRoundsRemaining` at
  `src/bounds.ts:84`/`:92`; `artifactDirPolicy` at `src/escalation.ts:307`
  defaulted to `"exempt-prefix"` at `:315`; the `"cleaner"` `QAReviewStage`
  member at `:92` with its docstring exception at `:77` and its filename branch
  at `:452`; `qaArchivePrefix`'s dedicated `"cleaner"` branch and widened return
  type at `src/artifacts.ts:742-745`; `archiveCleanerLog` at `:758` writing
  `cleaner-log-r<n>-a<n>.log`; `GATE_EVIDENCE_VERSION = 4` with
  `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2, 3, 4]`; the pin at
  `src/acceptance-gate.test.ts:306` reading `4`; the `ARCHITECTURE.md` rows; and
  no `agents/cleaner.md`, as B-12 promises.
- Every one of B-01…B-14 and P-01…P-10 has at least one test carrying its
  issue-qualified `[behavior:#87:<id>]` tag, and every one of those tests lives
  in a file the manifest declares. Nothing is tagged in a file outside scope,
  and nothing is untagged.

The explorer map's "no cleaner-related symbol exists anywhere in `src/`" is
indeed stale against this branch tip, and the contract is right to say so
plainly and not restate it.

## Gate aptness

Each entry's gates can produce the evidence its claim needs. `tests` observes
every behavioral half; `acceptance:behaviors` selects the tag, and the
qualified `[behavior:#87:B-05]` spelling still matches a bare-id
`--testNamePattern` as a substring, which the contract states rather than
leaves implicit. `typecheck` is present on exactly the entries with a
type-level half that `tests` cannot see — the widened `QAReviewStage` union
(B-09, P-09), the additive optional `artifactDirPolicy` argument and its
`ScopeGateInput` mirror (B-11, P-10), the `runCandidateGatePhase` signature
argument that P-04 rests on, the `RunState.version` widening (B-14), and the
`ContextEnvelopeRole`/`PromptAssemblyRole` split (B-12). The non-executable
`lint` gate is not cited anywhere, and `test:budgets` is deliberately kept out
of the gate set with the ADR 0063 reason given.

## Scenario honesty

The Given/When/Then bodies match their same-ID obligations, including in the
places where earlier drafts of this contract had two readings:

- B-07 now enumerates four exit paths, each with exactly one reset target and
  exactly one recorded round outcome, and the manifest's `then` mirrors that
  enumeration rather than summarizing it. The escalation path's reset to the
  *accepted tree* rather than the input checkpoint is stated as the one
  documented exception in both B-07 and B-13, with the same words and the same
  reason, so the two behaviors cannot drift apart.
- `ESCALATION_MALFORMED` is stated as the malformed round's whole outcome, with
  the mechanism that makes that true — the checkpoint is discarded by the reset,
  so it is never gated — rather than as an assertion the reader must reconcile.
- P-01 is honest about what it does *not* claim: it is not a byte-identical
  claim over a `clean`-less run, and it explicitly excludes the run-state
  `version` field because the bump is unconditional. It also states why no
  spawned scenario can be cited for a disabled stage (both tier-2 scenarios
  declare `clean`), which is the sort of thing that usually goes unsaid and then
  produces an untestable claim.
- P-04, P-09 and P-10 each name the *proxy* they are observed through when a
  vitest unit test cannot see the real thing — `fileScope` exclusion for an
  unedited helper, the prefix set for a module-private `RECORD_FILENAME`, a
  source-text scan for the absence of a `sliceArtifactDir: ""` assignment — and
  say so as a limitation rather than dressing the proxy up as the claim.

## Parser regression surface

Two parsers change their accepted input language, and both halves are bound for
each. `parseClean` binds newly accepted input (a valid minimal `clean` taking
the documented `additionalWriteScope`, `suppressionDetectors` and
`expectedCostMs` defaults) against rejected input that must stay rejected (an
unknown sub-key, a `gates` id colliding with a catalog id, an empty `gates`
array — each refused with the offending key or id named), with the established
inline harness `src/gate-policy.test.ts` declared in `fileScope` and already
carrying the B-01 tag. `parseCleanerEscalation` binds the well-formed
version-1 `BASELINE_IS_WRONG` document against the blank-field, unknown-key and
wrong-class rejections, in `src/cleaner-stage.test.ts`. Neither leaves a fixture
surface undeclared: the regression evidence for both is inline unit tests, which
is where this repository's config and artifact parsers are already tested.

## Blocking unknowns

None survive. The explorer's one unknown that could have blocked a lock —
whether `qaArchivePrefix` needs a dedicated `"cleaner"` branch or can rely on
its `else → "final"` fallback — is answered in the contract (a dedicated branch,
a widened return type, and explicitly *not* joining `QA_REVIEW_STAGES`), and the
answer is in the shipped code. The remaining explorer unknowns are unread file
bodies and unopened ADRs, none of which the declared work depends on.

## Feasibility

One generator session, comfortably. The remaining work is two one-literal edits
in two declared files, carried by a single named commit, verified by
`pnpm run typecheck && pnpm test:fast` plus `pnpm run test:heavy:qa` — which
between them run both pins, so no third command and no full-suite run is
needed. The wall-clock consequence of the two spawned scenarios is declared
against `suite-budgets.json`'s 151s `qa-orchestration` budget with the ADR 0063
reason it cannot redden a gate, and the definition of done asks for a recorded
measurement and a handoff line rather than a budget edit — the right call, since
raising that number is an operator action.

## Non-goals

Named specifically, not gestured at: slice 04 (#274)'s starter template and
`## Quality Stages` header line, #97's events and PR-body wiring, the hardener
loop (#92), running `suppressions` on generator candidates, a CLI enable flag,
editing this repository's own `afk.config.json`, and closing #226 — with the
handoff obligation to note the `role`-source call site on #226 without closing
it carried into the definition of done.

## One note, not a blocker

B-13's `gateIds` omit `typecheck` even though its `then` asserts the
escalation document's declared shape and the appended fresh
`PersistedQualityStage` entry — both type-level. Those types are gated through
B-14's and B-12's `typecheck` entries, so no evidence is actually missing: a
stale escalation or persisted-stage type would still turn `typecheck` red
somewhere in the manifest. Add `typecheck` to B-13 if you want the entry to be
self-sufficient; leaving it is fine.
