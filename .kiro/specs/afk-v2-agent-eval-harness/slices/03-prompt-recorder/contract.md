# Slice Contract — Prompt recorder

**Parent PRD:** .kiro/specs/afk-v2-agent-eval-harness/prd.md
**GH issue:** #264
**Status:** LOCKED

**Lock-Provenance:** negotiation round 3
**Negotiation round:** 3

## Scope lock

A `--record-prompts` boolean launch flag on all three pipeline entries makes
every provider invocation write the exact prompt it received to a
`.prompt.md` file beside that invocation's `.log` in the run directory, so a
past incident can become an eval case from a recording instead of a hand
reconstruction. The recorder is a new provider wrapper
(`withPromptRecording`) plugged in at ADR 0002's `AgentProvider` seam — no
provider, `src/invocation-runtime.ts` or `InvokeOptions` field changes — and
each CLI entry routes its provider through one exported decision function,
`providerForRun(inner, recordPrompts)`, so the flag-on and flag-off wiring is
a unit-testable value and not three inline conditionals. Default off, and
whether it was on is recorded once in run evidence as an additive optional
field on the `run-started` event. The slice also adds the pre-drafted
**Prompt record** vocabulary entry and one `ARCHITECTURE.md` internals path.
No edits outside the paths below, except this slice's own negotiation
artifacts under `.kiro/specs/afk-v2-agent-eval-harness/slices/03-prompt-recorder/`,
which the planner and evaluator must remain free to write.

### In scope

- [behavior:B-01] `parsePipelineRuntimeOptions` (`src/cli-options.ts:202`)
  returns `recordPrompts: true` when the exact token `--record-prompts` is in
  `args` and leaves the field unset when it is absent, following the existing
  boolean-flag precedent at `src/cli-options.ts:239-241`;
  `PipelineRuntimeOptions` (`src/cli-options.ts:31`) gains
  `recordPrompts?: boolean`. The accepted token is exact: near misses
  (`--record-prompt`, `--record-prompts=false`, `--record-prompts=true`) leave
  the field unset, because `args.includes` is an exact-membership test and the
  flag has no value form. Keeping a near miss silent rather than raising is
  this slice's call and matches every existing boolean flag parsed at
  `:239-241` (`--serial-lanes`, `--open-pr-on-override`), which reject nothing
  either; the decision is recorded here and needs no escalation. Source: GH
  #264 AC1; `prd.md:568-571` (flag name and default are not open to this
  slice, `prd.md:692-695`).
- [behavior:B-02] New `src/prompt-recorder.ts` exports
  `withPromptRecording(inner: AgentProvider): AgentProvider`, whose `invoke`
  writes the record and then delegates to `inner.invoke(options)`. The record
  path is `String(options.logStream.path)` with a trailing `.log` replaced by
  `.prompt.md`, so it lands beside the log `RunJournal.agentLog` opened
  (`src/logger.ts:243-247`) and inherits the log's slice/role/round encoding.
  The declared type carries that member already: `logStream?: WriteStream` from
  `node:fs` (`src/agent-provider.ts:36`, `prd.md:47`), and `node:fs`'s
  `WriteStream` declares `path: string | Buffer` (`@types/node` `fs.d.ts`,
  `class WriteStream`), which is why `String(...)` reads it without widening
  any type in `src/agent-provider.ts` — a Buffer path decodes to the same
  string and is treated identically. Its bytes are `options.prompt` exactly,
  UTF-8, with no header, fence, metadata or added trailing newline. Source: GH
  #264 AC2; `prd.md:571-588`.
- [behavior:B-03] When the derived `.prompt.md` path already exists — the log
  is opened in append mode for a legitimate same-round reopen
  (`src/logger.ts:234-241`) — the record is written to `.prompt.2.md`, then
  `.prompt.3.md`, upward to the lowest free integer. No existing record is
  appended to or overwritten, so each file holds exactly one copy-pasteable
  prompt. The internal filename helper and the scan that picks `k` are this
  slice's own call, and any deterministic scan satisfies the contract
  (`prd.md:689-690`); the decision is recorded here and needs no escalation.
  Source: GH #264 AC3; `prd.md:582-585`.
