# Handoff — Eval seed pack (#263)

## What shipped

- B-01: `eval-packs/afk/01-192-pre-restart-1-planner.json` … `eval-packs/afk/09-prd4-qa-b.json` (nine case files, `NN-` prefixed); asserted by `src/eval-packs.test.ts:the committed eval packs > B-01`
- B-02: `eval-packs/afk/01-192-pre-restart-1-planner.json`, `eval-packs/afk/02-192-pre-restart-2-planner.json`, `eval-packs/afk/03-192-final-planner.json` with `eval-packs/afk/fixtures/192-context-pre-restart-1.md`, `192-context-pre-restart-2.md`, `192-context-final.md`, `192-prd4-excerpt.md`, `192-issue-84.md`
- B-03: `eval-packs/afk/04-194-f03-evaluator-contract.json` with `eval-packs/afk/fixtures/194-contract.md`, `194-acceptance-manifest.json`, `194-feedback-r1-a1.md`
- B-04: `eval-packs/afk/05-120-candidate-typecheck-evaluator-qa.json` (inline `files` only)
- B-05: `eval-packs/afk/06-prd4-contract-a.json`, `07-prd4-contract-b.json`, `08-prd4-qa-a.json`, `09-prd4-qa-b.json` with `eval-packs/afk/fixtures/prd4-contract-a-contract.md`, `prd4-contract-a-acceptance-manifest.json`, `prd4-contract-b-contract.md`, `prd4-contract-b-acceptance-manifest.json`, `prd4-qa-a-contract.md`, `prd4-qa-a-change-summary.md`, `prd4-qa-b-contract.md`, `prd4-qa-b-change-summary.md`
- B-06: every case's `source` member across the nine files above; asserted by `src/eval-packs.test.ts:the committed eval packs > B-06`
- B-02 / B-03 / B-05 (round 2): every `fromFile` payload under `eval-packs/afk/fixtures/` is now the reconstructed document alone; asserted over the seeded bytes by `src/eval-packs.test.ts:B-02 B-03 B-05 seed no fixture that names its eval case or states that case's answer` and `…give each seeded fixture bytes that open as the reconstructed document itself`
- B-06 (round 2): the removed per-fixture provenance now lives in `eval-packs/afk/README.md`'s `## Fixture provenance` section and in the three `192-` cases' `source` members; asserted by `src/eval-packs.test.ts:B-06 records fixture provenance in the source member and the README, where the role never reads it`
- B-07: `eval-packs/afk/README.md`
- B-08: `eval-packs/fixtures/consumer-governance/01-pm-governance.json`
- B-09: `src/eval-packs.test.ts:B-09 the consumer pack dispatched to the eval stub` (`dispatch` → `runEvalCli` → `readEvalReport`)
- B-10: `src/eval-packs.test.ts:dispatchArguments` and the `B-10` test that scans every `src/**/*.test.ts`
- P-01: `src/eval-packs.test.ts:P-01` over `readEvalPack` / `validateEvalCase`
- P-02: `src/eval-packs.test.ts:P-02` over `eval-packs/fixtures/refused/01-unknown-member.json` (unmodified)
- P-03: `src/eval-packs.test.ts:P-03` over `CONTEXT.md` and `ARCHITECTURE.md` (both unmodified)

New migration files: 0

## Decisions made during implementation

- **The QA cases state what they cannot reach.** `prompts/evaluator-qa.md`
  tells the reviewer to read the slice's `acceptance-manifest.json` and to run
  the pre-QA commands. The locked fixture list for `08-` and `09-` carries no
  manifest, and an eval case cannot spawn a command, so each prompt's
  `# Assigned Scope` slot says both explicitly and supplies the recorded
  command results and the base-gate authorization (timestamps, attempt id,
  tree id) as given facts. Without that, the expected `PASS` would rest on
  material the case never handed the model.
- **`08-`'s `PASS` needs the fixes visible, so they are inlined.** The graded
  verdict resolves QA-01…QA-03 from round 1. Inline `files` may name any path,
  so the case carries faithful excerpts of `src/qa-review.ts`,
  `src/qa-orchestration.test.ts` and the slice `handoff.md` rather than
  `fromFile` fixtures outside the locked list.
