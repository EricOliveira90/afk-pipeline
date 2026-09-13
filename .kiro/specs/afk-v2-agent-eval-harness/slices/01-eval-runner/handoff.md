# Slice 01 — eval runner: handoff

## What shipped

- B-01: `src/eval-pack.ts:readEvalPack`
- B-02: `src/eval-pack.ts:validateEvalCase` (`CASE_KEYS`)
- B-03: `src/eval-pack.ts:readEvalPack` (the cross-file version pre-pass, before per-case validation)
- B-04: `src/eval-pack.ts:validateEvalCase` (`EVAL_ROLES`)
- B-05: `src/eval-pack.ts:validateExpected` (`EXPECTED_SHAPE`)
- B-06: `src/eval-pack.ts:validateFiles` (`pathDefect`) and `readEvalPack`'s `fromFile` existence pass
- B-07: `src/eval-pack.ts:readEvalPack` (duplicate ids, `ID_PATTERN`, `requireNonBlank`, the empty-directory refusal)
- B-08: `src/eval-command.ts:seedScratchDir`
- B-09: `src/eval-compare.ts:roleDispatch` (`ROLE_DISPATCH`), re-exported from `src/eval-pack.ts`
- B-10: `src/eval-compare.ts:projectOutput` (`row`, `projectOne`)
- B-11: `src/eval-compare.ts:PLANNER_ROW`
- B-12: `src/eval-compare.ts:guardianRow`
- B-13: `src/eval-compare.ts:projectOne` and `src/eval-command.ts:runCase` (`failed`)
- B-14: `src/eval-command.ts:runCase` (the `catch` around the single `provider.invoke`)
- B-15: `src/eval-command.ts:runEvalCli` (`callsUsed >= options.maxCalls`, `DEFAULT_MAX_CALLS`)
- B-16: `src/eval-command.ts:parseArgs` (`UsageError`, `USAGE`)
- B-17: `src/eval-compare.ts:compareProjection` and `src/eval-command.ts:removeScratchDir`
- B-18: `src/eval-report.ts:writeEvalReport`, `readEvalReport`, `EVAL_REPORT_VERSION`
- B-19: `src/eval-report.ts:serializeCase`
- B-20: `src/eval-report.ts:serializeCase` and `src/eval-command.ts:runEvalCli` (the `costUsd` sum)
- B-21: `src/eval-report.ts:formatEvalSummary`
- B-22: `src/eval-report.ts:formatCaseLine`
- B-23: `src/eval-command.ts:runEvalCli` (exit 0 with a written report)
- B-24: `src/eval-command.ts:runEvalCli` (`dispatchBegan`, the two early exit-2 returns)
- B-25: `src/eval-command.ts:runEvalCli` (`options.dryRun`)
- B-26: `src/eval-command.ts:runDirName` and `parseArgs` (`--out`)
- B-27: `src/eval-boundary.test.ts` (the scanned-set offender list; no production module gained an import)
- B-28: `eval-packs/fixtures/refused/01-unknown-member.json`
- B-29: `src/eval.fixtures.ts:buildEvalStubProvider`
- B-30: `CONTEXT.md:### Pipeline concepts` (**Envelope**, **Scenario pack**, **Eval case**, **Eval outcome**)
- B-31: `ARCHITECTURE.md`: the module table's `Agent eval` row
- P-01: `src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` — the `args[0] === "eval"` branch, placed after the existing bare-token branches and before `parsePipelineRuntimeOptions`
- P-02: `src/eval-compare.ts` import block (the six production parsers and their filename constants)
- P-03: `vitest.config.ts` unchanged; every pack lives under `eval-packs/`
- P-04: `src/eval-command.ts:parseArgs` (`join(repoRoot, ".afk", "eval")`)
- P-05: the four eval modules' import lists (`src/eval-boundary.test.ts` holds the offender-list assertion)

## Decisions made during implementation