- [behavior:B-04] The wrapper is transparent: its `name` is `inner.name`
  unchanged (it feeds branch and run-slug namespacing per ADR 0002 —
  "`provider.name` drives branch prefixes" — via `src/run-identity.ts`),
  `parseStreamLine` is forwarded when `inner` defines one and absent when it
  does not (ADR 0004: stream parsing is provider-optional), and `invoke`
  resolves to the inner provider's `InvokeResult` (`src/agent-provider.ts:171-175`)
  unchanged. Source: GH #264 AC4; `prd.md:590-601`.
- [behavior:B-05] An invocation whose `options.logStream`
  (`src/agent-provider.ts:36`) is undefined writes no file, does not throw,
  and still resolves to the inner provider's result. Source: GH #264 AC5;
  `prd.md:598-600`.
- [behavior:B-06] With the flag absent, no CLI entry wraps its provider and a
  run produces no `.prompt.md` file in its run directory. "No provider was
  wrapped" is observable at the wiring seam of B-08, not only as an absence:
  for an argv without the flag, `providerForRun(inner, recordPrompts)` returns
  the identical `inner` object (reference equality), so nothing can record.
  Source: GH #264 AC6; `prd.md:571` (default off).
- [behavior:B-07] `PipelineConfig` (`src/orchestrator.ts:480`) gains
  `recordPrompts?: boolean` alongside the additive-field precedent
  `testCommand?` (`src/orchestrator.ts:544`), and the single `run-started`
  emission site (`src/orchestrator.ts:7896-7907`) adds exactly one property,
  `recordPrompts: config.recordPrompts ?? false`, so every new run's
  `events.jsonl` `run-started` event carries `true` or `false` matching the
  flag. `run-started` in `src/run-events.ts:33-40` gains one optional field,
  `recordPrompts?: boolean`. Source: GH #264 AC7; `prd.md:603-613`;
  PRODUCT.md principle 7.
- [behavior:B-08] `src/prompt-recorder.ts` also exports the one wiring
  decision every entry uses:
  `providerForRun(inner: AgentProvider, recordPrompts?: boolean): AgentProvider`,
  returning `withPromptRecording(inner)` when `recordPrompts === true` and the
  identical `inner` reference otherwise. `afk`, `afk-claude` and `afk-codex`
  each accept `--record-prompts`, each `usage()` string (`src/afk.ts:35`,
  `src/afk-claude.ts:32`, `src/afk-codex.ts:32`) contains
  `[--record-prompts]`, and each entry's `runPipeline` call passes
  `provider: providerForRun(<that entry's provider>, runtimeOptions.recordPrompts)`
  — `src/afk-claude.ts:247` and `src/afk-codex.ts:247` replacing the bare
  provider they pass today, `src/afk.ts` passing `provider` where it passes
  none today. No entry calls `withPromptRecording` directly, so the
  flag-on/flag-off decision exists in exactly one place. Two declared
  observables cover the flag-on side, neither of them typecheck: a unit test
  that feeds a flagged argv through `parsePipelineRuntimeOptions` into
  `providerForRun` and asserts the returned provider is not `inner` and writes
  the sibling `.prompt.md` when invoked (and, for an unflagged argv, that it is
  `inner` by reference and writes nothing), and a source assertion in
  `src/cli-entries.test.ts` that each of the three entry files passes
  `providerForRun(` with `runtimeOptions.recordPrompts` in its `runPipeline`
  config and contains no direct `withPromptRecording(` call — a missing wrap
  and an unconditional wrap each fail it. Exporting a second function beside
  `withPromptRecording` is this slice's call: `prd.md:591-597` fixes
  `withPromptRecording`'s name and signature and requires each entry to wrap
  when the flag is set, D32's closed export list (`prd.md:494-499`,
  `prd.md:694`) does not name this module, and `prd.md:689-690` leaves the
  wrapper's internal helpers and unit-test layout to S3. Source: GH #264 AC9;
  `prd.md:594-597`, `prd.md:714-716`.
- [behavior:B-09] `CONTEXT.md` gains the **Prompt record** entry with the text
  drafted at `prd.md:663-670`, under "Pipeline concepts"
  (`CONTEXT.md:217`) in the file's existing `**Term**:` / prose / `_Avoid_:`
  format, and `ARCHITECTURE.md`'s CLI entries row names
  `src/prompt-recorder.ts` in its internals column. Both assertions live in
  `src/prompt-recorder.test.ts`, the suite of the module both docs describe;
  no docs test file exists in the repo today to extend. Source: GH #264 AC12;
  `prd.md:723-724`.
