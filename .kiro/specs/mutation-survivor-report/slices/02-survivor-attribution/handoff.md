# Slice 02 — Survivor attribution and accepted decisions (#304)

- New migration files: 0

## What shipped

- B-01: `src/afk-manifest.ts:MutationReportDeclaration` (`baselinePath`, `decisionsPath`), `src/afk-manifest.ts:normalizeMutationReport`
- B-02: `src/afk-manifest.ts:normalizeMutationReportPath`
- B-03: `src/afk-manifest.ts:trimUnclaimedMigrationPrefixes`
- B-04: `src/mutation-report.ts:parseMutationDecisions`, `src/mutation-report.ts:readDeclaredArtifact`, `src/mutation-report.ts:readMutationBaseline`, `src/mutation-report.ts:readMutationDecisions`
- B-05: `src/mutation-report.ts:attributeMutationSurvivors`, `src/mutation-report.ts:baselineKey`
- B-06: `src/mutation-report.ts:attributeMutationSurvivors`
- B-07: `src/mutation-report.ts:decisionKey`, `src/mutation-report.ts:attributeMutationSurvivors`
- B-08: `src/mutation-report.ts:attributeMutationSurvivors`
- B-09: `src/mutation-report.ts:runMutationStep`, `src/mutation-report.ts:attributeStepOutcome`
- B-10: `src/mutation-report.ts:formatMutationReportLines`, `src/mutation-report.ts:ATTRIBUTION_NOTE_LINES`
- B-11: `src/run-events.ts:RunEventPayload` (`mutation-step`), `src/run-state.ts:PersistedMutationStep`, `src/run-state.ts:sanitizeMutationStep`, `src/run-state.ts:isMutationSurvivorLabel`, `src/logger.ts:MutationStepReport`, `src/logger.ts:deriveMutationStepOutcome`, `src/ship-gate.ts:runShipGate`
- B-12: `src/ship-gate.test.ts` (two real gate runs plus the gate-module source check)
- P-01: `src/afk-manifest.test.ts`, `src/logger.test.ts`, `src/ship-gate.test.ts`
- P-02: `src/afk-manifest.test.ts`
- P-03: `src/mutation-report.test.ts`
- P-04: `src/mutation-report.test.ts`
- P-05: `src/mutation-report.test.ts`, `src/ship-gate.test.ts`
- P-06: `src/mutation-report.test.ts`

## Decisions made during implementation

- **`runMutationStep` returns the outcome untouched when neither path is
  declared.** B-06 says an omitted `baseline` labels every survivor
  `unattributed`, and B-09 says the step attributes on any `MUTATION_REPORTED`
  outcome. Taken together at the step level those would add
  `label: "unattributed"` to every survivor of every run — which breaks P-05's
  preserved `toEqual` assertions in `mutation-report.test.ts` and
  `ship-gate.test.ts`, whose survivors carry no label and whose diffs the DoD
  requires to be name-string-only. The reconciliation is B-11's own statement
  that a survivor carrying no label *means* `unattributed`: the step attributes
  when a path was declared, and `deriveMutationStepOutcome` supplies
  `unattributed` for everything else. B-05/B-06/B-07/B-08 are asserted at the
  pure-function level, which is where the manifest's `observableResult` puts
  them.
- **The `label ?? "unattributed"` default lives in
  `logger.ts:deriveMutationStepOutcome`, not in `formatMutationReportLines`.**
  The formatter appends a label only when one is present, so P-04's preserved
  formatter assertions keep their exact bullet strings while B-11's "a record
  with no label renders `unattributed`" still holds — one place substitutes, one
  place renders.
- **One shared path-rule helper rather than a third copy.** B-02 asks for the
  glob/absolute/traversal block to be shared. `normalizeMutationReportPath`
  takes the member name plus a singular and plural noun so `reportPath`'s
  existing messages come out byte-identical (P-02), and the two new members get
  the same three refusals with their own nouns.
