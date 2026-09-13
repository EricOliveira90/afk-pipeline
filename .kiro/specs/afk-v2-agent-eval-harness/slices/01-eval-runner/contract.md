# Slice Contract — Eval runner

**Parent PRD:** .kiro/specs/afk-v2-agent-eval-harness/prd.md
**GH issue:** #262
**Status:** LOCKED

**Lock-Provenance:** negotiation round 3
**Negotiation round:** 1

## Scope lock

`afk eval` ships as a report-only runner in four new modules plus a test stub:
`readEvalPack` reads a directory of `*.json` eval cases and refuses the whole
pack on any schema defect naming the file and the member (`prd.md` D7, D8, D12,
D13); `src/eval-command.ts` dispatches each case sequentially in declared order
through `AgentProvider.invoke` into a fresh scratch directory seeded from the
case's `files`, honours a whole-run `--max-calls` budget, projects the role's
written artifact through the production parser and compares it field-by-field
with `expected` (D9, D14–D16, D19, D31, D34); `src/eval-report.ts` writes a
versioned `report.json` plus one per-case log under `<out>/eval-<timestamp>/`
and formats the two stdout shapes with no rate, ratio or percentage anywhere
(D20, D22, D23, D24); and the exit code is non-zero if and only if no
`report.json` exists for the run (D21). All three CLI entries gain an `eval`
branch before `parsePipelineRuntimeOptions` (D32, D33). The runner touches no
git, no `RunState`, no `RunJournal` and no `run-events` type, and
`src/orchestrator.ts` and `src/wave.ts` are not edited (D34, ARCHITECTURE.md
hubs rule). **Affordability of the stub is a scope decision taken here:**
`src/eval.fixtures.ts` builds its schema-valid artifacts by importing the
existing builders — `writeContractReview` and `writeQAReview`
(`src/test-support.ts:33,100`), `writeAcceptanceManifest`
(`src/orchestrator.fixtures.ts:326`) and `REVISION_PLANNER_ESCALATION`
(`src/orchestrator.fixtures.ts:48`) for the escalation sentinel — and
hand-authors only the three artifacts no builder exists for: `final-review.json`
(five fields, `src/final-evaluation.ts:354`) and the two guardian markdown
reviews, which have no schema because `parseGuardianReview` never throws
(`src/artifacts.ts:308`). No fixture in this slice re-derives a JSON schema by
hand. **Where the refusing packs live is a scope decision taken here:** the
roughly fourteen refusing packs B-02–B-07 need are each constructed in a
per-test temporary directory (an `mkdtemp` directory holding the case files that
test writes) and none of them is committed;
`eval-packs/fixtures/refused/01-unknown-member.json` (B-28) is the only
committed pack this slice adds. The file scope under "Files expected to change"
is therefore exhaustive as written and the definition of done's `git status`
clause holds — `prd.md`'s `eval-packs/fixtures/refused/*.json` row allows more
committed refusal packs, and this slice deliberately commits exactly the one
D2 names (an unknown top-level member).

### In scope