- [behavior:B-10] A present `logStream` whose derived path yields no
  `.prompt.md` sibling — the `String(...)` result has no trailing `.log`, or
  `path` is absent at runtime — writes no file, throws nothing, and resolves
  to the inner provider's result, exactly as B-05's absent stream does. No
  fallback name is invented: a record whose name does not sit beside a log is
  not the artifact the **Prompt record** entry promises, and the branch is
  unreachable from production, where every call site's `logStream` comes from
  `RunJournal.agentLog` and therefore ends in `.log` (`prd.md:71-73`,
  `src/logger.ts:243-247`, including the ship gate's guardian stream at
  `src/ship-gate.ts:744-757`). Choosing skip over a fabricated name is this
  slice's call inside its own wrapper and is recorded here; it needs no
  escalation. Source: `prd.md:579-580`, `prd.md:598-600`; GH #264 AC2/AC5.

### Non-goals (explicit out-of-scope)

- No change to any provider (`src/claude.ts`, `src/codex.ts`, `src/kiro.ts`),
  to `src/invocation-runtime.ts`, or to `src/agent-provider.ts` — the wrapper
  is the whole mechanism (`prd.md:600-601`). In particular the wrapper does not
  widen `InvokeOptions.logStream` to carry a path: `node:fs`'s `WriteStream`
  already declares one (B-02).
- No redaction, filtering, truncation or size cap on the recorded bytes:
  `.afk/` is gitignored and the sibling `.log` already quotes the same sources
  (`prd.md:586-588`).
- No `run.log` line and no `run-summary.md` section for the flag — the
  `run-started` event is the one channel (`prd.md:608-609`).
- No validation, error or value form for `--record-prompts` beyond exact-token
  membership (B-01); no new refusal path in `parsePipelineRuntimeOptions`.
- No `AGENTS.md` self-run-convention edit; `--record-prompts` is added there by
  hand after this slice merges, because the convention must not claim a flag
  that is not yet on `main` (`prd.md:615-618`).
- No `afk eval` command, pack reader, or eval case work — that is S1/S2
  (`prd.md:706-722`).
- No `EVENTS_SCHEMA_VERSION` bump and no reader/consumer changes for the new
  field beyond the type addition.

### Existing behavior to preserve

- [behavior:P-01] `src/agent-provider.ts:184-190` (`AgentProvider`),
  `src/agent-provider.ts:27` (`InvokeOptions.prompt`), the three providers'
  `stdin: prompt` (`src/claude.ts:183`, `src/codex.ts:278`,
  `src/kiro.ts:184`) and the shared stdin write
  (`src/invocation-runtime.ts:200-203`) are unchanged by this slice; they are
  absent from the file scope below, so any edit there is a scope violation.
  Source: GH #264 AC10; `prd.md:727-733`.
- [behavior:P-02] The only changes to `src/run-events.ts` and
  `src/orchestrator.ts` are the optional `recordPrompts` field on
  `run-started`, the optional `recordPrompts` field on `PipelineConfig`, and
  the one property in the `run-started` emission. `EVENTS_SCHEMA_VERSION`
  stays `1` (`src/run-events.ts:26`), following the additive-field precedent
  comments at `src/run-events.ts:235-236` and `:252-253`. Two halves, deliberately
  separated: an assertion that `EVENTS_SCHEMA_VERSION === 1` and the existing
  `run-events` and `orchestrator` suites passing unchanged are gate-produced
  evidence, while "no other line added to either file" is a **diff-review
  obligation on this slice's diff against base** — no gate in the catalog
  diffs content line by line, so the reviewer, not `typecheck` or `tests`,
  holds that half. PRD 5's concurrent edits to both files
  (`invocation-completed.role`, `src/run-events.ts:120-146`) are textually
  distant and additive; the second merger pays the rebase (`prd.md`
  "Concurrency with PRD 5"). Source: GH #264 AC11; `prd.md:609-613`.
- [behavior:P-03] Reading a historical `events.jsonl` whose `run-started`
  event carries no `recordPrompts` field still succeeds — the field is
  optional in the type for exactly that reason. Source: GH #264 AC8;
  `prd.md:604-606`.
- [behavior:P-04] `AGENTS.md` and `CLAUDE.md` are unchanged by this slice.
  Source: GH #264 AC13; `prd.md:733`.
