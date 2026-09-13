# Context — Slice 02: Eval seed pack (#263)

## Files and current behavior

- FACT: The write boundary for this slice is `eval-packs/afk/*.json`,
  `eval-packs/afk/fixtures/*`, `eval-packs/afk/README.md`,
  `eval-packs/fixtures/consumer-governance/*.json`, and
  `src/eval-packs.test.ts` (new). No `src/*.ts` production file, `CONTEXT.md`,
  or `ARCHITECTURE.md` changes. Cited: `gh issue view 263` "Files expected to
  change"; `prd.md` file-scope map (lines 706-725, S2 column).
- FACT: Today `eval-packs/` contains exactly one file,
  `eval-packs/fixtures/refused/01-unknown-member.json` (from slice 01, B-28) —
  a deliberately malformed pack used by the runner's refusal tests. Cited:
  `Glob eval-packs/**`.
- FACT: `eval-packs/afk/` and `eval-packs/fixtures/consumer-governance/` do
  not exist yet. Cited: same glob (no matches for either path).
- FACT: The refused fixture's shape —
  `{ version, id, role, source, prompt, files, expected, notes }` with `notes`
  as the one unknown top-level member — is in
  `eval-packs/fixtures/refused/01-unknown-member.json:1-12`.
- FACT: The reader this slice's packs must satisfy is `readEvalPack` /
  `validateEvalCase` in `src/eval-pack.ts:296-371` / `:230-283`. A valid case
  is exactly the seven members `CASE_KEYS` (`src/eval-pack.ts:84-92`):
  `version, id, role, source, prompt, files, expected` — no eighth member (the
  refused fixture's `notes` is what makes it refused, not a template to copy).
- FACT: `EVAL_ROLES` (`src/eval-pack.ts:36-43`) is `evaluator-contract,
  evaluator-qa, evaluator-final, planner, pm, architect`. `EXPECTED_SHAPE`
  (`src/eval-pack.ts:102-118`) fixes exactly which keys/values `expected` may
  hold per role — matches `prd.md` D9's table (lines 255-262).
- FACT: `id` must match `/^[a-z0-9][a-z0-9-]{0,79}$/` and be unique within the
  pack (`src/eval-pack.ts:94`, enforced at `:348-354`). `source`/`prompt` must
  be non-blank (`requireNonBlank`, `:138-147`, called at `:278-279`).
- FACT: `files` keys and `fromFile` targets are relative POSIX paths — no
  backslash, no drive letter, no leading `/` or `./`, no `..` segment, no
  trailing `/` (`pathDefect`, `src/eval-pack.ts:125-136`). A `fromFile` target
  must exist on disk relative to the pack dir at read time
  (`src/eval-pack.ts:358-366`).
- FACT: Only files directly inside the pack directory (not subdirectories) are
  scanned as cases, sorted byte-wise ascending by filename
  (`byBytes`, `src/eval-pack.ts:286-308`) — this is why case files need a
  two-digit numeric prefix (`01-`, `02-`) per the acceptance criteria.
- FACT: `eval-packs/fixtures/refused/01-unknown-member.json` already follows
  the `NN-` prefix convention slice 01 established.
- FACT: The archived incident directories the issue and `prd.md` D2 cite as
  prompt-reconstruction inputs —
  `.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/` and
  `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/reviews/`
  — do **not exist in this worktree**. Cited: `Test-Path` on both paths
  returned `False`. `.gitignore:3` ignores `.afk/`, and `prd.md` (lines
  129-137) says these live "in the operator's checkout," not on any branch.
- FACT: `prompts/planner.md`, `prompts/evaluator-contract.md`, and
  `prompts/evaluator-qa.md` exist in this worktree (needed to render each
  case's `prompt` per the issue's "prompt rendered from `prompts/X.md`"
  language). Cited: `Glob prompts/{planner,evaluator-contract,evaluator-qa}.md`.
- FACT: `normalizePath` (`src/acceptance-manifest.ts:64-71`) lowercases the
  path (`:71`) before comparing — the fact #194's F-03 finding is factually
  wrong about, per `prd.md` line 546 ("F-03 was the only BLOCKING finding and
  its premise is false").

## Patterns and test harness

- FACT: The stub provider and artifact builders this slice's tests must
  dispatch through are in `src/eval.fixtures.ts`
  (`buildEvalStubProvider`, `:85-121`); it records one `EvalStubInvocation`
  per call (`:53-66`) and consumes `behaviors` by index, repeating the last
  one (`:106-107`).
- FACT: `writeEvalGuardianReview(cwd, "pm", outcome)`
  (`src/eval.fixtures.ts:228-262`) writes `review-pm.md` with a
  `**Verdict:** <outcome>` line and a structured-findings JSON block — this is
  what the consumer-governance pack's test dispatch needs to assert `MATCH`
  (outcome `FIX-BEFORE-SHIP`) vs `MISMATCH` (outcome `SHIP`).
- FACT: `evalCaseDocument(overrides)` (`src/eval.fixtures.ts:282-295`) and
  `writeEvalPackDir(files, prefix)` (`:327-342`) are the existing helpers for
  building an in-memory pack for tests; `writeEvalRolePack` (`:345-357`)
  builds a one-case pack per role. These are test-authoring helpers for
  *ad hoc* packs in `src/*.test.ts`, distinct from the on-disk
  `eval-packs/afk/` and `eval-packs/fixtures/consumer-governance/` this slice
  must create as committed files.
- FACT: `EVAL_ROLE_EXPECTED` and `EVAL_ROLE_MATCHING_ARTIFACT`
  (`src/eval.fixtures.ts:298-319`) give the default `expected` and a
  matching-artifact writer per role — useful reference for what a
  `MATCH`-producing behavior looks like per role, though the consumer pack
  case here expects `FIX-BEFORE-SHIP`, which is not one of the defaults.
- FACT: `readEvalReport` and `writeEvalReport` are exported from
  `src/eval-report.ts` (file header + `EVAL_REPORT_VERSION`,
  `src/eval-report.ts:21`); `EvalCaseResult.outcome` is one of `MATCH`,
  `MISMATCH`, `NOT-RUN`, `ERROR` (`src/eval-report.ts:26`). The acceptance
  criteria require reading `report.json` back through `readEvalReport` to
  assert the consumer pack's `MATCH`/`MISMATCH` outcomes.
- FACT: `readEvalPack`'s `roleDispatch` re-export
  (`src/eval-pack.ts:373-378`) and its home in `src/eval-compare.ts` are how a
  dispatched case's artifact is looked up and projected — this slice does not
  call these directly in production code (no `src/*.ts` change), but its test
  file `src/eval-packs.test.ts` will exercise the same path
  `runEvalCli`/dispatch tests in slice 01 use.
- FACT: `src/eval-pack.test.ts`, `src/eval-command.test.ts`,
  `src/eval-compare.test.ts`, `src/eval-report.test.ts`, and
  `src/eval-boundary.test.ts` are slice 01's existing test files; this slice
  adds a new file, `src/eval-packs.test.ts` (plural — distinct from
  `eval-pack.test.ts`), rather than editing any of them. Cited: `Glob
  src/eval*.ts` (no `eval-packs.test.ts` yet) and the issue body's "Tests"
  section.
- FACT: Per `AGENTS.md`/`CLAUDE.md` and `prd.md` Testing decision 5, this
  slice adds no spawned pipeline scenario; all its assertions are unit-shaped
  reads of `readEvalPack` plus one stub dispatch of the consumer pack.
  Command for iterating: `pnpm vitest run src/eval-packs.test.ts`, or
  `pnpm test:fast` before handoff (per `CLAUDE.md`'s AFK-slice-agent rule —
  never the full `pnpm test` as a slice agent).
- INFERENCE: Because `readEvalPack` validates `expected` against `role` at
  read time (`src/eval-pack.ts:191-222`) and refuses on any schema defect
  naming the file, a case file this slice authors that violates a shape rule
  will fail loudly in `readEvalPack("eval-packs/afk")`, which is one of the
  slice's own required tests — so schema mistakes are self-detecting via the
  first acceptance criterion. Drawn from: `src/eval-pack.ts:230-283`, the
  acceptance criteria's "`readEvalPack` accepts `eval-packs/afk/`" bullet.

## Unknowns

- UNKNOWN: The archived artifacts `prd.md` D2 and the issue cite as
  prompt-reconstruction sources (#192's `planner-escalation.md`/`context.md`
  under `.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/`; #194's
  `contract-review-r1-a1.json`, `feedback-r1-a1.md`, `contract.md`,
  `acceptance-manifest.json` under
  `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-01/reviews/`;
  PRD 4's `reviews/` directories for slices 01-08) are not present in this
  worktree and are gitignored everywhere. Whether the generator agent running
  this slice has access to the "operator's checkout" `prd.md` refers to, or
  must reconstruct prompts from the excerpts already quoted inside `prd.md`,
  #192, and #194 (the issue body and `prd.md` do quote some content inline,
  e.g. the false-premise fact and ADR 0041's incident), is not resolved here.
- UNKNOWN: Whether #194 (the false-premise contract case) yields one or two
  cases is left open by both the issue ("one or two") and `prd.md` ("1-2
  cases") — explicitly a slice decision per `decisions-review.md` §5, not
  resolvable from repo evidence alone.
- UNKNOWN: Exactly which of PRD 4's slices' archived `contract-review-r*-a1`
  and `qa-review-r*-a1` verdicts were later "borne out" by a human (merged, or
  accepted in a `REVISE`-acceptance) cannot be determined from this worktree,
  since the run/review artifacts themselves are not present. `prd.md` only
  lists file counts per slice (lines 129-137), not verdict content or outcome
  confirmation.
- UNKNOWN: The exact byte content of the fixture consumer pack's `PRODUCT.md`
  and diff `files`, and the exact wording of each `source` string, are
  explicitly left to this slice's authorship (`decisions-review.md` §5, `prd.md`
  line 682) and are not derivable from existing code.
