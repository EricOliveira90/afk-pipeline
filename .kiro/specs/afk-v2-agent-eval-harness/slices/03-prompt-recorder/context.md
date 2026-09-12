# Context: Prompt recorder (issue #264)

## Files and current behavior

- FACT: `AgentProvider` is defined at `src/agent-provider.ts:184-190`: `{ readonly name: string; invoke(options: InvokeOptions): Promise<InvokeResult>; parseStreamLine?(line: string): StreamEvent[]; }`.
- FACT: `InvokeOptions.prompt` is `prompt: string;` at `src/agent-provider.ts:27`, and `InvokeOptions.logStream?: WriteStream` at `src/agent-provider.ts:36`.
- FACT: `InvokeResult` is `{ exitCode: number; stdout: string; stats: InvocationStats; }` at `src/agent-provider.ts:171-175`.
- FACT: All three providers pipe the prompt to the child process's stdin, never write it anywhere else: `stdin: prompt,` at `src/claude.ts:183`, `src/codex.ts:278`, `src/kiro.ts:184`.
- FACT: The shared invocation runtime performs the actual write: `src/invocation-runtime.ts:200-203` — `if (invocation.stdin !== undefined) { proc.stdin!.write(invocation.stdin); proc.stdin!.end(); }`. `invocation.stdin` is the same string each provider set from `prompt`.
- FACT: The only existing trace of a prompt is the `prompt-assembly` event (sizes/ids, not content) — cited in issue #264 body; not independently re-verified in this pass since the issue is authoritative on file-scope.
- FACT: `RunJournal.agentLog` names invocation logs `slice-<sliceId>-<agent>[-r<round>].log`, opened in append mode: `src/logger.ts:243-247`. The append-mode comment at `src/logger.ts:234-241` explains why: a filename can be legitimately reopened within one run (a lane successor re-running explorer/planner rounds).
- FACT: `src/orchestrator.ts` passes `logStream: <name>Log` (a plain property, never combined with anything else) into `invoke(...)` calls at lines 1528, 1667, 3056, 5203, 5881, 7202, 7721; `src/ship-gate.ts:757` does the same (`logStream: log,`).
- FACT: `PipelineRuntimeOptions` interface starts at `src/cli-options.ts:31`; `parsePipelineRuntimeOptions` starts at `src/cli-options.ts:202`.
- FACT: Existing boolean-flag precedent in `parsePipelineRuntimeOptions`, `src/cli-options.ts:239-241`:
  ```ts
  const preflightReportOnly = args.includes("--preflight-report-only");
  const serialLanes = args.includes("--serial-lanes");
  const openPrOnOverride = args.includes("--open-pr-on-override");
  ```
  each is then spread into the returned object (`src/cli-options.ts:272-274`).
- FACT: `usage()` is defined at `src/afk.ts:35`, `src/afk-claude.ts:32`, `src/afk-codex.ts:32`, each a single template-literal `console.error` listing bracketed flags, ending `process.exit(2)`.
- FACT: `src/afk-claude.ts:247-263` and `src/afk-codex.ts:247-263` (same shape) call `runPipeline({ ..., provider: claudeProvider /* or codexProvider */, ..., ...runtimeOptions })`; `provider` is at line 257 in both files.
- FACT: `src/afk.ts` does **not** pass `provider` into its `runPipeline({...})` call (`src/afk.ts:280-295`); it imports `kiroProvider` (`src/afk.ts:11`) and uses it only for `resolveCliRunScope` (`src/afk.ts:173`). The orchestrator's own default, `const provider = config.provider ?? kiroProvider;`, is at `src/orchestrator.ts:7891`. This matches the issue body's claim that `afk.ts` relies on that default and must pass `withPromptRecording(kiroProvider)` explicitly when wrapping.
- FACT: `PipelineConfig` interface starts at `src/orchestrator.ts:480`; its `provider?: AgentProvider` field is at `src/orchestrator.ts:501` ("Defaults to the Kiro provider"); its `testCommand?: string` field (cited in the issue as the additive-field precedent to follow) is at `src/orchestrator.ts:544`.
- FACT: The `run-started` event type is defined at `src/run-events.ts:33-40`:
  ```ts
  {
    type: "run-started";
    provider: string;
    runSlug: string;
    contractRoundLimit?: number;
    implementationRoundLimit?: number;
  }
  ```