- [behavior:P-05] `src/orchestrator.test.ts` gains no new spawned pipeline
  scenario: the `run-started` assertion is one `it` attached to an existing
  spawned fixture that already reads `events.jsonl`, following the precedent
  at `src/orchestrator.test.ts:2906-2931`. The gate-produced half is the
  existing `orchestrator` suite passing with only `it` blocks added inside an
  existing `describe`; that the diff adds no new spawned-fixture setup is a
  **diff-review obligation**, and suite wall-clock is not evidence any gate
  can produce — ADR 0063 keeps the per-suite budget out of the gates
  (`pnpm test:ratchet` / `pnpm test:budgets`) precisely so the assertion
  ladder, not a red number, holds this line. Source: GH #264 AC14; `prd.md`
  Testing decision 4.

### Changes to existing behavior (only if the issue asks for it)

- `src/afk.ts` starts passing `provider` to `runPipeline`:
  `providerForRun(kiroProvider, runtimeOptions.recordPrompts)`. With the flag
  absent that expression returns the identical `kiroProvider` object the
  `config.provider ?? kiroProvider` default already supplies
  (`src/orchestrator.ts:7891`, same expression at `src/orchestrator.ts:1030`),
  so an unflagged `afk` run is behaviorally identical — `src/afk.ts` already
  imports `kiroProvider` and passes it to `resolveCliRunScope`
  (`src/afk.ts:173`). Source: GH #264 "Each CLI entry wraps its provider…";
  `prd.md:594-597`.

## Files expected to change