- **`09-` is the deliberate "PASS / NONE with an OPEN ADVISORY" exemplar**, and
  is rendered to match the committed `qa-review.json` exactly, including the
  advisory about the `qa-orchestration` budget margin.
- **The README quotes each `source` verbatim**, wrapping only, and the B-07
  assertion compares with whitespace collapsed. The first draft backticked
  paths inside the quoted sources; a containment assertion cannot see through
  added markup, and paraphrase in an index is how an index goes stale.
- **B-10 is asserted by self-scan, not by convention.** The test extracts every
  `runEvalCli(` argument list under `src/` by paren matching and refuses one
  containing `eval-packs/afk` or the `AFK_PACK` constant, so the pack path
  reaches `readEvalPack` and nothing else.
- **`06-`…`09-`'s `expected` is compared against the committed artifact, not
  against a literal.** The B-05 test reads
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/<slice>/contract-review.json`
  and `qa-review.json` and asserts the case agrees with the file, which is what
  "took `expected` from that artifact" means.

- **A seeded fixture carries no bookkeeping at all (QA-01, QA-02).** Round 1
  opened eight of the sixteen fixtures with a hand-authored HTML comment naming
  the case, the reconstruction and — in four of them — the graded answer. A
  `fromFile` payload is `copyFileSync`'d into the scratch directory and the
  prompt orders the role to read it, so every byte of it is prompt. All eight
  headers were removed rather than reworded: the two homes a role never reads
  are the case's `source` member and the README, and the README's new
  `## Fixture provenance` section carries every removed sentence, so nothing
  about how a fixture was rebuilt was lost.
- **The disclosure scan anchors on the noun, not the word.** A blanket ban on
  `graded`, `Provenance`, `PASS` or `FAIL` would fire on the real PRD 4
  contracts the `06-`…`09-` cases seed, which say "the exact tree the gates
  graded", carry a `**Lock-Provenance:**` line and use the gate outcomes on
  nearly every page. `FIXTURE_DISCLOSURES` therefore matches
  `(?:expected|graded) (?:artifact|verdict|outcome|answer)` and `^provenance:`,
  and the expected-value check is a bare token only for `ESCALATION`,
  `CONTRACT` and `ACCEPT` — words no seeded document uses — while `PASS` and
  `NONE` are checked as verdict declarations (`**Verdict:** PASS`,
  `"verdict": "PASS"`, `verdict is PASS`).

## Gotchas / learnings

- The worktree had no `node_modules`; `pnpm install --frozen-lockfile` is a
  prerequisite for `pnpm vitest` here.
- `runEvalCli` returns exit code `0` whenever a report was written — a
  `MISMATCH` is data, not a failure. Only a refused pack (`2`) or a mid-run
  throw (`1`/`2`) is non-zero, so an exit-code assertion cannot stand in for a
  `report.json` outcome assertion.
- `projectOne` (`src/eval-compare.ts:97`) finds the artifact by recursive
  name search, so the guardian stub writing `review-pm.md` at the scratch root
  matches even though the consumer case's prompt asks for it under
  `specs/checkout-reminders/`. It throws when more than one file matches, which
  is why no seeded `files` key is named `review-pm.md`.
- `validateExpected` refuses a key the role never projects and a value outside
  the role's list, so re-validating a case under a different `role` is a cheap
  way to prove `expected` is role-checked rather than shape-checked.
- Nothing in a case file is invisible to the model except `source`. `id`,
  `role` and `expected` are the runner's, but `prompt` and every `files` value —
  inline string or `fromFile` payload — reach the role verbatim. A future pack
  author writing "as reconstructed from…" anywhere but `source` is writing it
  into the prompt.
- Two fixtures (`194-acceptance-manifest.json`,
  `prd4-contract-*-acceptance-manifest.json`) are checked out CRLF while the
  Markdown fixtures are LF, so any byte assertion over fixture text has to
  tolerate both line endings.
- The three `192-` cases share the `192-prd4-excerpt.md` and `192-issue-84.md`
  fixtures; `fromFile` targets are per-case paths, not per-case files, so one
  fixture can serve every case that quotes the same material.