- [behavior:B-01] `src/eval-pack.ts` exports `EVAL_PACK_VERSION`,
  `SUPPORTED_EVAL_PACK_VERSIONS`, `EVAL_ROLES`, `EvalRole`, `EvalCase`,
  `EvalExpected`, `EvalPack`, `readEvalPack(dir)` and the pure
  `validateEvalCase(value, source)`; `readEvalPack` returns the cases of a
  directory whose `*.json` files each carry exactly the seven members
  `version`, `id`, `role`, `source`, `prompt`, `files`, `expected`, in byte-wise
  ascending file-name order, scanning only files directly inside the directory
  (`prd.md` D7, D8; #262 AC1).
- [behavior:B-02] A case file with an unknown top-level member or a missing
  member refuses the whole pack with an error naming the file and the member;
  both packs — and every refusing pack of B-03–B-07 — are written into a
  per-test temporary directory, not committed (scope lock; `prd.md` D7;
  #262 AC2).
- [behavior:B-03] A `version` outside `SUPPORTED_EVAL_PACK_VERSIONS` (`[1]`,
  `EVAL_PACK_VERSION = 1`), or two case files that disagree on `version`,
  refuses the whole pack naming the file — the
  `GATE_EVIDENCE_VERSION`/`SUPPORTED_GATE_EVIDENCE_VERSIONS` precedent
  (`src/gate-runner.ts:43-46`, `prd.md` D13; #262 AC3).
- [behavior:B-04] A `role` outside `EVAL_ROLES` (`evaluator-contract`,
  `evaluator-qa`, `evaluator-final`, `planner`, `pm`, `architect`) refuses the
  whole pack naming the file and the value (`prd.md` D12; #262 AC4).
- [behavior:B-05] `expected` is validated against the case's `role` at read
  time: a missing key, an extra key, or a value the role's parser could never
  produce refuses the whole pack naming the file and the key (`prd.md` D9;
  #262 AC5).
- [behavior:B-06] A `files` key that is absolute, contains a `..` segment,
  starts with `./` or `/`, or carries a drive letter refuses the pack; a
  `{ "fromFile": … }` target resolved relative to the case file that does not
  exist refuses the pack at read time, before any dispatch (`prd.md` D7;
  #262 AC6).
- [behavior:B-07] A duplicate `id`, an `id` outside
  `^[a-z0-9][a-z0-9-]{0,79}$`, a blank `source`, a blank `prompt`, or a
  directory with zero case files refuses the pack (`prd.md` D7; #262 AC7).
- [behavior:B-08] Each dispatched case runs with `InvokeOptions.cwd` set to a
  fresh directory created under the OS temp directory with prefix
  `afk-eval-<id>-` and seeded from `files` only: inline values written as UTF-8
  bytes unchanged and `fromFile` values copied byte-for-byte, with no other
  entry present. The declared test case's `expected` deliberately differs from
  what the stub writes, so its outcome is `MISMATCH` and B-17 keeps the
  directory for the assertion to read after `runEvalCli` returns (`prd.md` D34;
  #262 AC8).
- [behavior:B-09] `roleDispatch(role)` returns the D9 row — the `InvokeOptions`
  template, the artifact filename, the parser and the projection — and the
  runner dispatches from it: `pm`/`architect` with `role` and `agent` both
  `pm-review`/`architect-review` and `bare: true`
  (`src/ship-gate.ts:707,754`), the planner and the three evaluators with no
  `agent` and no `bare`, every case with `prompt`, `cwd` and a `logStream`
  opened on `<out>/eval-<timestamp>/<case-id>.log` (`prd.md` D9; #262 AC9).
- [behavior:B-10] For `evaluator-contract`, `evaluator-qa` and
  `evaluator-final`, `projectOutput(role, scratchDir)` in `src/eval-compare.ts`
  reads `contract-review.json`, `qa-review.json` or `final-review.json` found
  recursively in the scratch directory and parses it with the unmodified
  production `parseContractReview` (`src/contract-review.ts:369`),
  `parseQAReview` (`src/qa-review.ts:346`) or `parseFinalReview`
  (`src/final-evaluation.ts:305`), projecting `verdict` only — plus
  `failureClass` for `evaluator-qa` — and no findings, ids, prose or tree ids
  (`prd.md` D9; #262 AC10).
- [behavior:B-11] For `planner`, a `planner-escalation.md` that
  `readPlannerEscalation` (`src/planner-escalation.ts:125`) reads as
  `{ kind: "escalation" }` projects to `{ artifact: "ESCALATION" }`; no
  sentinel plus exactly one `acceptance-manifest.json` accepted by
  `parseAcceptanceManifest` (`src/acceptance-manifest.ts:201`) with a
  `contract.md` beside it projects to `{ artifact: "CONTRACT" }`; a
  `{ kind: "malformed" }` sentinel is `ERROR` carrying the defect (`prd.md` D9;
  #262 AC11).
- [behavior:B-12] For `pm` and `architect`, `review-pm.md` or
  `review-architect.md` is parsed with `parseGuardianReview(content, kind)`
  (`src/artifacts.ts:308`) and the projection is its `outcome`;
  `UNPARSEABLE` is compared as a value, so an `UNPARSEABLE` actual against an
  expected `SHIP` is a `MISMATCH` and never an `ERROR` (`prd.md` D9; #262 AC12).
- [behavior:B-13] Zero matching artifact files in the scratch directory is
  `ERROR` naming the filename searched for and more than one is `ERROR`
  listing them; a parser that throws is `ERROR` carrying the parser's message;
  a non-zero `InvokeResult.exitCode` is `ERROR` naming the code without
  consulting the artifact. Each is a per-case outcome: the run still writes
  `report.json` and exits 0 (`prd.md` D9, D21, D23; #262 AC13).
- [behavior:B-14] A rejected `invoke` — including a transient provider error —
  is `ERROR` carrying the rejection message, `invoke` is called exactly once
  with no retry, and the case counts as one call in `callsUsed` (`prd.md` D9,
  D14; #262 AC14).
- [behavior:B-15] `--max-calls <n>` is a whole-run budget checked before each
  dispatch: with `--max-calls 2` over a three-case pack the first two cases are
  dispatched, the third is `NOT-RUN`, `callsUsed` is 2 and `report.json`
  `status` is `INCOMPLETE`; with no flag the budget is 50 and no pack member or
  config key can change it (`prd.md` D15, D16; #262 AC15).
- [behavior:B-16] `--max-calls 0`, a non-integer `--max-calls`, or a missing
  `--pack` is a usage error: exit code 2, no `report.json`, and the usage text
  in the returned `output` (`prd.md` D15, D21; #262 AC16).
- [behavior:B-17] `compareProjection(expected, actual)` is field-by-field
  string equality returning `MATCH` or `MISMATCH`; the scratch directory is
  removed after a `MATCH` and kept after a `MISMATCH` or an `ERROR`, with its
  path recorded as that case's `scratchDir` in `report.json` (`prd.md` D9, D34;
  #262 AC17).
- [behavior:B-18] `src/eval-report.ts` exports `EVAL_REPORT_VERSION`,
  `EvalReport`, `EvalCaseResult`, `EvalOutcome`, `writeEvalReport(dir, report)`
  and `readEvalReport(path)`; `report.json` carries `version` 1, `status`,
  `provider`, `pack`, `packVersion`, `startedAt`, `finishedAt`, `maxCalls`,
  `callsUsed`, `counts` with exactly the four keys `MATCH`, `MISMATCH`,
  `NOT-RUN`, `ERROR`, and `cases` in declared order; `readEvalReport` reads it
  back and refuses a `version` other than 1 (`prd.md` D13, D20; #262 AC18).
- [behavior:B-19] Each entry in `cases` carries exactly these keys and no
  other: `id`, `role`, `source`, `outcome`, `expected` and `callsUsed` (0 or 1)
  always; `actual` if and only if the outcome is `MATCH` or `MISMATCH`; `error`
  if and only if it is `ERROR`; `scratchDir` if and only if it is `MISMATCH` or
  `ERROR` (B-17); `durationMs` if and only if the case was dispatched; and
  `costUsd`/`toolCallCount` only as B-20 allows. This list is exhaustive — it
  is what `EVAL_REPORT_VERSION = 1` locks (`prd.md` D20; #262 AC19).
- [behavior:B-20] A case's `costUsd` and `toolCallCount` are present only when
  the provider reported them in `InvocationStats` and are absent, never 0,
  otherwise; the top-level `costUsd` is present only when every dispatched case
  reported one and is their sum (`prd.md` D14, D20; #262 AC20).
- [behavior:B-21] `formatEvalSummary(report, reportPath)` returns exactly
  `afk eval <status>: MATCH <n> / MISMATCH <n> / NOT-RUN <n> / ERROR <n> —
  calls <used>/<max> — <path>`, and neither `report.json` nor any line the
  runner emits contains a pass rate, ratio or percentage. The summary line is
  carried in `runEvalCli`'s returned `output` and is never passed to
  `deps.stdout`, so the CLI printing `output` cannot repeat a streamed line:
  `deps.stdout` carries the per-case lines of a dispatched run and nothing
  else, while `output` carries the summary line on a completed run, the
  `--dry-run` case list (B-25), or the refusal, usage or error text on a
  non-zero exit (`prd.md` D20, D24; #262 AC21).
- [behavior:B-22] `formatCaseLine(k, n, result)` returns
  `[<k>/<n>] <id> (<role>) <outcome>` and exactly one such line is passed to
  `deps.stdout` as each case completes, in declared order (`prd.md` D20;
  #262 AC22).
- [behavior:B-23] A run whose every case is `MISMATCH` exits 0 with
  `report.json` written, and a run stopped by the cap exits 0 with
  `report.json` written and `status` `INCOMPLETE` (`prd.md` D21; #262 AC23,
  AC24).
- [behavior:B-24] Exit 2 covers every failure that dispatched nothing — a
  refused pack (the error naming the file and the member in `output`), a usage
  error, and an `--out` directory that cannot be created — each with no
  `report.json`. Exit 1 covers a throw from the runner's own seams after
  dispatch began; the declared trigger is an injected `deps.stdout` that throws
  on the first per-case line, after the first case was dispatched, which
  returns exit code 1 with no `report.json` written. The two are exclusive:
  every provider-side failure is absorbed as a per-case `ERROR` (B-13, B-14),
  so only a runner-seam throw reaches exit 1 (`prd.md` D21; #262 AC25).
- [behavior:B-25] `--dry-run` reads and validates the pack, returns one
  `<id> (<role>) — <source>` line per case in `output`, dispatches nothing,
  creates no output directory and exits 0 for a valid pack or 2 for a refused
  one (`prd.md` D21; #262 AC26).
- [behavior:B-26] `src/eval-command.ts` exports
  `runEvalCli(args: readonly string[], repoRoot: string, provider: AgentProvider,
  deps: EvalCliDeps = DEFAULT_EVAL_DEPS): Promise<{ output: string; exitCode: 0 | 1 | 2 }>`
  with `EvalCliDeps` carrying `now()`, `mkScratchDir(id)` and `stdout(line)`;
  `--out <dir>` defaults to `<repoRoot>/.afk/eval` and each run creates
  `<out>/eval-<YYYYMMDD-HHmmss>/`. All three entries gain
  `if (args[0] === "eval")` before `parsePipelineRuntimeOptions`, in the
  `stop`/`adopt` pattern (`src/afk.ts:72-86`), delegating to `runEvalCli` with
  that entry's provider (`kiroProvider` for `afk`, Claude for `afk-claude`,
  Codex for `afk-codex`), printing `output` on exit 0 and to stderr otherwise,
  and each `usage()` gains one line containing
  `eval --pack <dir> [--max-calls <n>] [--out <dir>] [--dry-run]` (`prd.md`
  D32, D33; #262 AC27).
- [behavior:B-27] A source-level test in `src/eval-boundary.test.ts` scans a
  stated set — every `src/*.ts` file whose name matches neither `*.test.ts` nor
  `*.fixtures.ts`, minus the four `src/eval-*.ts` modules and the three CLI
  entries — and asserts no file in that set imports `./eval-pack.js`,
  `./eval-compare.js`, `./eval-report.js` or `./eval-command.js`, listing any
  offender it finds; in particular the set contains and the assertion covers
  `src/orchestrator.ts`, `src/wave.ts`, `src/ship-gate.ts`, `src/preship.ts`,
  `src/gate-runner.ts`, `src/base-gates.ts`, `src/candidate-gate-phase.ts` and
  `src/post-qa-gates.ts`. **The scanned set is declared here rather than left to
  the implementer**, because it decides what the `acceptance:behaviors` gate for
  B-27 is evidence of: `src/eval.fixtures.ts` is outside the set as a
  test-support module — the `*.fixtures.ts` sibling of
  `src/orchestrator.fixtures.ts` — and it does import `./eval-pack.js`, by
  design, since it cannot type an `EvalCase`/`EvalPack` or drive `readEvalPack`
  for B-01–B-08's packs otherwise. `prd.md` Testing decisions 2's "read
  `src/*.ts` excluding tests and the four `eval-*` files plus the three CLI
  entries" is read as excluding test-support modules, which is what the same
  section makes `src/eval.fixtures.ts` when it names it the stub's home; the
  `*.fixtures.ts` pattern is the whole exclusion and no per-file exception is
  added on top of it (`prd.md` D21, Testing decisions 2; #262 AC28).
- [behavior:B-28] The committed pack
  `eval-packs/fixtures/refused/01-unknown-member.json` — one otherwise valid
  case with one unknown top-level member — is refused by `readEvalPack` with an
  error naming that member, and a recursive listing of
  `eval-packs/fixtures/refused/` holds exactly that one file, because every
  other refusing pack (B-02–B-07) lives in a per-test temporary directory. The
  assertion is deliberately bounded to the directory this slice owns rather than
  to all of `eval-packs/`: #263 (S2) adds `eval-packs/afk/` and
  `eval-packs/fixtures/consumer-governance/` onto the same feature branch, and a
  directory-wide absence claim would turn this test red at the pre-ship gate for
  a sibling slice doing exactly what it is contracted to do (`prd.md` D2;
  #262 AC29).
- [behavior:B-29] No test under `src/` dispatches a pack to a provider other
  than the stub in `src/eval.fixtures.ts`, asserted by a source-level test over
  the slice's own test files' `runEvalCli` call sites (`prd.md` D35, Testing
  decisions 1; #262 AC30).
- [behavior:B-30] `CONTEXT.md` gains the four entries **Envelope**, **Scenario
  pack**, **Eval case** and **Eval outcome** with the text drafted in `prd.md`
  D36, under the existing `### Pipeline concepts` heading (`CONTEXT.md:217`) in
  the file's `**Term**:` / prose / `_Avoid_` format, leaving the already-merged
  **Prompt record** entry (`CONTEXT.md:389`) untouched so **Envelope**'s
  cross-reference resolves; neither the new entries nor any `src/eval-*.ts`
  file contains the word `disposition` (`prd.md` D36; #262 AC31).
- [behavior:B-31] `ARCHITECTURE.md` gains exactly one "Agent eval" module row
  in the existing table, naming `src/eval-command.ts` as the public seam and
  the other three eval modules as internals, within the file's 150-line cap
  (`prd.md` D32; #262 AC32).

### Non-goals (explicit out-of-scope)

- The seed pack `eval-packs/afk/` and the fixture consumer pack
  `eval-packs/fixtures/consumer-governance/` — #263 (S2) creates them.
- `--record-prompts` and `src/prompt-recorder.ts` — #264 (S3), already merged
  onto this branch; S1 neither edits nor documents it.
- Any merge gating, pass rate, ratio, percentage or Markdown renderer over eval
  results (`prd.md` D24, PRODUCT.md "No merge-gating on agent-eval results").
- A generator eval role, a model-based grader, retrying an invocation, or
  replaying a recorded reply (`prd.md` "Out of scope", D31).
- Any new runtime dependency, `bin` entry, `exports` entry or `package.json`
  edit; any git, worktree, `RunState`, `RunJournal`, run-directory or
  `run-events` work (`prd.md` D20, D34).
- Live-model eval runs: no test in this slice dispatches to anything but the
  stub.

### Existing behavior to preserve

- [behavior:P-01] Pipeline launch through each CLI entry is unchanged: the new
  `eval` branch is added before `parsePipelineRuntimeOptions` and every
  existing bare-token branch stays in place and in order — `status`, `stop`,
  `clean-failed`, `adopt` in `src/afk.ts` (`:50, 73, 80, 83`) and `stop`,
  `clean-failed` in `src/afk-claude.ts`/`src/afk-codex.ts` (`:47, 54`) — with
  each entry's `runPipeline({…})` call site intact (`src/afk-claude.ts:248`,
  `src/afk-codex.ts:248`).
- [behavior:P-02] The six production parsers and readers are consumed
  unmodified, with no copy inside the eval modules and no signature change:
  `parseContractReview`, `parseQAReview`, `parseFinalReview`,
  `parseGuardianReview`, `readPlannerEscalation`, `parseAcceptanceManifest`
  (`src/contract-review.ts:369`, `src/qa-review.ts:346`,
  `src/final-evaluation.ts:305`, `src/artifacts.ts:308`,
  `src/planner-escalation.ts:125`, `src/acceptance-manifest.ts:201`); their
  modules are outside this slice's file scope.
- [behavior:P-03] `pnpm test` still runs no eval scenario: `vitest.config.ts`
  keeps `include: ["src/**/*.test.ts"]` and the packs live outside `src/`, so
  the only pack any test reads it reads through `readEvalPack`
  (`prd.md` D35).
- [behavior:P-04] `.gitignore`'s `.afk/` entry (`:3`) is unchanged and the
  default `--out` resolves under it (`<repoRoot>/.afk/eval`), so no eval report
  becomes a committed, diffable artifact (`prd.md` D20).
- [behavior:P-05] The pipeline's run-evidence machinery is untouched: no
  `src/eval-*.ts` module imports `./run-events.js`, `./run-journal.js`,
  `./run-state.js`, `./run-identity.js`, `./git.js` or `./logger.js`, and
  `EVENTS_SCHEMA_VERSION` (`src/run-events.ts:26`) and
  `RUN_STATE_VERSION` (`src/run-state.ts:61`) are unchanged (`prd.md` D20,
  D34).

### Changes to existing behavior (only if the issue asks for it)

None.

## Files expected to change

- src/eval-pack.ts
- src/eval-compare.ts
- src/eval-report.ts
- src/eval-command.ts
- src/eval.fixtures.ts
- src/afk.ts
- src/afk-claude.ts
- src/afk-codex.ts
- src/eval-pack.test.ts
- src/eval-compare.test.ts
- src/eval-report.test.ts
- src/eval-command.test.ts
- src/eval-boundary.test.ts
- eval-packs/fixtures/refused/01-unknown-member.json
- CONTEXT.md
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- Two new schema versions with readers, following
  `GATE_EVIDENCE_VERSION`/`SUPPORTED_GATE_EVIDENCE_VERSIONS`
  (`src/gate-runner.ts:43-46`): `EVAL_PACK_VERSION = 1` with
  `SUPPORTED_EVAL_PACK_VERSIONS = [1]` read by `readEvalPack`, and
  `EVAL_REPORT_VERSION = 1` read by `readEvalReport`.
- A source-level import-boundary test is new to this repo (no existing helper
  found): B-27 and P-05 read source text and assert on import specifiers.
- No new runtime dependency (`package.json` has no `dependencies` key and gains
  none).

## Test plan

- Given a fixture pack directory whose case files are named out of order, when
  `readEvalPack` reads it, then the returned cases are in byte-wise ascending
  file-name order with exactly the seven declared members each.
- Given one refusing fixture per rule in D7 and D9, each written into its own
  per-test temporary directory and none committed — unknown member, missing
  member, unsupported `version`, disagreeing `version`s, unknown `role`, bad
  `expected` key or value, absolute / `..` / `./` `files` key, missing
  `fromFile` target, duplicate `id`, bad `id`, blank `source`, blank `prompt`,
  zero case files — when `readEvalPack` reads it, then it throws an error naming
  the file and the offending member, and no dispatch occurs.
- Given the committed `eval-packs/fixtures/refused/01-unknown-member.json`, when
  `readEvalPack` reads it, then it is refused naming the unknown member, and a
  recursive listing of `eval-packs/fixtures/refused/` equals exactly
  `["01-unknown-member.json"]` — bounded to this slice's own directory so a
  sibling pack #263 adds elsewhere under `eval-packs/` cannot falsify it (B-28).
- Given the stub provider in `src/eval.fixtures.ts` (artifacts built by
  importing `writeContractReview`/`writeQAReview` from `src/test-support.ts`,
  `writeAcceptanceManifest` and `REVISION_PLANNER_ESCALATION` from
  `src/orchestrator.fixtures.ts`, and hand-authoring only `final-review.json`
  and the two guardian markdown reviews), when `runEvalCli` dispatches a
  one-case pack per role, then the recorded `InvokeOptions` matches the D9
  template for that role and the projection equals the parser's verdict fields.
- Given a case whose stub artifact contradicts its `expected`, when the run
  finishes, then the outcome is `MISMATCH`, the scratch directory survives, and
  its listing and file bytes equal the case's `files` exactly.
- Given stubs that reject, exit non-zero, write no artifact, write two, write
  content whose parser throws, and write a malformed planner sentinel, when the
  run finishes, then each case is `ERROR` with the declared message and the run
  exits 0 with `report.json` written.
- Given a three-case pack and `--max-calls 2`, when the run finishes, then the
  third case is `NOT-RUN`, `callsUsed` is 2, `status` is `INCOMPLETE`, and the
  process exits 0.
- Given a completed run, when `readEvalReport` reads the written file, then
  every top-level and per-case key required by B-18–B-20 is present with the
  declared presence rule and no other key appears; a `version` of 2 is refused.
- Given a captured `deps.stdout` and the returned `output`, when a run
  completes, then the streamed lines are exactly the per-case lines, `output`
  is exactly the summary line, no line appears in both, and no emitted text
  contains a `%`, a ratio or a rate.
- Given `--dry-run`, a missing `--pack`, `--max-calls 0`, a non-integer
  `--max-calls`, a refused pack, an uncreatable `--out`, and a `deps.stdout`
  that throws on the first per-case line, when `runEvalCli` returns, then the
  exit codes are 0, 2, 2, 2, 2, 2 and 1 respectively and `report.json` exists
  only for the runs that exited 0.
- Given the three CLI entry sources, when a test reads them, then each contains
  an `args[0] === "eval"` branch before its `parsePipelineRuntimeOptions` call,
  each binds its own provider, each `usage()` contains the eval line, and every
  pre-existing bare-token branch and `runPipeline` call remains (P-01).
- Given the B-27 scanned set — every `src/*.ts` matching neither `*.test.ts` nor
  `*.fixtures.ts`, minus the four eval modules and the three CLI entries — when
  a test reads their import specifiers, then the offender list is empty, the
  set is non-empty and demonstrably contains `src/orchestrator.ts` and
  `src/wave.ts`, `src/eval.fixtures.ts` is not in it, and no eval module imports
  the run-evidence modules named in P-05.
- Given `CONTEXT.md` and `ARCHITECTURE.md`, when a test reads them, then the
  four D36 entries and the single "Agent eval" row are present, `disposition`
  appears in neither the new entries nor any `src/eval-*.ts`, and
  `ARCHITECTURE.md` stays within 150 lines.

## Definition of done

- [ ] Every behavior anchor B-01–B-31 and P-01–P-05 is covered by at least one
      test whose test name contains that anchor id, so
      `vitest run --testNamePattern <id>` yields evidence for each.
- [ ] The five new `src/eval-*.ts` / `src/eval.fixtures.ts` modules export
      exactly the names B-01, B-10, B-17, B-18 and B-26 declare.
- [ ] `pnpm run typecheck && pnpm test:fast` passes; no heavy suite is touched
      and no spawned pipeline scenario is added (`prd.md` Testing decisions 5,
      ADR 0063).
- [ ] `runEvalCli` returns exit code 1 or 2 only in the cases B-24 declares and
      0 whenever `report.json` was written.
- [ ] `git status` shows changes only to the paths listed under "Files expected
      to change".
