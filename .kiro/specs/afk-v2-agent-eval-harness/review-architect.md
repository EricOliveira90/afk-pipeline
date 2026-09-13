# Architecture review — PRD 7 (afk-v2-agent-eval-harness), round 1

**Verdict:** ACCEPT-WITH-NOTES

## What I read

- `git diff main...HEAD` (106 files) in full for `src/`, `prompts/`, `ARCHITECTURE.md`,
  `CONTEXT.md`, `docs/adr/0066`, `docs/adr/0068`; sampled the eval packs and fixtures.
- The three slice contracts and handoffs under
  `.kiro/specs/afk-v2-agent-eval-harness/slices/{01-eval-runner,02-eval-seed-pack,03-prompt-recorder}/`.
- `src/eval-pack.ts`, `src/eval-compare.ts`, `src/eval-command.ts`, `src/eval-report.ts`,
  `src/prompt-recorder.ts`, the `src/cli-options.ts`/`src/afk*.ts`/`src/orchestrator.ts`/
  `src/run-events.ts` hunks, and the boundary suites
  (`src/eval-boundary.test.ts`, `src/eval-packs.test.ts`, `src/prompt-recorder.test.ts`).
- Greps to establish the notes below: `provider.invoke(` call sites across `src/`,
  `contractView|acceptanceManifest` in `src/context-envelope.ts`,
  `record-prompts|afk eval|--pack` in `README.md`, `AgentProvider` in `src/agent-provider.ts`.

## Structure: what this branch gets right

The harness is a genuine leaf. `src/eval-*.ts` reaches the pipeline only through the six
unmodified production parsers (`acceptance-manifest`, `contract-review`, `qa-review`,
`final-evaluation`, `planner-escalation`, `artifacts`), touches no `RunState`,
`RunJournal`, `events.jsonl` or `run-events` type, and the direction of that dependency is
asserted rather than described (`src/eval-boundary.test.ts` B-27, P-05, P-02). The CLI
entries gain one bare-token branch each, in the same shape as `stop`/`clean-failed`/
`adopt`, and the ARCHITECTURE.md module table gains exactly one row for it (line 36).
That is the right seam for a measurement tool that must never become a gate, and the
non-gating boundary is mechanised where a reviewer can see it (exit code non-zero iff no
`report.json` — `src/eval-command.ts:258-353`).

The recorder is placed at ADR 0002's `AgentProvider` seam as a decorator rather than
threaded through `InvokeOptions`/`invocation-runtime.ts`, and derives its filename from the
log stream the orchestrator already opens, so it inherits slice/role/round/attempt
encoding for free and adds no new naming authority. `providerForRun` makes the flag-on/
flag-off decision one unit-testable value used identically by all three entries, and
returns the identical `inner` reference when off — so an unflagged run is observably
unchanged (`src/prompt-recorder.test.ts` B-06/B-08). `recordPrompts` on `PipelineConfig`
is evidence-only and additive on `run-started`, consistent with `run-events.ts`'s existing
"absent in historical streams" convention.

`EVAL_PACK_VERSION`/`EVAL_REPORT_VERSION` each have a reader, refusal messages name the
file and the member, and `expected` is validated against the case's `role` before any
model call is spent — the schema authority sits in one table (`EXPECTED_SHAPE`) that is the
D9 row's data. Whole-pack refusal over per-case skipping is the right call for a
reproducible measurement, and it is documented at the top of the module.

## Notes (none blocking)

**A-01 — the prompt recorder's write failure is fatal to the invocation it decorates,
contradicting its own documented contract.** `src/prompt-recorder.ts:55-69`
(`recordPrompt`) calls `writeFileSync(recordPath, options.prompt, { flag: "wx" })` with no
`try`/`catch`, and `withPromptRecording` (lines 79-91) calls it before delegating, so any
`writeFileSync` throw — `ENOSPC`, `EACCES`, `ENAMETOOLONG` (the record adds 10 characters
to a log path that on Windows may already be near the path ceiling), or an `EEXIST` from
the TOCTOU window between the `existsSync` scan and the `wx` write — propagates
synchronously out of `AgentProvider.invoke`. The module's own doc comment says the opposite:
"Three ways to write nothing, all silent and none fatal". I read the call sites
(`src/orchestrator.ts:1102` and the `withTransientRetry(() => provider.invoke(...))` wrapper
at `8060-8063`) and a throw there is classified as an agent failure, i.e. a diagnostic flag
can consume a round or a retry for a model call that never happened. This is
infrastructure-only, opt-in (`--record-prompts`, default off), and leaves no durable
invalid state, so it is a note under this review's authority rules — but the fix is one
`try`/`catch` around the write that skips exactly as the three documented cases do (or
records the skip), and the doc comment should not claim fail-open behaviour the code does
not implement. Consider also that a diagnostic decorator failing a production round
inverts the priority `providerForRun`'s design otherwise respects.

