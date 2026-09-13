# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

## Resolved findings

- **QA-01 (BLOCKING) — seeded fixtures handed the role the answer key.** Cleared.
  All sixteen fixtures now open as their own document; the hand-authored HTML
  comment naming the case and stating its expected artifact is gone from every
  one. I reproduced `seedScratchDir` (`src/eval-command.ts:136-150`) byte-for-byte
  for all ten cases — inline values and `fromFile` copies alike — and grepped the
  materialized bytes for `**Verdict:**`, `**Failure class:**`, `"verdict"`,
  `FIX-BEFORE-SHIP`, `hand-reconstruct` and `<!--`. Every hit is either a
  prompt-template schema line (`- Include exactly one `**Verdict:** PASS | FAIL`
  line.`) or genuine content of the reconstructed document. The single seeded
  verdict declaration, `prd4-qa-a/.../qa-report-r1-a1.md:3 **Verdict:** FAIL` /
  `:4 **Failure class:** IMPLEMENTATION`, is the round-1 report and is the
  *opposite* of that case's expected `PASS` / `NONE`, so it is realistic input
  rather than a disclosure. Provenance moved to the case's `source` member and to
  a new `## Fixture provenance` section in `eval-packs/afk/README.md`; neither
  reaches the role, since `runCase` passes only `prompt` and the seeded scratch
  cwd (`src/eval-command.ts:189-194`).

  The guard is real, not decorative. `src/eval-packs.test.ts:385-416` scans every
  `fromFile` payload against nine disclosure patterns plus per-case
  verdict-declaration and bare-token shapes, and asserts the scanned set equals
  the whole `fixtures/` directory so no fixture escapes the scan. Mutation probe:
  I re-inserted the old header into `eval-packs/afk/fixtures/192-context-final.md`
  and the suite went red —
  `AssertionError: fixtures/192-context-final.md (seeded by 192-final-planner) carries an HTML comment: expected true to be false`,
  `Tests 2 failed | 20 passed (22)` — then restored the file (`git diff --stat`
  clean).

  The three `192-` cases remain decidable from their own material, which is what
  makes the removal a fix rather than a deletion of signal: `192-context-pre-restart-1.md`
  leaves the version-1 `gatePolicy` JSON shape UNKNOWN,
  `192-context-pre-restart-2.md:62-71` leaves the D5 waiver `path` matching rule
  UNKNOWN with two disagreeing in-repo precedents and names #195 and #193 as
  downstream readers, and `192-context-final.md:53-69` settles D5 and D6 and
  leaves only mechanical unknowns. ESCALATION / ESCALATION / CONTRACT follows from
  the contexts.

- **QA-02 (ADVISORY) — remaining provenance comments announced the fixture's role
  in an eval.** Cleared.
  `Select-String -Path eval-packs\afk\fixtures\* -Pattern '<!--','hand-reconstruct','eval-pack','fixture','Provenance','expected artifact','ESCALATION','should escalate','graded'`
  returns no disclosure. The hits that remain are the reconstructed documents'
  own vocabulary — `**Lock-Provenance:** negotiation round 2` in the committed
  PRD 4 contracts, `src/wave.fixtures.ts` rows in a change summary, `the exact
  tree the gates graded` in `prd4-qa-a-contract.md:38` — which the test's patterns
  deliberately anchor around (`src/eval-packs.test.ts:110-135`).
  `src/eval-packs.test.ts:418-428` asserts each seeded fixture's first line is
  `# <heading>` (or `{` for JSON), and `:430-453` asserts the README names every
  seeded fixture.

## Findings

None.

## Evidence detail

**Pre-QA commands.**
`pnpm install --frozen-lockfile` — PASS, exit 0, `Done in 8.4s using pnpm v10.33.0`.
`pnpm run typecheck` (`tsc --noEmit`) — PASS, no diagnostics. I ran typecheck
myself rather than resting on the skip authorization
(`.afk/logs/.../gates/s02/attempt-f4d1e11736f1.json`, tree
`289e50e79987341abcbb60966a3334e5e741b65c`, PASS at 2026-09-12T23:02:55.429Z),
because probing touched the tree; the two agree.
`pnpm vitest run src/eval-packs.test.ts` — 22 passed, 881ms. The full suite is
the orchestrator's to run after this stage.

**Behaviors.** `readEvalPack("eval-packs/afk")` resolves with nine cases in
`01-`…`09-` order, roles `planner ×3, evaluator-contract, evaluator-qa,
evaluator-contract ×2, evaluator-qa ×2` and `expected` values
`{"artifact":"ESCALATION"}`, `{"artifact":"ESCALATION"}`,
`{"artifact":"CONTRACT"}`, `{"verdict":"ACCEPT"}`,
`{"verdict":"FAIL","failureClass":"IMPLEMENTATION"}`, `{"verdict":"ACCEPT"}` ×2,
`{"verdict":"PASS","failureClass":"NONE"}` ×2 — matching B-01 to B-05 exactly
(probed directly through the built reader, not only through the test).
B-05's assertion is honest in the strong sense: it reads the verdict artifact
path *out of each case's `source`* and deep-compares against the committed
`contract-review.json` / `qa-review.json` on disk
(`src/eval-packs.test.ts:281-327`), so an `expected` edited away from the merged
verdict fails. B-06's `EXPECTED_SHAPE` assertion is likewise not vacuous: I
confirmed the role swap throws on `expected`, not on the role —
`x.json expected declares the key "artifact", which role evaluator-final never
projects (verdict)`.

**Boundary compliance.** The slice's own commits (`e9eb1a3~1..HEAD`) change 39
files. Twenty-eight are exactly the contract's declared list; the other eleven
are pipeline-owned artifacts inside
`.kiro/specs/afk-v2-agent-eval-harness/slices/02-eval-seed-pack/` (contract,
manifest, context, feedback, handoff, review artifacts). Nothing else. No
amendment is needed. The manifest spells the index file
`eval-packs/afk/readme.md` where the committed file is `README.md`; the file-scope
comparison is case-insensitive (`normalizePath`,
`src/acceptance-manifest.ts:71`), so this is cosmetic and not a finding.

**Preservation.** P-01: `src/eval-packs.test.ts` is the only `src/` path in the
slice diff; no runner module changed. P-02:
`eval-packs/fixtures/refused/01-unknown-member.json` does not appear in the slice
diff and `readEvalPack` still refuses it for the unknown `notes` member
(`src/eval-packs.test.ts:587-596`, passing). P-03: neither `CONTEXT.md` nor
`ARCHITECTURE.md` appears in the slice diff, and the vocabulary assertions at
`:598-614` pass.

**B-10.** `dispatchArguments` (`src/eval-packs.test.ts:621-640`) parses every
`runEvalCli(` argument list in every `src/*.test.ts` by parenthesis matching and
asserts none contains `eval-packs/afk` or `AFK_PACK`, so a pack path spelled
across lines is still caught. The only dispatch in the file targets
`CONSUMER_PACK_DIR` through `buildEvalStubProvider`, and B-09 reads `MATCH` /
`MISMATCH` back out of `report.json` via `readEvalReport` rather than off the
in-memory result.

**Quality.** The test file's header explains why the AFK pack is read and never
dispatched, the disclosure patterns carry a comment for each anchoring decision,
and the guard includes a self-check that plants the historical header and asserts
at least six patterns trip (`:441-452`) — a lock against the patterns being
loosened into uselessness later. No mock is asserted against itself; every
assertion reads committed bytes or the runner's own output.