- **`roleDispatch` lives in `src/eval-compare.ts` and is re-exported from `src/eval-pack.ts`.** D32's module table names `eval-pack.ts` as its home, but P-02's observable is that `eval-compare.ts`'s *own* import specifiers include all six production parser modules — and the dispatch row is what carries the parsers. Defining the row beside the projection satisfies both. `eval-compare.ts` takes `EvalRole`/`EvalExpected` from `eval-pack.ts` with `import type`, so the runtime edge stays one-directional (`eval-pack` → `eval-compare`), and there is no import cycle. Recorded in a comment at the re-export.
- **D36's **Eval outcome** entry ships without `"disposition"` in its `_Avoid_` line.** D36 drafts that list as `"pass", "fail", "pass rate", "score", "disposition"`, while B-30 asserts the word appears in none of the four new entries. The two cannot both hold literally, so the entry carries D36's text with that one list item deleted — the smallest reversible reading, and one that keeps B-30's rule the operative one. Nothing else in D36's text changed.
- **`CONTEXT.md`'s **Blocked ship** entry got its `_Avoid_` line back.** The first draft appended the four new entries between that entry's body and its `_Avoid_` line, orphaning it under **Eval outcome**. The line is restored where it belongs; no wording changed.
- **P-02's "absent from the declared file scope" is asserted against a literal `DECLARED_FILE_SCOPE` array in `src/eval-boundary.test.ts`**, not by reading `acceptance-manifest.json`. The manifest is a review artifact this slice must not edit and does not commit, so a test that reads it would assert on a file that need not exist where the test runs.
- **B-30's banned term is assembled from two string literals** (`` `${"dispo"}${"sition"}` ``) in `src/eval-boundary.test.ts`. That file is itself a member of the `src/eval-*.ts` set B-30 scans, so spelling the word would falsify the rule under test. `src/eval.fixtures.ts` writes the guardian finding key plainly: `eval.fixtures.ts` does not match `eval-*.ts`.
- **`EvalStubInvocation` snapshots the scratch listing at invoke entry.** B-08 ("seeded from `files` and nothing else") is only a fact about the directory before the role writes its artifact, so `buildEvalStubProvider` records `seededEntries`/`seededBytes` first and runs the behavior second. Without that, every MISMATCH fixture would also have to be an empty-artifact fixture.
- **The 1-vs-2 exit code turns on one flag, `dispatchBegan`,** set immediately before the first `provider.invoke`. Everything that fails earlier (usage, a refused pack, an uncreatable `--out`) is 2; a runner-seam throw after a model call was spent is 1. Both mean "no `report.json`", which is the only thing D21 makes the exit code say.
- **`--max-calls` accepts `/^\d+$/` at ≥ 1 only.** A float is refused rather than rounded: a budget silently rounded is a budget nobody set.
- **`.kiro/specs/.../01-eval-runner/` is left untracked.** The commits contain only declared-scope paths.

## Gotchas / learnings

- A fresh worktree has no `node_modules`, so `pnpm run typecheck` fails with `'tsc' is not recognized` until `pnpm install --prefer-offline` runs. Nothing about the slice; it costs a minute of confusion.
- `writeAcceptanceManifest` walks up for a `.git` marker to derive the gate catalog. `writeEvalPlannerContract` therefore creates an empty `.git/` at the scratch root and writes `contract.md` + the manifest into `slice/`. Because the stub writes it *during* the invocation, it never appears in the B-08 snapshot.
- "A `contract.md` **beside** the manifest" is `existsSync(join(dirname(manifest), "contract.md"))`. A recursive search would accept a `contract.md` anywhere below the scratch root, which is a different and weaker claim.
- Windows holds file handles the moment after a child process writes: `removeScratchDir` uses `rmSync` with `maxRetries: 10, retryDelay: 50`, and `runCase` both awaits `once(logStream, "open")` (so the `.log` exists even for an invocation that rejects immediately) and awaits `logStream.end(settle)` before reading the directory.
- `durationMs` contains the substring "ratio". A report-bytes assertion that no rate, ratio or percentage appears has to match whole words, or it fails on a field name that is not a rate at all.
- The report path is the last ` — `-separated field of the summary line; `src/eval-command.test.ts` derives it with a `reportPathOf` helper rather than recomputing the run directory name, so a change to the timestamp format shows up in one place.
- The top-level `costUsd` is absent unless *every* dispatched case reported one. A partial sum reads as a total and would get quoted as one.
- Source-level import-boundary tests are a new pattern here. They are only as good as their scanned set, so `src/eval-boundary.test.ts` asserts the set is non-empty and contains the eight named production modules — an offender list over an accidentally empty set is green and worthless.