**A-02 — `projectGeneratorContractView` is now called only for its exceptions, and the
role-scoping it encoded was retired silently.** ADR 0068 keeps `contractView` on
`GeneratorEnvelopeInput`, and `src/orchestrator.ts:5833` and `:7628` still call
`projectGeneratorContractView(contract)` — but grepping `contractView` in
`src/context-envelope.ts` returns only the interface declaration (line 207) and the comment
at 2021: nothing reads the string any more, since the evidence entry now carries
`locatorExemption` (lines 2113-2121). Two consequences worth recording. First, the only
remaining runtime effect of that projection is its `throw` on duplicated projected sections
(lines 1692-1696), which can still abort envelope assembly for a view nobody renders — a
validation masquerading as a projection. Second, `GENERATOR_CONTRACT_SECTIONS`
(lines 96-103) deliberately withheld "Files expected to change", "Migration requirements",
"Test plan" and "Definition of done" from the generator, per the section routing in
`docs/specs/afk-v2-agent-roles.md` §1; the new prompt tells the generator to open
`contract.md` and read it "in full", so it now sees the whole contract. That is very likely
an improvement, and it is not a data loss, but neither ADR 0068 nor the roles spec says the
routing changed. Either state the widening in the ADR/spec and delete the unused
projection (and the `contractView` input field), or keep the projection and have the prompt
name the sections the generator is held to. The same observation applies to
`currentContract`/`currentAcceptanceManifest` on the planner-revision input (declared at
`src/context-envelope.ts:1072,1084`, no longer read) — the comment at 1417-1424 explains why
they stay, which is fine as a transitional decision, but two envelopes now carry inputs
whose only role is to be ignored.

**A-03 — `afk eval` and `--record-prompts` are absent from README.md.** `README.md` is this
package's operator surface for consuming repos, and it documents the peer subcommands
(`afk stop` at line 68, `afk clean-failed` at line 227) and peer flags
(`--only-failed` line 106, `--guardian-round-cap` line 210). Grepping
`record-prompts|afk eval|--pack` in `README.md` returns nothing. The vocabulary and the
module table were updated (CONTEXT.md **Prompt record**, ARCHITECTURE.md line 36) and
`eval-packs/afk/README.md` is an excellent pack index, so nothing is undocumented for a
maintainer — but a consumer reading only README cannot discover either capability. Worth
one paragraph each next to `clean-failed`.

**A-04 — two small couplings to record rather than fix now.** (a) `src/eval-pack.ts:378`
re-exports `roleDispatch`/`EvalRoleDispatch` from `src/eval-compare.ts` solely because
`prd.md` D32's module table names `eval-pack.ts` as their home, while the implementation
correctly puts them beside the projection; the comment is honest about it, but the right
repair is the table, not a re-export that exists to satisfy a document (the reverse
`import type` from `eval-compare.ts:30` makes the pair a documentation-driven cycle that is
only harmless because it is type-only). (b) `withPromptRecording` enumerates
`AgentProvider`'s members by hand (`name`, `invoke`, `parseStreamLine`). That is exactly
right today — I checked `src/agent-provider.ts:184-190` and there are only three — but as
the repo's first provider decorator it establishes a pattern where a future interface member
is dropped silently. A comment on the interface pointing at the decorator, or a test that
enumerates the interface, would keep the two in step.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Prompt recorder write failure propagates out of AgentProvider.invoke, contrary to its documented fail-open behavior","class":"ROBUSTNESS","clearCondition":"recordPrompt catches write failures and skips (or records the skip) so a --record-prompts run cannot fail an invocation, and the module comment matches the code","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-02","title":"projectGeneratorContractView is computed but unread, and the generator's contract section routing widened without a spec change","class":"MAINTAINABILITY","clearCondition":"Either the unused contractView projection and input field are removed and ADR 0068 / afk-v2-agent-roles.md state that the generator now reads the whole contract, or the prompt again names the projected sections","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-03","title":"README.md documents neither the afk eval subcommand nor --record-prompts","class":"DOCUMENTATION","clearCondition":"README.md describes afk eval (pack, --max-calls, --out, --dry-run, report-only) and --record-prompts alongside the peer subcommands and flags","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true},{"id":"A-04","title":"Documentation-driven re-export in eval-pack.ts and hand-enumerated AgentProvider members in the first provider decorator","class":"COUPLING","clearCondition":"prd.md D32 names eval-compare.ts as roleDispatch's home and the re-export is dropped, and the decorator is guarded by a comment or test that keeps it in step with the AgentProvider interface","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true}]}
