# QA Report

**Verdict:** PASS
**Failure class:** NONE

Slice 03 (prompt recorder, #264) against `contract.md` at `Status: LOCKED`,
negotiation round 3. Slice diff taken against `a8c21e0` — the last pre-slice
commit — because the merge-base with `main` (`46f6c38`) also carries the PRD 7
preparation commits and `0faf207`'s `AGENTS.md` / `CLAUDE.md` duration fix,
none of which belong to this slice.

The change-summary artifact named in my instructions
(`.afk/artifacts/afk-v2-agent-eval-harness-claude-code/slice-03/change-summary.json`)
does not exist in this worktree — `.afk/` is not carried into the checkout — so
the diff below was derived from git directly.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — PASS, exit 0, `Done in 4.7s using pnpm
  v10.33.0`. Run here because the skip authorization does not cover it: the
  install it cites ran in a different checkout and left this one without
  `node_modules`.
- `pnpm run typecheck` — PASS, `tsc --noEmit` clean, no diagnostics. Run
  directly rather than cited, since it is cheap and I intended to probe with
  mutations (which voids the authorization); the authorization's own record
  agrees — PASS at 2026-09-12T08:34:40.433Z, evidence artifact
  `.afk/logs/afk-v2-agent-eval-harness-claude-code/run-20260912-045140/gates/s03/attempt-ff47dd21bc35.json`,
  tree `a58ca74b4943257b6bb6902ef1d7a328a8a19245`.

Every probe below was reverted; `git status --porcelain -- src` is empty and
the tree is byte-identical to the one graded.

### Behaviors

Each behavior was verified by running its named test and then by breaking the
implementation and confirming the same test fails. Probe runs used single test
files, never the full suite.

Green run of the three fast files:

```
✓ src/cli-options.test.ts (59 tests)
✓ src/prompt-recorder.test.ts (11 tests)
✓ src/cli-entries.test.ts (6 tests)
Tests  76 passed (76)
```

Green run of the spawned assertion (filtered, one scenario, not the suite):

```
pnpm vitest run src/orchestrator.test.ts -t "B-06 B-07"
✓ src/orchestrator.test.ts (188 tests | 187 skipped) 10303ms
Tests  1 passed | 187 skipped (188)
```

- **B-01** — `src/cli-options.ts:252` reads
  `args.includes("--record-prompts") ? true : undefined`, and
  `PipelineRuntimeOptions.recordPrompts?: boolean` is declared at `:58-65`.
  The test covers the exact token, plain absence, `--record-prompt`,
  `--record-prompts=false` and `--record-prompts=true`; all four near-miss and
  absent cases assert `toBeUndefined()`. Matches the contract's exact-membership
  decision and the `:239-241` boolean precedent.
- **B-02** — record path is
  `String(options.logStream.path)` with `.log` → `.prompt.md`
  (`src/prompt-recorder.ts:37-46`), bytes are `options.prompt` verbatim.
  `src/agent-provider.ts` is untouched, and `typecheck` resolves `.path`
  against the stock `node:fs` `WriteStream`. The test's prompt deliberately
  carries a fenced block, no trailing newline and a non-ASCII `✓`, and asserts
  `toBe(prompt)`.
- **B-03** — lowest-free-integer upward scan, plus `flag: "wx"` as the
  enforcement rather than an optimisation. Two tests: three invocations on one
  log path produce `.prompt.md` / `.prompt.2.md` / `.prompt.3.md` with distinct
  bytes, and a pre-seeded `.prompt.md` is left untouched while the new record
  takes `.prompt.2.md`. The scan and the write are both synchronous with no
  `await` between them, so the choose-then-write pair cannot be interleaved by
  a concurrent lane.
- **B-04** — the wrapper sets `name: inner.name`, assigns `parseStreamLine`
  only when the inner defines one, and returns `inner.invoke(options)`
  unmodified. `AgentProvider` (`src/agent-provider.ts:184-190`) declares
  exactly those three members, so nothing is silently dropped. The test asserts
  `"parseStreamLine" in wrappedSilent === false` — absent, not
  present-and-undefined — and `toBe(RESULT)` for identity.
- **B-05 / B-10** — the three skip paths return before any write. Verified all
  three: absent `logStream`, `path` absent at runtime, and a `.txt` path.
  B-10's "no fallback name is invented" is asserted both ways — the record
  filter is empty and `guardian-review.prompt.md` specifically does not exist.
  I checked B-10's "unreachable from production" claim independently: every
  production `logStream` traces to `RunJournal.agentLog`
  (`src/logger.ts:243-247`), which always builds
  `slice-<id>-<agent>[-r<n>].log`; `src/ship-gate.ts:744-757` is the one
  non-slice call site and it uses the same helper. `createWriteStream` appears
  nowhere else in `src/` outside tests.
- **B-06 / B-07** — `providerForRun` returns the identical `inner` reference
  when the flag is off, asserted with `toBe`. The spawned half runs against the
  existing `focused generator scope revision` fixture, reads that run's real
  `events.jsonl`, asserts exactly one `run-started` event carrying
  `recordPrompts: false`, and asserts the run directory contains no `.prompt.`
  entry. The flat listing is the right one: `agentLog` writes into `runDir`
  itself, not a subdirectory. `run-started` is emitted from exactly one site
  (`src/orchestrator.ts:7907`), so no run can miss the field.
- **B-08** — all three entries pass
  `provider: providerForRun(<provider>, runtimeOptions.recordPrompts)`, none
  imports or calls `withPromptRecording`, and all three `usage()` strings carry
  `[--record-prompts]` — the last verified against real spawned stderr, not a
  source read.
- **B-09** — the CONTEXT.md entry is byte-identical to the draft at
  `prd.md:663-670`, and `ARCHITECTURE.md`'s CLI entries row names
  `src/prompt-recorder.ts` in the internals column (fourth column, asserted via
  `columns.at(-2)`, not merely present in the row). Placement is correct:
  headings sit at lines 7/188/207/217/494/513/523 and the entry is at 386,
  inside `### Pipeline concepts`. See Finding 2 for the assertion's weakness.

### Mutation probes

Each probe was applied, the named test run, and the file reverted with
`git checkout --`.

| Probe | Expected to break | Result |
|---|---|---|
| `recordPathForLog` falls back to the full path instead of returning `undefined` for a non-`.log` | B-10 (`.txt`) | `× B-10 writes nothing when the stream's path yields no .log sibling` |
| `writeFileSync` appends `\n` to the prompt | B-02 | `× B-02 writes the prompt's exact bytes beside the invocation log` |
| the collision scan is bypassed (first name always returned) | both B-03 tests | `× B-03 takes the lowest free integer…`, `× B-03 fills a gap left by a hand-removed record` |
| `providerForRun` wraps unconditionally | B-06 reference equality | `× B-06 B-08 returns the identical provider for an unflagged argv` |
| `recordPrompts: config.recordPrompts ?? false` deleted from the emission | B-07 spawned | `AssertionError: expected undefined to be false` at `orchestrator.test.ts:2954` |
| `src/afk-claude.ts` wraps directly with `withPromptRecording` | B-08 source scan | `× B-08 routes afk-claude.ts's provider through providerForRun with the parsed flag` (the other two entries stayed green, so the assertion is per-entry) |

The B-04, B-05, second B-10 and B-09 tests stayed green under every mutation
above, which is the correct discrimination. No test in this slice asserts a
mock or passes on a name alone.

### Boundary compliance

22 files in the slice diff: the 13 declared paths, plus nine files under
`.kiro/specs/afk-v2-agent-eval-harness/slices/03-prompt-recorder/` — the
slice's own negotiation artifacts, which the scope lock explicitly leaves free
to the planner and evaluator. Nothing outside the declared list. No amendment
is needed and none is proposed.

### Preservation

- **P-01** — PASS. `src/agent-provider.ts`, `src/claude.ts`, `src/codex.ts`,
  `src/kiro.ts` and `src/invocation-runtime.ts` are absent from the slice diff.
  The recorder reads `logStream.path` through a local `const rawPath: unknown`
  and widens nothing.
- **P-02** — PASS, including the diff-review half the contract assigns to me.
  `src/run-events.ts` gains 5 lines: a 4-line doc comment and
  `recordPrompts?: boolean` on the `run-started` variant. Nothing else, and
  `EVENTS_SCHEMA_VERSION` still reads `1`. `src/orchestrator.ts` gains 8 lines:
  a 7-line doc comment plus `recordPrompts?: boolean` on `PipelineConfig`, and
  the single `recordPrompts: config.recordPrompts ?? false` property at
  `:7913`. That is exactly the three declared additions and no fourth line.
- **P-03** — PASS. The typed `run-started` literal with no `recordPrompts` key
  compiles and reads; asserted alongside `EVENTS_SCHEMA_VERSION === 1`.
- **P-04** — PASS. `AGENTS.md` and `CLAUDE.md` are absent from the slice diff.
  They appear in a `main`-merge-base diff only because of the pre-slice commit
  `0faf207`, which is not this slice's work.
- **P-05** — PASS, diff-review half included. The `src/orchestrator.test.ts`
  diff is one hunk of 28 added lines: a doc comment and a single `it` inside the
  existing `describe("focused generator scope revision")`, reusing that
  fixture's `repo` and `slug`. No `beforeAll`, no fixture setup, no new
  `describe`. The filtered probe run confirms it attaches to the existing
  spawned run rather than provoking a new one.
- The one declared change to existing behavior — `src/afk.ts` now passing
  `provider` explicitly — is behavior-preserving as the contract argues: with
  the flag off, `providerForRun` returns the identical `kiroProvider` that
  `config.provider ?? kiroProvider` (`src/orchestrator.ts:7898`) already
  supplied, so `pipelineRunSlug` and branch namespacing are unchanged.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

The module reads like the surrounding code: a file-header comment explaining
placement at the ADR 0002 seam, doc comments that state *why* rather than
restate the code (`wx` "is the guarantee, not an optimisation"), and the same
`.js`-suffixed relative imports as its neighbours. `providerForRun` is the
right call — one decision in one place, and the `cli-entries.test.ts` source
scan is what keeps it there. The handoff records the non-obvious decisions
(`? true : undefined` for the unset field, `unknown` for `rawPath` to dodge
TS2367, conditional `parseStreamLine` assignment) with reasons.

Test quality is high with one narrow exception: the tests exercise real files
in real temp directories, `afterEach` awaits every `stream.close(cb)` before
`rmSync` so a pending async open cannot throw ENOENT, and the `records()`
helper filters rather than snapshotting the whole listing, which correctly
avoids racing the log stream's own creation. Both new test files land in
`test:fast` (neither is in that script's exclude list), so they will actually
run. The exception is Finding 2.

Two notes that are not findings: `wrapped.parseStreamLine = (line) =>
inner.parseStreamLine!(line)` needs its non-null assertion because the closure
re-reads the narrowed member — idiomatic enough here; and the unbounded `for
(let k = 2; ; k++)` scan is deliberate per the handoff, since a cap would
silently drop a record.

## Resolved findings
- None. This is round 1 of this QA stage and no findings were routed to it.

## Findings
### Finding 1 — A record-write failure aborts the invocation it was only meant to observe
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/prompt-recorder.ts:68` —
`writeFileSync(recordPath, options.prompt, { encoding: "utf-8", flag: "wx" })`
runs inside `recordPrompt`, which the wrapper calls synchronously at
`src/prompt-recorder.ts:83` before `inner.invoke(options)`. There is no
`try`/`catch` anywhere in the module, and the three declared write-nothing
paths all return before this line. No test exercises a write that fails, and
the manifest does not require one.
**What the contract expected:** B-05 and B-10 both specify that a case the
recorder cannot serve "writes no file, does not throw, and still resolves to
the inner provider's result", and the contract frames the whole field as
"Evidence only". CONTEXT.md calls the record "the raw material for an eval
case's `prompt`" — not a precondition for running one.
**What I observed:** any `writeFileSync` error propagates out of `invoke`, so
the provider is never called and the invocation fails. The concrete reachable
case on this repo's platform is path length: the record swaps a 4-character
`.log` for a 10-character `.prompt.md`, so a log path already near Windows'
260-character limit produces a record path past it, and the write throws where
`createWriteStream` on the log succeeded. The run then fails with an error
attributed to the agent rather than to the flag. Advisory, not blocking: the
flag is opt-in, `--min-free-disk-gb` already guards the disk-full variant, and
the contract never asked for tolerance here — but a debug-only recorder that
can end a run is worth one line of guard.

### Finding 2 — The B-09 section-placement assertion passes vacuously if the heading disappears
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/prompt-recorder.test.ts:290-292` —
`expect(context.indexOf("**Prompt record**:")).toBeGreaterThan(context.indexOf("### Pipeline concepts"))`.
When the heading is absent `indexOf` returns `-1`, which any found entry index
exceeds, so the assertion cannot fail. It also never bounds the section's end.
The placement itself is correct today: CONTEXT.md's headings are at lines 7,
188, 207, 217 (`### Pipeline concepts`), 494, 513 and 523, and the entry is at
386.
**What the contract expected:** B-09 — "`CONTEXT.md` gains the **Prompt
record** entry with the text drafted at `prd.md:663-670`, under 'Pipeline
concepts' (`CONTEXT.md:217`)".
**What I observed:** the text assertions are exact and do fail when broken —
heading, first body line, `_Avoid_` line, and the `ARCHITECTURE.md` internals
column checked positionally via `columns.at(-2)`. Only the "under Pipeline
concepts" half is weak: it would also pass for an entry that drifted down into
`## Relationships` at line 494. Advisory; the documented behavior is right and
only this one guard is soft.
