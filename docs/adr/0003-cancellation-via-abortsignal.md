# Cancellation via AbortSignal, hard-stop semantics

`runPipeline` accepts an optional `signal: AbortSignal` in
`PipelineConfig`. The CLI (`afk.ts`, `afk-claude.ts`) wires
`process.on("SIGINT", () => controller.abort())` so Ctrl-C cancels the
run cleanly. The signal is threaded through to each `AgentProvider.invoke()`
call; providers attach a listener that calls `proc.kill("SIGTERM")` when
the signal fires (mirrors the existing idle-timeout kill path).

**Hard-stop, not drain:** when the signal fires, in-flight agent
invocations are killed immediately rather than allowed to finish their
current call. Agent invocations can run 5-10 minutes; a "drain" semantic
would make Ctrl-C effectively useless. Worktrees, branches, and slice
artifacts are all preserved on disk, so a re-run resumes from whatever
state the on-disk artifacts represent — no special replay logic needed.

**`CANCELLED` is non-terminal for resumability:** persisted to run-state
with `mergedToFeature: false`, so `isSliceComplete()` returns false and
re-running the pipeline retries the slice. The existing artifact
short-circuits in `runSlice` (`if (!existsSync(contextPath))`,
`contractStatus === "LOCKED"`) already handle partial progress
correctly, so no new resume logic is needed.

**Why "cancellation" / `CANCELLED` and not "abort" / `ABORTED`:** the
codebase already uses `git merge --abort` for conflict recovery. Using
"abort" for two distinct concepts (git merge state vs pipeline
termination) would create the kind of ambiguity CONTEXT.md exists to
prevent. "Cancellation" is unambiguous and matches the platform vocabulary
(`AbortSignal` triggers a _cancellation_ in the application layer).

## Status partitioning

After this change, slice failure modes partition cleanly:

- `STUCK` — agent tried, hit max rounds, gave up
- `ERROR` — unexpected exception (bug, network, git failure)
- `CANCELLED` — user pressed Ctrl-C / external `AbortSignal` fired
- `CONFLICT` — merge conflict during integration phase