- FACT: The single `run-started` emission site is `src/orchestrator.ts:7896-7907`, inside `runPipeline`, right after the default-provider line (`:7891`):
  ```ts
  logger.phase(
    `[afk] Pipeline run started (${provider.name}) — logs: ${logger.runDir}`,
    "error",
    {
      type: "run-started",
      provider: provider.name,
      runSlug: loggerSlug,
      contractRoundLimit: config.maxContractRounds ?? DEFAULT_MAX_CONTRACT_ROUNDS,
      implementationRoundLimit: MAX_GENERATOR_ROUNDS,
    },
  );
  ```
- FACT: `EVENTS_SCHEMA_VERSION = 1` at `src/run-events.ts:26`. Precedent comments for "additive field/event, so `EVENTS_SCHEMA_VERSION` stays 1" appear at `src/run-events.ts:235-236` (for `approved-baseline`) and `:252-253` (for `final-evaluation-reuse`, referencing `behavior-coverage` and `approved-baseline` before it) — an established pattern this slice's `recordPrompts` field addition should follow and cite.
- FACT: `.kiro/specs/afk-v2-agent-eval-harness/prd.md:697-725` is the PRD's file-scope map, and is explicit and authoritative about this slice's edits: it names `src/prompt-recorder.ts` (new, S3 creates), the `afk.ts`/`afk-claude.ts`/`afk-codex.ts` wrap+usage-line edits, `recordPrompts` in `PipelineRuntimeOptions`, `run-started.recordPrompts?` as "one optional field" in `src/run-events.ts`, and in `src/orchestrator.ts` "`recordPrompts` on `PipelineConfig` + one property in the `run-started` emission (:7900-7906) — no behavior". The line range cited there (`:7900-7906`) is inside the emission block found at `:7896-7907` above (exact sub-range depends on formatting after the edit).
- FACT: `.kiro/specs/afk-v2-agent-eval-harness/prd.md:689-690` states, under "What a slice may still decide": "S3: the wrapper's internal file-name helper, how `.prompt.<k>.md` picks `k` (any deterministic scan is fine), the unit-test layout" — i.e. the numbering algorithm's exact implementation is explicitly left open, only the outward rule (lowest free integer) is fixed by the issue body.

## Patterns and test harness

- FACT: `src/cli-options.test.ts:1-7` imports directly from `./cli-options.js` and uses plain `describe`/`it`/`it.each` (vitest) with `.toThrow(/regex/)` assertions for invalid input; no fixture/spawn machinery. A `recordPrompts` parse assertion fits this file's existing style.
- FACT: `src/orchestrator.test.ts` contains many `describe(...)` blocks (e.g. `:1199` "runPipeline lane scheduling", `:2757` "focused generator scope revision", `:3565` "runPipeline summary report") built on shared spawned fixtures.
- FACT: An existing pattern for reading `events.jsonl` off an already-spawned fixture's run directory is at `src/orchestrator.test.ts:2906-2931` (test `"P-03 leaves the pre-QA gate outcomes untouched..."`): it locates the run directory via `readdirSync(runRoot)...find(...isDirectory())`, reads `events.jsonl`, splits on newlines, and `JSON.parse`s each line into `Record<string, unknown>`, then filters by `event.type === "..."`. The comment there (`:2899-2904`) explicitly frames this as "the one spawned assertion this slice adds... rather than a new spawned scenario" — this is the citable precedent for ADR 0063 compliance in this slice's own `run-started.recordPrompts` assertion.
- FACT: Other `events.jsonl` reads in `orchestrator.test.ts` follow the same read-and-filter shape at `:2911`, `:2939-2959`, and `:3665`.
- FACT: The closest existing "wrap/fake an `AgentProvider`" precedent is `buildStubProvider` in `src/orchestrator.fixtures.ts` (around line 407 per prior exploration in this session; not re-verified line-exact here), a full stub implementing `{ name: "stub"; async invoke(options) {...} }`, used throughout `orchestrator.test.ts`. `src/prompt-recorder.test.ts` (new) is expected to build its own minimal fake inner `AgentProvider` rather than reuse this fixture, since the wrapper test is a pure unit test per the issue body ("unit-tested alone").
- FACT: The issue body specifies `pnpm run test:heavy:orchestrator` for the modified `orchestrator.test.ts` file, plus `pnpm run typecheck && pnpm test:fast`, and explicitly "never the full suite" for this slice — consistent with CLAUDE.md's "Test loop discipline" section (agent slice work runs `test:fast` + touched heavy suites, not the full `pnpm test`).

## Data and integration

