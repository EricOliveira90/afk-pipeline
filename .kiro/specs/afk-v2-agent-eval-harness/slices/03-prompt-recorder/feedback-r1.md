# Contract feedback — Prompt recorder (round 1)

## What is already solid

The wrapper half of this contract is in good shape. B-02 through B-05 describe
a decorator whose whole surface is observable in a unit test with a fake inner
provider and a temp directory: exact bytes, collision escalation, `name` and
`parseStreamLine` pass-through, and the no-`logStream` no-op. Those four
behaviors sit on `src/prompt-recorder.test.ts`, which is in scope, and they
name the ADR 0002 seam they plug into rather than inventing one. The
non-goals are unusually good: the five files that must not move (`src/claude.ts`,
`src/codex.ts`, `src/kiro.ts`, `src/agent-provider.ts`,
`src/invocation-runtime.ts`) are named and absent from the file scope, the
`AGENTS.md` self-run-convention edit is explicitly deferred until the flag is
on `main`, and the S1/S2 eval work is fenced off. P-02's read of the PRD 5
concurrency — additive, textually distant, second merger pays the rebase — matches
the evidence for both `src/run-events.ts` and `src/orchestrator.ts`, and holding
`EVENTS_SCHEMA_VERSION` at 1 follows the precedent comments already in that file.
P-05 chooses the right rung of the assertion ladder for the run-event check.
Scope size is one session's work: one new module, one new test file, two small
type additions, one emission property, three usage strings and two docs edits.

## The gap that has to close

Everything the contract can currently prove is on the flag-off side. B-01 proves
the parse when the flag is present, and B-02–B-05 prove the wrapper in
isolation — but nothing proves that setting `--record-prompts` actually reaches
the wrapper. B-08 carries that obligation in its `then` ("each entry wraps its
provider with `withPromptRecording` when the flag is set") and offers typecheck
as the evidence. Typecheck cannot see it: `withPromptRecording` returns an
`AgentProvider`, so passing the bare provider through — or wrapping it
unconditionally, or never wrapping it at all — type-checks exactly the same.
B-06 does not cover the hole either. Its assertion runs on a spawned fixture
that never goes through a CLI entry, so "no `.prompt.md` in the run directory"
is true no matter what the entry files do, and its "no provider was wrapped"
clause has no observable at all. B-07 asserts `recordPrompts === false`; the
`true` side is never observed.

Net effect: the slice could merge with the flag entirely inert and every gate
green. The fix does not need a spawned run — a unit-level assertion that the
provider handed to `runPipeline` for a flagged argv is the recording wrapper
(and the bare provider for an unflagged one) is the cheapest rung and keeps
P-05's no-new-scenario promise intact. `src/afk.ts` is the interesting case
here, since the flag-off path must keep relying on the `kiroProvider` default
while the flag-on path passes a provider explicitly; that asymmetry is exactly
what such a test would pin.

## Smaller things worth fixing in the same round

Two behaviors describe tests with no home. B-08's `usage()` checks and B-09's
`CONTEXT.md` / `ARCHITECTURE.md` checks have to live somewhere, and the only
test files in scope are `prompt-recorder.test.ts`, `cli-options.test.ts` and
`orchestrator.test.ts`. Name the host file and put it in the scope rather than
leaving the generator to improvise.

The path derivation leans on `options.logStream.path`, but the evidence in hand
only shows the field's type as `WriteStream`; since `src/agent-provider.ts` is
a hard non-goal, the wrapper cannot widen that type if `path` turns out not to
be on it. Cite the concrete type. While you are there, say what happens when a
stream is present but its path is missing or does not end in `.log` — today the
`String(...)` plus suffix-replacement recipe would quietly pick a nonsense
filename instead of doing nothing.

B-01 changes what argv tokens the runtime-options parser accepts, so its
regression surface wants both halves. The positive token is bound and the
harness is correctly identified as inline tests in `src/cli-options.test.ts`;
what is missing is a near-miss (`--record-prompts=false`, `--record-prompt`)
that must not set the field.

Finally, two preservation clauses claim more than their gates can show: "no
other line added" to the two shared files, and "wall-clock does not grow by a
scenario". No gate diffs against base, and the wall-clock budget is
deliberately outside the gates — as P-05 itself notes. State those as
diff-review obligations, or swap them for something a gate can actually
produce.