- **The baseline matches on location, the decisions file matches on id.** The
  divergence is deliberate: `MutationSurvivor` and ADR 0071 already commit the
  decisions file to the tool's own id, and amending that ADR is a non-goal, so
  `decisionKey` uses `id` corroborated by `file` (ADR 0065) while `baselineKey`
  uses file + mutator + all four position numbers. The consequence of a
  renumbering tool is recorded in the doc comment on `decisionKey`: a stale
  `ACCEPT` can mislabel one bullet, and a label is text no gate reads.
- **Notes are keyed only on "present but unusable".** An absent baseline or
  decisions file produces no note, because a note for absence is a warning every
  project without those files would read on every run forever. `ABSENT` and
  `MALFORMED` therefore produce identical labels and are told apart only by the
  note — asserted as a pair.
- **`attributionNotes` is omitted rather than set to `[]`.** Same absence
  discipline `mutationReport` itself is under: the ship gate rewrites `afk.json`
  and the state writer round-trips the record, so an empty array would persist as
  a degradation record for a run that had none.

## Gotchas / learnings

- `trimUnclaimedMigrationPrefixes` needed no edit for B-03: it already rebuilds
  the manifest with `{ ...manifest, migrationPrefixes }`, so any member the
  parser returns survives the rewrite. The test is the thing that was missing,
  and it asserts the bytes on disk rather than the returned object — the returned
  object would pass even if the write dropped the keys.
- `logger.test.ts`'s `[behavior:#303:B-14] reads the outcome back out of the
  persisted stream` had to change: it compares the derived outcome with
  `toEqual`, and the derivation now supplies `label: "unattributed"`. It is not
  one of this slice's preserved tests, and the new expectation is exactly what
  B-11 specifies such a record means.
- `UNREADABLE` is observable without simulating a permission error by putting a
  **directory** at the declared path: `existsSync` is true and `readFileSync`
  throws `EISDIR`. That is how the "present but unusable" branch is reached in
  both the unit tests and the `runMutationStep` tests, with no mocking of
  `node:fs`.
- `baselineKey` originally joined its fields with a raw NUL character, which made
  `git diff` and `ripgrep` treat `src/mutation-report.ts` as a **binary** file.
  The separator is now a `KEY_FIELD` constant holding an *escaped* NUL rather
  than the character itself — same bytes in the key, and the source stays text.
- `ShipGateResult` has no `gates` member (only `verdict`, `failureReason`, `pr`),
  so B-12's "same gate results" is asserted through the teed `events.jsonl`
  projection (`gateSurface`) plus `failureReason`, not through the returned
  object.
- `src/orchestrator.ts` passes `config.manifest.mutationReport` into the gate
  structurally, so `MutationReportDeclaration` and `MutationReportConfig` gaining
  the same two optional members keeps it type-compatible with no edit outside
  this slice's file scope.
- No heavy suite exercises the mutation step's survivors — `orchestrator.test.ts`
  and `qa-orchestration.test.ts` mention "mutation" only in unrelated fixture
  names and a `RUN_STATE_VERSION` comment.
- The `tests` gate on the round-1 candidate reported one failure, in
  `src/qa-orchestration-gates.test.ts` (`shared-preview QA` →
  `[behavior:P-04] keeps deterministic and UAT findings isolated across a UAT
  retry`) — a file this slice never touches (`git diff` against
  `feat-claude-code/mutation-survivor-report` lists neither it nor
  `src/orchestrator.ts`), so no code path in this slice reaches it. Its failure
  mode is load-induced and self-amplifying: the stub provider asserts the
  shared-preview marker file equals `"verify\napply\n".repeat(n)`, so if attempt
  1's `applyMigrationCommand` never appends — `runHeartbeatCommand`'s
  inactivity timeout under a saturated host — the marker is permanently polluted
  with an extra `verify`, every later attempt's equality assertion fails on the
  stale prefix, and the infrastructure retry loop ends with
  `shared-preview infrastructure failed after 3 attempt(s)`. That is the exact
  message and the exact `'verify\nverify\napply\nverify\napply\n'` value the
  gate log recorded. A future round seeing it again should read it as host load,
  not as slice behavior; making the test resilient means asserting a suffix or
  resetting the marker per attempt, both edits to
  `src/qa-orchestration-gates.test.ts`, outside this slice's file scope.