- FACT: The record file path is derived from the log path by string replacement: the issue specifies `String(options.logStream.path)` with a trailing `.log` replaced by `.prompt.md`, landing in the same run directory as `RunJournal.agentLog` (`src/logger.ts:243-247`) writes to, e.g. `slice-<sliceId>-<agent>[-r<round>].prompt.md`.
- FACT: Collision handling (per issue body) is: if `.prompt.md` exists, try `.prompt.2.md`, then `.prompt.3.md`, upward to the lowest free integer; never append or overwrite. The exact scan algorithm is explicitly a slice decision (prd.md:690, cited above).
- FACT: `recordPrompts` threads through three surfaces additively: `PipelineRuntimeOptions.recordPrompts?: boolean` (`src/cli-options.ts`), `PipelineConfig.recordPrompts?: boolean` (`src/orchestrator.ts`, alongside `testCommand?` at `:544`), and `RunEventPayload`'s `run-started` variant gains `recordPrompts?: boolean` (`src/run-events.ts:33-40`).
- FACT: The emission site (`src/orchestrator.ts:7896-7907`) must add exactly one property, `recordPrompts: config.recordPrompts ?? false`, per the issue body.
- INFERENCE: Because `src/afk.ts` never passes `provider` to `runPipeline` today (relying on the `:7891` default) but does import and use `kiroProvider` elsewhere (`:11`, `:173`), enabling `--record-prompts` in `afk.ts` requires it to start passing `provider: withPromptRecording(kiroProvider)` explicitly — this is a new `runPipeline({...})` call-site edit for `afk.ts` specifically, distinct from `afk-claude.ts`/`afk-codex.ts` which already pass `provider: <x>Provider` and only need to conditionally wrap that existing argument. Drawn from: `src/afk.ts:11,173,280-295`; `src/orchestrator.ts:7891`; issue #264 body.
- FACT: PRD concurrency note: PRD 5 (`.kiro/specs/afk-v2-quality-loops`, issues #87/#97) also edits `src/run-events.ts` (at `invocation-completed.role`, issue text cites lines 120-146) and `src/orchestrator.ts` concurrently; both sets of edits are additive and textually distant from this slice's edits, and the plan's policy assigns rebase cost to whichever merges second (issue #264 body, "Concurrency with PRD 5"; also referenced in prd.md).
- FACT: `CONTEXT.md`'s "Pipeline concepts" subsection starts at `CONTEXT.md:217`; entries follow the format `**Term**:` line, wrapped prose, blank line, `_Avoid_:` line (e.g. `**AFK manifest**:` at `:219-230`, `**Migration reservation pool**:` at `:232-239`). The exact **Prompt record** entry text to insert is pre-drafted at `.kiro/specs/afk-v2-agent-eval-harness/prd.md:663-669`:
  ```
  **Prompt record**:
  The `slice-<NN>-<role>[-r<N>].prompt.md` file `--record-prompts` writes beside
  the invocation's `.log` in the run directory: the envelope's bytes, unchanged,
  one file per invocation. Default off; the `run-started` event records whether
  it was on. The raw material for an eval case's `prompt`.
  _Avoid_: "prompt log", "transcript", "envelope dump"
  ```
  The PRD also defines a related **Envelope** entry (prd.md:630-636) that cross-references "Prompt record" — that entry belongs to a different slice (S1) and is not this slice's to add, but establishes the vocabulary this slice's entry must stay consistent with.
- FACT: `ARCHITECTURE.md`'s "CLI entries" row is `| CLI entries | Parse options, pick provider, call the orchestrator | \`src/afk.ts\`, \`src/afk-claude.ts\`, \`src/afk-codex.ts\` | \`src/cli-options.ts\`, \`src/cli-run-scope.ts\` |` — the Internals column currently lists only `src/cli-options.ts` and `src/cli-run-scope.ts`; this slice adds `src/prompt-recorder.ts` to that column (prd.md:724).

## Unknowns

- UNKNOWN: The exact current line number of `buildStubProvider` in `src/orchestrator.fixtures.ts` was reported as "around line 407" from an earlier exploration pass in this session and was not independently re-verified against the file in this pass.
- UNKNOWN: Whether `src/orchestrator.test.ts` currently has any other `describe` block already exercising `run-started` specifically (as opposed to `gate-outcome`/`behavior-coverage`/generator-round events) was not confirmed beyond the read-and-filter pattern shown at `:2906-2931`; the planner will need to locate the best existing spawned scenario to attach the new `it` to, per ADR 0063's assertion ladder.
- UNKNOWN: The precise byte offsets/line numbers inside `src/orchestrator.ts:7896-7907` after any intervening PRD 5 edits land (concurrent edit risk noted above) — the emission block's line numbers may shift by the time this slice is implemented.
