# Handoff — S3 prompt recorder (#264)

- New migration files: 0

## What shipped

- `B-01`: `src/cli-options.ts:parsePipelineRuntimeOptions` (`recordPrompts` exact-token read) and `PipelineRuntimeOptions.recordPrompts`
- `B-02`: `src/prompt-recorder.ts:recordPrompt` + `recordPathForLog` (log path → `.prompt.md` sibling, prompt bytes verbatim)
- `B-03`: `src/prompt-recorder.ts:recordPathForLog` (lowest-free-integer scan, `wx` write)
- `B-04`: `src/prompt-recorder.ts:withPromptRecording` (`name` passthrough, conditional `parseStreamLine`, inner `InvokeResult`)
- `B-05`: `src/prompt-recorder.ts:recordPrompt` (absent `logStream` → no write, no throw)
- `B-06`: `src/prompt-recorder.ts:providerForRun` (identical `inner` reference when the flag is off)
- `B-07`: `src/orchestrator.ts:runPipeline` (`recordPrompts: config.recordPrompts ?? false` on the `run-started` emission), `src/orchestrator.ts:PipelineConfig.recordPrompts`, `src/run-events.ts` `run-started.recordPrompts?`
- `B-08`: `src/prompt-recorder.ts:providerForRun`, wired at `src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` (`provider: providerForRun(<provider>, runtimeOptions.recordPrompts)`) with `[--record-prompts]` in each `usage()`
- `B-09`: `CONTEXT.md` **Prompt record** entry (under "Pipeline concepts"), `ARCHITECTURE.md` CLI entries row internals column
- `B-10`: `src/prompt-recorder.ts:recordPrompt` / `recordPathForLog` (present stream with no `.log` sibling → no write, no fabricated name)
- `P-01`, `P-04`: no edit to `src/agent-provider.ts`, the three providers, `src/invocation-runtime.ts`, `AGENTS.md` or `CLAUDE.md`
- `P-02`: `src/run-events.ts` and `src/orchestrator.ts` carry only the three additive changes; `EVENTS_SCHEMA_VERSION` stays `1`
- `P-03`: `src/prompt-recorder.test.ts` "B-07 P-03 keeps the recordPrompts field additive on run-started"
- `P-05`: `src/orchestrator.test.ts` "B-06 B-07 records the disabled recorder…" is an `it` on the existing `focused generator scope revision` spawned fixture

## Decisions made during implementation

- `recordPrompts` is `args.includes("--record-prompts") ? true : undefined` rather than the bare `args.includes(...)` the other boolean flags use, because B-01 requires the field unset (not `false`) when the flag is absent.
- The `.prompt.<k>.md` scan is an unbounded upward `existsSync` walk from `k = 2`, with no cap: it terminates on the first free name, and a cap would silently drop a record.
- The record is written with `{ flag: "wx" }`. The scan already chose a free name, so the flag is the enforcement of "never appended to, never overwritten" rather than a fallback — a lost race surfaces instead of corrupting a record.
- `logStream.path` is read into a `const rawPath: unknown` before `String(...)`. `node:fs` declares `path: string | Buffer`, so comparing it against `undefined` directly is a TS2367 error; the `unknown` annotation keeps B-10's runtime-absent-path branch expressible without widening anything in `src/agent-provider.ts`.
- `parseStreamLine` is assigned conditionally, so `"parseStreamLine" in wrapper` is `false` for a non-parsing inner — absent, not present-and-undefined.
- **Prompt record** was placed after **Generator test command** in CONTEXT.md's "Pipeline concepts": both are launch-flag concepts, and the section is not alphabetical.
- `src/prompt-recorder.test.ts` carries the P-03 and `EVENTS_SCHEMA_VERSION` assertions: `src/run-events.test.ts` is not in this slice's file scope, and this is the slice's own suite.

## Gotchas / learnings

- The worktree had no `node_modules`; `pnpm install --frozen-lockfile` is needed before `typecheck` or any vitest run.
- `createWriteStream` opens its fd asynchronously, so a test that removes its temp directory in `afterEach` without awaiting `stream.close(cb)` gets an uncaught `ENOENT` from the pending open — tests still report green, but the run prints errors. `src/prompt-recorder.test.ts`'s `afterEach` awaits every close first. For the same reason, assert on the record files (`readdirSync(dir).filter(name => name.includes(".prompt."))`) rather than the directory's whole listing, which races the log's own creation.
- The recorder never touches the log stream itself — it only reads `.path`. So the `.prompt.md` can exist before the `.log` it is named after is flushed to disk.
- `src/afk.ts` now passes `provider:` explicitly. Anything that relied on the `config.provider ?? kiroProvider` default being reached from that entry no longer is; with the flag off the expression yields the identical `kiroProvider` object, so behavior is unchanged.
- Recording is keyed entirely on the log filename, so any future invocation that reuses a log name in the same run gets a `.prompt.<k>.md`, not a merged file. A future call site that opens a stream on something other than a `.log` records nothing and says nothing about it.