- src/prompt-recorder.ts
- src/prompt-recorder.test.ts
- src/cli-entries.test.ts
- src/cli-options.ts
- src/cli-options.test.ts
- src/afk.ts
- src/afk-claude.ts
- src/afk-codex.ts
- src/run-events.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- CONTEXT.md
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/prompt-recorder.ts`: the first `AgentProvider` decorator
  (wraps an existing provider rather than implementing a backend). It plugs in
  at ADR 0002's declared seam and adds no dependency. Its second export,
  `providerForRun`, is the entries' single flag-on/flag-off decision so that
  wiring is a testable value rather than three inline conditionals (B-08).
- New test file `src/cli-entries.test.ts`: the three entries' `usage()` text
  and their provider-wiring shape, spawned/read with no pipeline run — the
  cheapest rung of AGENTS.md's assertion ladder that can fail when the wrap is
  missing or unconditional.
- No new runtime dependency. No schema version bump:
  `EVENTS_SCHEMA_VERSION` stays 1 for the additive `run-started` field.

## Test plan

Each test name contains the behavior ID it proves (e.g. `B-02 …`) so
`acceptance:behaviors` can select it by `--testNamePattern`.

- Given `args` containing `--record-prompts`, when
  `parsePipelineRuntimeOptions` parses them, then `recordPrompts` is `true`;
  given `args` without it, then the field is unset; given the near misses
  `--record-prompt` and `--record-prompts=false`, then the field is unset for
  both (`src/cli-options.test.ts`, existing style — plain `describe`/`it`, no
  fixture machinery). [B-01]
- Given a fake inner `AgentProvider` and a `logStream` opened on a temp
  `…/slice-01-generator.log`, when the wrapped provider's `invoke` runs, then
  `…/slice-01-generator.prompt.md` exists and its bytes read back equal
  `options.prompt` exactly, with no added header, fence or trailing newline.
  [B-02]
- Given that record already on disk, when `invoke` runs again for the same log
  path, then `…/slice-01-generator.prompt.2.md` is created, a third run
  creates `.prompt.3.md`, and the earlier files' bytes are untouched. [B-03]
- Given inner providers with and without `parseStreamLine`, when wrapped, then
  `name` equals the inner's, `parseStreamLine` is forwarded or absent to
  match, and `invoke` resolves to the identical `InvokeResult` object the inner
  returned. [B-04]
- Given `options` with no `logStream`, when `invoke` runs, then no file is
  created in the temp directory and the promise resolves to the inner result.
  [B-05]
- Given a `logStream` opened on a temp path that does not end in `.log` (e.g.
  `…/guardian-review.txt`), when `invoke` runs, then the temp directory gains
  no file, nothing throws, and the promise resolves to the inner result.
  [B-10]
- Given the argv `["--prd-dir", "x", "--record-prompts"]` and the argv without
  the flag, when each is parsed by `parsePipelineRuntimeOptions` and its
  `recordPrompts` handed to `providerForRun` with a fake inner provider, then
  the flagged provider is a different object that writes the sibling
  `.prompt.md` when invoked and the unflagged provider is `inner` itself
  (`toBe`) and writes nothing (`src/prompt-recorder.test.ts`). [B-08, B-06]
- Given the three entry files read as text, when each is scanned, then each
  passes `providerForRun(` with `runtimeOptions.recordPrompts` to
  `runPipeline` and none calls `withPromptRecording(` directly; and given each
  entry spawned with no arguments, when its `usage()` text is captured from
  stderr, then it contains `[--record-prompts]` (`src/cli-entries.test.ts`,
  spawning via the `tsx` loader pattern at `src/afk.test.ts:14-40`). [B-08]
- Given a spawned pipeline run, when its `events.jsonl` is read and filtered to
  `type === "run-started"`, then the event carries `recordPrompts: false` —
  one `it` on an existing spawned fixture, using the read-and-filter pattern
  at `src/orchestrator.test.ts:2906-2931`, and asserting no `.prompt.md` file
  exists in that run directory. [B-06, B-07, P-05]
- Given a `run-started` object literal with no `recordPrompts` key, when it is
  typed as the event payload and read, then it type-checks and reads cleanly,
  and `EVENTS_SCHEMA_VERSION` is still `1`. [P-03]
- Given `CONTEXT.md` and `ARCHITECTURE.md`, when read in
  `src/prompt-recorder.test.ts`, then `CONTEXT.md` contains the **Prompt
  record** entry text from `prd.md:663-670` under "Pipeline concepts" and
  `ARCHITECTURE.md`'s CLI entries row lists `src/prompt-recorder.ts`. [B-09]
- Iteration runs `pnpm run typecheck && pnpm test:fast` plus
  `pnpm run test:heavy:orchestrator` for the touched `orchestrator.test.ts`;
  never the full suite from inside this slice (CLAUDE.md test-loop discipline;
  GH #264 "Tests").

## Definition of done

- [ ] `--record-prompts` parses to `recordPrompts: true` when present, is
      unset when absent, and is unset for the near misses `--record-prompt`
      and `--record-prompts=false`. [B-01]
- [ ] `src/prompt-recorder.ts` exports `withPromptRecording` and writes the
      sibling `.prompt.md` with `options.prompt`'s exact bytes. [B-02]
- [ ] Collisions escalate to `.prompt.2.md`, `.prompt.3.md`, …, never
      appending to or overwriting an existing record. [B-03]
- [ ] `name`, `parseStreamLine` and the returned `InvokeResult` pass through
      the wrapper unchanged. [B-04]
- [ ] An invocation with no `logStream` writes nothing and does not throw.
      [B-05]
- [ ] A `logStream` whose path yields no `.prompt.md` sibling writes nothing
      and does not throw. [B-10]
- [ ] With the flag absent, `providerForRun` returns the inner provider itself
      and no `.prompt.md` appears in the run directory. [B-06]
- [ ] With the flag present, `providerForRun` returns a provider that writes
      the sibling record, and all three entries route their provider through
      it with `runtimeOptions.recordPrompts`. [B-08]
- [ ] Every new run's `run-started` event carries `recordPrompts` as `true` or
      `false`, and `EVENTS_SCHEMA_VERSION` is still 1. [B-07]
- [ ] All three CLI entries accept the flag and advertise
      `[--record-prompts]` in `usage()`. [B-08]
- [ ] `CONTEXT.md` carries the **Prompt record** entry and `ARCHITECTURE.md`
      names `src/prompt-recorder.ts`. [B-09]
- [ ] `src/agent-provider.ts`, `src/claude.ts`, `src/codex.ts`, `src/kiro.ts`
      and `src/invocation-runtime.ts` are unchanged. [P-01]
- [ ] `src/run-events.ts` and `src/orchestrator.ts` changed only by the two
      optional fields and the one emission property — the line-level half read
      off the diff, `EVENTS_SCHEMA_VERSION === 1` asserted. [P-02]
- [ ] A `run-started` event without `recordPrompts` still parses. [P-03]
- [ ] `AGENTS.md` and `CLAUDE.md` are unchanged. [P-04]
- [ ] No new spawned pipeline scenario was added to
      `src/orchestrator.test.ts` (read off the diff). [P-05]
- [ ] `pnpm run typecheck`, `pnpm test:fast` and
      `pnpm run test:heavy:orchestrator` pass on this slice's worktree.
