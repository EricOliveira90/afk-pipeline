# PRD 7: Agent-behavior eval harness

**GH issue:** #152 — the parent contract. Its Problem Statement, Solution and
user stories are authoritative for *intent*; where its body still says
"disposition", "recorded-envelope replay", "20–50 scenarios" or "defines the
learning-proposal schema", `docs/specs/afk-v2-plan-debate.md` §7 (rulings
R1–R3, cited below as plan-debate §7) has amended it and this document
controls.
**Slice issues:** #262 (S1, Eval runner), #263 (S2, Eval seed pack, blocked by
#262), #264 (S3, Prompt recorder) — see `issues.md` in this directory.
**Parent design:** `docs/specs/afk-v2-plan.md` §2 (PRD 7 row), §3c policies 1
and 5, §3d item 18 (amended 2026-09-12), §4 ("PRD 5 and PRD 7 may run
concurrently"), §6; `docs/intent/agent-eval-harness.intent.md` (founder,
2026-09-02); `intent.md`, `decisions.md` and `decisions-review.md` in this
directory. `decisions-review.md` §3–§4 is the accepted answer set; every
D-item below names the `decisions.md` item it settles and its carrier the way
that review does.
**Binding ADRs:** 0002 (provider-agnostic at `AgentProvider`), 0036 (tool-call
cap is per invocation, opt-in), 0038 (generator verification command), 0041
(uncertain classification picks the branch that cannot loop), 0049 (ticket
lint), 0063 (spawned scenarios are the last-resort test), 0066
(learning-proposal schema — hand-landed, *not* this PRD).
**Written:** 2026-09-12 against `docs/prd7-spec` @ `0faf207` (= `main` @
`46f6c38` plus the rescope docs). Every `file:line` below was read on that
commit.

This document exists for one reason: **to leave the planner no load-bearing
decision to discover.** Everything below is a settled operator decision. Where
this document and #152 differ on a fact, this document controls and #152's
body is read through plan-debate §7; where it and a binding ADR differ, the ADR
controls.

## Verified facts this document rests on

Read on `0faf207`. A slice cites these rather than re-deriving them.

- **The prompt goes to the provider on stdin and is never written to disk.**
  Each provider returns an invocation descriptor with `stdin: prompt`
  (`src/claude.ts:183`, `src/codex.ts:278`, `src/kiro.ts:184`); the shared
  runtime pipes it (`src/invocation-runtime.ts:200-203`). The only durable
  trace is the `prompt-assembly` event (`src/run-events.ts:97-107`), which
  carries byte size and artifact ids, never content. No `--record-*` flag
  exists (`rg -- '--record' src` is empty).
- **`AgentProvider.invoke(options: InvokeOptions): Promise<InvokeResult>`**
  (`src/agent-provider.ts:184-190`). `InvokeOptions.prompt: string` (:27),
  `cwd: string` (:34), `role: string` (:20), `agent?: string` (:26),
  `bare?: boolean` (:81), `logStream?: WriteStream` (:36), `maxToolCalls?`
  (:50, per-invocation, ADR 0036). `InvokeResult = { exitCode, stdout, stats }`
  (:171-175); `InvocationStats` has optional `costUsd`, `toolCallCount`,
  `tokenCounts`, `nonCommandTimeMs` (:118-157). `toolCallCount` counts
  `tool_call` stream events (`src/invocation-runtime.ts:353`); nothing counts
  model requests.
- **The contract evaluator reads its inputs from disk and writes its verdict
  to disk.** `prompts/evaluator-contract.md:21` "Open and read
  `{{SLICE_DIR}}/contract.md`", `:25` the acceptance manifest, `:27-28` refuse
  with `REVISE` if either is unreadable, `:97` "Write
  `{{SLICE_DIR}}/{{CONTRACT_REVIEW_FILE}}`", `:122` "Exactly one verdict:
  `ACCEPT` or `REVISE`". The eight placeholders are `SLICE_DIR`,
  `CONTRACT_REVIEW_FILE`, `ROUND`, `ACCEPTANCE_MANIFEST_FILE`,
  `DURABLE_FINDING_LINEAGE`, `CONTROL_SITUATION`, `BASE_GATE_CATALOG`,
  `EXPLORER_CONTEXT`. A replay therefore needs a directory with files, not a
  prompt string alone.
- **How production invokes each role.** Planner: `{ role: "planner", prompt,
  cwd, logStream, maxDurationMs }` — no `agent`, no `bare`
  (`src/orchestrator.ts:1523-1530`). Contract evaluator: same shape with
  `role: "evaluator-contract"` (:1662-1669). QA evaluator: `role:
  "evaluator-qa"` (:5150-5209). Final evaluator: `role: "evaluator-final"`
  (:7181-7208). Guardians: `role` is `"architect-review"` or `"pm-review"`,
  `agent: role`, `bare: true`, cwd the review directory
  (`src/ship-gate.ts:707-764`); they write `review-architect.md` /
  `review-pm.md` (:709-710). Every production call site passes a `logStream`
  opened by `agentLog` (orchestrator `:1528, :1667, :3056, :5203, :5881,
  :7202, :7721`; ship-gate `:757`).
- **Production parsers and their verdict enums.** `parseContractReview`
  (`src/contract-review.ts:369`) → `ContractReview { version: 2; verdict:
  "ACCEPT" | "REVISE"; findings }` (:21, :86-90). `parseQAReview`
  (`src/qa-review.ts:346`) → `QAReview { version: 2; verdict: "PASS" | "FAIL";
  failureClass: "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE"; … }` (:16-20,
  :58-64). `parseFinalReview` (`src/final-evaluation.ts:305`) → `FinalReview {
  version: 1; verdict: "PASS" | "FAIL"; baselineTreeId; finalTreeId; findings
  }` (:139, :173-179). `parseGuardianReview(content, kind)`
  (`src/artifacts.ts:308`) → `{ outcome: "SHIP" | "ACCEPT-WITH-NOTES" |
  "FIX-BEFORE-SHIP" | "UNPARSEABLE"; findings }` (:39-43, :81-84) — it never
  throws; unparseable content is `outcome: "UNPARSEABLE"`.
  `readPlannerEscalation(sliceDir)` (`src/planner-escalation.ts:125`) returns
  `null` when no `planner-escalation.md` exists, `{ kind: "escalation" }` or
  `{ kind: "malformed" }`; `parseAcceptanceManifest`
  (`src/acceptance-manifest.ts:201`) validates the planner's manifest.
  `contract.md` has no structured parser (`parseContractFiles`,
  `src/artifacts.ts:449`, extracts only the file list).
- **`disposition` is taken.** `GuardianFindingDisposition = "OPEN" |
  "RESOLVED" | "REPEATED" | "REOPENED" | "REGRESSED"` (`src/artifacts.ts:62-67`)
  is a guardian finding's lifecycle; rumo-app's ledger uses the word for a
  routing outcome.
- **The stub-provider precedent** is `buildStubProvider`
  (`src/orchestrator.fixtures.ts:407-411`): an `AgentProvider` whose `invoke`
  reads `options.role` and `options.cwd`, writes the artifact a real agent
  would write, and pushes an `InvocationRecord` per call (:431-469).
- **CLI dispatch.** `src/afk.ts:35` `usage()`; bare-first-token dispatch for
  `status` (:49), `stop` (:72), `clean-failed` (:79), `adopt` (:82) before
  `parsePipelineRuntimeOptions` (:88). `src/afk-claude.ts:32` and
  `src/afk-codex.ts:32` carry `usage()` plus `stop` (:46) and `clean-failed`
  (:53) only. Command modules: `runStopCli(args, repoRoot, deps = {})`
  (`src/stop-command.ts:200`), `runAdoptCli(args, repoRoot, dependencies =
  DEFAULT_DEPS)` (`src/adopt-command.ts:655`), `runCleanFailedCli(args,
  provider?)` (`src/clean-failed.ts:399`). `afk` binds `kiroProvider` by
  default (`src/orchestrator.ts:7891`); `afk-claude`/`afk-codex` pass their
  provider into `runPipeline` (`src/afk-claude.ts:247`, `src/afk-codex.ts:247`).
- **Per-invocation log naming.** `agentLog(sliceId, agent, round?)` writes
  `slice-<sliceId>-<agent>[-r<round>].log` in the run directory, append mode
  (`src/logger.ts:243-247`; QA encodes `round * 10 + attempt` as the round,
  `src/orchestrator.ts:5155`; guardians use `sliceId = "all"`,
  `src/ship-gate.ts:744-748`).
- **Run evidence has no record of launch flags.** `run-started` carries
  `provider`, `runSlug`, `contractRoundLimit`, `implementationRoundLimit`
  (`src/run-events.ts:33-40`), emitted once at `src/orchestrator.ts:7900-7906`.
  `testCommand` reaches no event, no `run.log` line and no `run-summary.md`
  section. `EVENTS_SCHEMA_VERSION = 1` (`src/run-events.ts:26`); optional
  additive fields have kept it at 1 (comments at :235, :252, :293).
- **Version-constant precedents.** `GATE_EVIDENCE_VERSION = 3` with
  `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2, 3] as const`
  (`src/gate-runner.ts:43-49`, checked at :974); `RUN_STATE_VERSION = 5`
  (`src/run-state.ts:61`). `src/afk-manifest.ts` has no named constant (literal
  `version: 1` at :39, :160) — follow gate-runner, not afk-manifest.
- **AFK has no runtime dependencies** (`package.json` has no `dependencies`
  key); `bin` is `afk`, `afk-claude`, `afk-codex`; the only package export is
  `./afk-manifest` (`package.json:6-16`). `.gitignore:3` ignores `.afk/`.
  `vitest.config.ts` includes only `src/**/*.test.ts`.
- **Archived evaluator verdicts exist for PRD 4 only**, under
  `.afk/artifacts/afk-v2-acceptance-scope-gates-claude-code/slice-*/reviews/`
  in the operator's checkout (gitignored, not on any branch). Live `reviews/`
  directories (excluding `pre-restart-*/` and `*-record.json`):
  `contract-review-r*-a1.json` in slices 01 (r1), 02 (r1, r2), 03 (r1, r2),
  05 (r1–r3), 06 (r1–r3), 07 (r1, r2), 08 (r1) — 14 files; slice 04 has none.
  `qa-review-r*-a1.json` in all eight slices — 17 files (07 has five). The
  Codex run directory holds `slice-01/{context.md, planner-escalation.md,
  stuck.md}` (plus `pre-restart-1/`, `pre-restart-2/`) and no reviews.
- **Run 5's steering defect** is recorded at `AGENTS.md:74-77` (the bare
  `test:fast` launch; 8 generator commits over code that did not compile),
  `docs/adr/0041-uncertain-classification-picks-the-branch-that-cannot-loop.md:8-10`
  (run `run-20260827-1442*`, slice #79),
  `docs/specs/afk-v2-recovery-plan.md:515-518`, and #120 (CLOSED). Its agent
  face is the classification question ADR 0041 settled: a candidate-owned
  compile failure is `IMPLEMENTATION`, never `INFRASTRUCTURE`.
- **`ContextEnvelopeRole`** = `"explorer" | "planner" | "evaluator-contract" |
  "generator" | "evaluator-qa" | "evaluator-final"`
  (`src/context-envelope.ts:746-762`). It includes two roles whose output is
  not a verdict and excludes the guardians.

## Constraints inherited, not negotiable in this PRD

Each is a recorded decision. A slice that needs to break one escalates as a
**spec contradiction** under plan §3c policy 1 — it does not decide.

| Constraint | Source |
|---|---|
| Results never gate a merge. Report-only. | `docs/PRODUCT.md` "No merge-gating on agent-eval results" (:106-107); plan §3 and §6. Re-opens only on repeated evidence of stable results with an agreed false-positive rate. |
| Compare exact structured output in v1. No model-based grader. | Source intent "Resolved decisions"; plan §3d item 18. |
| Enforce a model-call cap; report `INCOMPLETE` when it stops a run. | Source intent; item 18. |
| Runs are weekly and operator-invoked. No CI schedule. | Item 18. CI scheduling waits for item 21's filtered-environment pattern (#135). |
| AFK owns the runner; consumers own packs. | Source intent; rumo-app governance-evals intent, which declines to build a runner. |
| Reuse the recorded envelope format. Do not invent a parallel fixture format. | Source intent, read per plan-debate §7 R2: no envelope file format exists, so the case input is the exact `AgentProvider.invoke` prompt string and the runner dispatches through `AgentProvider.invoke`. |
| Provider-agnostic at the interface. | ADR 0002; PRODUCT.md principle 9. The runner and the recorder plug in at `AgentProvider`, never inside a provider. |
| Deterministic checks live in the gate catalog, never in provider hook config. | Plan §3c policy 6; PRODUCT.md principle 9. |
| A new persisted fact carries a schema version and a reader. | `ARCHITECTURE.md` placement rules. A record no reader checks is decoration (plan §3 item 11). |
| New machinery defaults off, opt-in, with enable/disable recorded. | PRODUCT.md principle 7 (:68-69). |
| Nothing adds minutes to the happy path. | PRODUCT.md principle 4. `afk eval` runs outside a pipeline run, so its cost must not touch one. |
| A new deterministic check is a declared gate, not prompt prose; new behavior extends a seam, not a hub. | `ARCHITECTURE.md` "Hubs" (:37-42). `src/orchestrator.ts` and `src/wave.ts` do not grow for this. |
| The learning-proposal schema is AFK-canonical and lands by hand on `main`, not in this PRD. | plan-debate §7 R1; plan §2 PRD 6 row, §3d item 19, §6; ADR 0066, `src/learning-proposal.ts` on `feat/learning-proposal-schema` @ `782091d`; rumo-app #888. |
| A new spawned pipeline scenario is the last-resort test. | `AGENTS.md`, `CLAUDE.md`, ADR 0063. Eval scenarios are not pipeline spawns and must not become them. |

## Scope rulings already taken (plan-debate §7)

- **R1** — the learning-proposal schema is out. `LEARNING_PROPOSAL_VERSION =
  1`, `parseLearningProposals`, the `afk-pipeline/learning-proposal` export,
  ADR 0066 and the `CONTEXT.md` **Learning proposal** entry live on
  `feat/learning-proposal-schema` @ `782091d`; rumo-app #888 tracks adoption.
  `decisions.md` D25–D30 and D37 are closed there and are not restated here.
- **R2** — one case kind, `prompt-plus-expected-verdict`. D3 (keying), D4
  (`STALE`), D5 (redaction) and D7's per-kind fields are dropped.
- **R3** — every case cites a `source`; the count is what the sources yield.

## What was still undecided, and what is decided now

### D7 — the pack member, field by field (settles `decisions.md` D7)

A **scenario pack** is a directory. Every `*.json` file directly inside it is
one **eval case**; subdirectories are not scanned for cases and hold fixture
content only. The pack path is passed on the command line (D8). Each case file
is one JSON object with **exactly** these seven members — an unknown top-level
member, a missing member, or a `version` outside D13's supported set
**refuses the whole pack** naming the file and the member:

```json
{
  "version": 1,
  "id": "194-contract-evaluator-false-premise-casing",
  "role": "evaluator-contract",
  "source": "#194 — run-20260908-014522 slice-01 evaluator-contract r1 (F-03)",
  "prompt": "<the exact string AgentProvider.invoke received>",
  "files": {
    "slice/contract.md": "<inline content>",
    "slice/acceptance-manifest.json": { "fromFile": "fixtures/194-manifest.json" }
  },
  "expected": { "verdict": "ACCEPT" }
}
```

TypeScript shape, exported from `src/eval-pack.ts`:

```ts
export type EvalRole =
  | "evaluator-contract" | "evaluator-qa" | "evaluator-final"
  | "planner" | "pm" | "architect";
export type EvalFileContent = string | { fromFile: string };
export interface EvalCase {
  version: 1;
  id: string;            // ^[a-z0-9][a-z0-9-]{0,79}$ ; unique within the pack
  role: EvalRole;        // D12
  source: string;        // non-blank; issue, run or artifact reference
  prompt: string;        // non-blank; the exact InvokeOptions.prompt
  files: Record<string, EvalFileContent>; // required; may be {}
  expected: EvalExpected; // D9, validated against `role`
}
export interface EvalPack { version: 1; dir: string; cases: EvalCase[] }
```

Rules the reader enforces, each refusing the pack with file and field named:
`id` matches the pattern above and is unique across the pack (it names a
scratch directory and a log file); `source` and `prompt` are non-blank
strings; every `files` key is a relative path with forward slashes, no
leading `./` or `/`, no `..` segment, no drive letter; an inline value is
written as UTF-8 bytes exactly as given (no newline normalisation, no BOM); a
`{ fromFile }` value names a path under the pack directory, resolved relative
to the case file's directory, subject to the same path rules, and copied
byte-for-byte; a `fromFile` target that does not exist refuses the pack at
read time, before any model call. A pack with zero case files is refused: a
pack with nothing to run is a mistake, not a `COMPLETE` run.

There is no per-case budget, no discriminator, no per-kind field (R2). `id`
is a human-chosen slug; `source` carries provenance; there is no hash.

*Test fired: load-bearing silence about a data format.* Carrier: PRD 4 D1's
precedent (name the JSON, not the concept); `evaluator-contract.md:21-28`
makes `files` mandatory.

### D9 — the projection and the `expected` shape, per role (settles D9, D10, D11)

"Exact" means exact over a **named projection** of the role's parsed output
artifact. The projection is the role's top-level verdict enum plus one named
secondary enum where the incident class lives. No findings, no ids, no prose,
no tree ids. Because no projected field is a collection, D11's set semantics
are moot: comparison is field-by-field string equality.

| `role` | Production `InvokeOptions` the runner reproduces | Output artifact the runner looks for | Parser (D10) | Projection = `expected` shape |
|---|---|---|---|---|
| `evaluator-contract` | `{ role: "evaluator-contract", prompt, cwd, logStream }` | `contract-review.json` | `parseContractReview` | `{ verdict: "ACCEPT" \| "REVISE" }` |
| `evaluator-qa` | `{ role: "evaluator-qa", prompt, cwd, logStream }` | `qa-review.json` | `parseQAReview` | `{ verdict: "PASS" \| "FAIL", failureClass: "NONE" \| "IMPLEMENTATION" \| "INFRASTRUCTURE" }` — both required |
| `evaluator-final` | `{ role: "evaluator-final", prompt, cwd, logStream }` | `final-review.json` | `parseFinalReview` | `{ verdict: "PASS" \| "FAIL" }` |
| `planner` | `{ role: "planner", prompt, cwd, logStream }` | `planner-escalation.md`, else `acceptance-manifest.json` + `contract.md` | `readPlannerEscalation`, `parseAcceptanceManifest` | `{ artifact: "CONTRACT" \| "ESCALATION" }` |
| `pm` | `{ role: "pm-review", agent: "pm-review", bare: true, prompt, cwd, logStream }` | `review-pm.md` | `parseGuardianReview(_, "pm")` | `{ outcome: "SHIP" \| "ACCEPT-WITH-NOTES" \| "FIX-BEFORE-SHIP" \| "UNPARSEABLE" }` |
| `architect` | `{ role: "architect-review", agent: "architect-review", bare: true, prompt, cwd, logStream }` | `review-architect.md` | `parseGuardianReview(_, "architect")` | same as `pm` |

```ts
export type EvalExpected =
  | { verdict: "ACCEPT" | "REVISE" }                                   // evaluator-contract
  | { verdict: "PASS" | "FAIL";
      failureClass: "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE" }     // evaluator-qa
  | { verdict: "PASS" | "FAIL" }                                       // evaluator-final
  | { artifact: "CONTRACT" | "ESCALATION" }                            // planner
  | { outcome: "SHIP" | "ACCEPT-WITH-NOTES" | "FIX-BEFORE-SHIP" | "UNPARSEABLE" }; // pm, architect
```

The reader validates `expected` **against the case's `role`** at read time: a
missing key, an extra key, or a value the role's parser could never produce
refuses the pack before a model call is spent.

**Artifact lookup.** After the invocation returns, the runner searches the
case's scratch directory (D34) recursively for the artifact filename in the
table. Exactly one match is parsed; zero matches is `ERROR` ("role wrote no
`<filename>`"); two or more is `ERROR` listing them. For `planner`: a
`planner-escalation.md` that `readPlannerEscalation` reads as `{ kind:
"escalation" }` is `artifact: "ESCALATION"`; `{ kind: "malformed" }` is
`ERROR` with the defect; with no sentinel, exactly one
`acceptance-manifest.json` that `parseAcceptanceManifest` accepts **and** a
`contract.md` beside it is `artifact: "CONTRACT"`; anything else is `ERROR`.
No case declares where its artifact lands — the prompt already says so, and a
second declaration of the same path would be a second place to be wrong.

**Parser behavior is the projection's behavior.** A parser that throws makes
the case `ERROR` with the parser's message (this replaces D4's `STALE`).
`parseGuardianReview` never throws, so `UNPARSEABLE` is a legal `outcome` a
case may expect; a guardian that emits an unparseable review against an
expectation of `SHIP` is a `MISMATCH`, which is the behavior the maintainer
wants to see as data. A non-zero `InvokeResult.exitCode` is `ERROR` naming the
code; the artifact is not consulted. A `TransientProviderError` or any other
rejection from `invoke` is `ERROR` with the message — **the runner never
retries an invocation** (D14: one case is one call).

The runner passes `agent` and `bare` exactly as production does. What a
provider does with them is the provider's behavior, unchanged; a case whose
provider needs an agent config in the working directory seeds it through
`files`. The AFK-owned pack targets the Claude backend, which is where every
seed artifact came from and where `bare: true` makes `agent` inert.

*Test fired: load-bearing silence about a data format.* Carrier: source intent
"exact structured dispositions" read as verdicts; PRODUCT.md principle 5
(start narrow, widen on evidence); PRD 4 D19's rule that validation and
verdict must describe the same parsed document.

### D12 — `EVAL_ROLES` (settles D12)

```ts
export const EVAL_ROLES = [
  "evaluator-contract", "evaluator-qa", "evaluator-final",
  "planner", "pm", "architect",
] as const;
```

A `role` outside this list refuses the pack. `ContextEnvelopeRole` is the wrong
set on both sides — it includes `explorer` and `generator`, whose output is a
document and code rather than a verdict, and excludes the guardians. The
generator is not an eval role in v1; its judgment is measured by the suites.
Carrier: `decisions-review.md` §4 D12.

### D13 — the version constants and the reader (settles D13)

```ts
/** Bump when a v1 pack could be read differently; TSDoc records why. */
export const EVAL_PACK_VERSION = 1;
export const SUPPORTED_EVAL_PACK_VERSIONS = [1] as const;
export function readEvalPack(dir: string): EvalPack; // throws on refusal
```

Every case file carries `version`; the reader refuses a directory whose files
disagree, and refuses any value outside the supported set, naming the file.
Precedent: `GATE_EVIDENCE_VERSION` / `SUPPORTED_GATE_EVIDENCE_VERSIONS`
(`src/gate-runner.ts:43-49`). The report gets its own constant,
`EVAL_REPORT_VERSION = 1`, in `src/eval-report.ts` (D20), with a reader
`readEvalReport(path)` — the persisted-fact rule wants a reader, and the
runner's own tests are that reader's first consumer.

### D8 — pack layout (settles D8)

A directory of `*.json` case files, no index file, no `afk.config.json` key.
The pack path is `--pack <dir>` on the command line, required. **Declared
order is the byte-wise ascending order of case file names**; authors prefix
`01-`, `02-` to control it. Two things to keep in sync became one. Carrier:
`decisions-review.md` §4 D8.

### D14, D15, D16, D17 — the cap (settle D14–D17)

- **One model call = one `AgentProvider.invoke`.** One case is exactly one
  call, so the cap is "cases dispatched" — honest, deterministic, and needing
  no provider surface. `costUsd` and `toolCallCount` are *recorded* per case
  when the provider reports them and never capped; they are absent, never 0,
  when unreported (the `nonCommandTimeMs` rule, `src/agent-provider.ts:149-154`).
- **`--max-calls <n>`**, integer ≥ 1, default **50**; anything else is a
  usage error (exit 2). No `afk.config.json` key. The pack cannot raise or
  lower it.
- **One budget for the whole run, checked before each dispatch.** Before case
  *k* is dispatched, if `callsUsed >= maxCalls` then case *k* and every
  later case is `NOT-RUN` and the report's `status` is `INCOMPLETE`. A
  failed invocation still counts as a call.

Carrier: PRODUCT.md "No speculative provider features"; ADR 0036;
`decisions-review.md` §3 D14, §4 D15.

### D19 — execution order (settles D19)

Declared order (D8), sequential, no parallelism. Two runs of the same pack
with the same cap report the same `NOT-RUN` set.

### D34 — the scratch directory (settles D34)

Each dispatched case runs in a **fresh temporary directory** created with
`mkdtempSync` under the OS temp directory with prefix `afk-eval-<id>-`,
seeded from `files` before dispatch. `InvokeOptions.cwd` is that directory,
so the role's tool use finds only what the case declares and the provider's
own working-directory discovery (a repository's `CLAUDE.md`, `.kiro/`) sees
nothing of the AFK checkout. The role's artifact is looked up there (D9). The
directory is **removed after a `MATCH`** and **kept after `MISMATCH` or
`ERROR`**, with its path recorded as the case's `scratchDir` in the report,
so a maintainer can read what the role actually wrote. This is not a sandbox
(intent.md "Out of scope"); it is determinism by construction rather than by
author discipline.

The runner touches **no git**: no worktree, no branch, no `run-identity`, no
`RunState`, no `.afk/state`, no `.afk/logs`. Carrier: `decisions-review.md`
§4 D34; `src/run-identity.ts` derives branch names from `provider.name`, so
reusing pipeline identity would create branches.

### D20, D22 — the report (settle D18, D20, D22)

`afk eval` is not a pipeline run: **no `RunJournal`, no run directory, no
`events.jsonl`, no new `run-events` type.** It writes a standalone report
under an **eval output directory**, `--out <dir>`, default `<repoRoot>/.afk/eval`
(gitignored by `.gitignore:3`; a report is a measurement, and a committed
measurement invites a diff-based gate). Each run creates
`<out>/eval-<YYYYMMDD-HHmmss>/` holding `report.json` and one
`<case-id>.log` per dispatched case (the provider's raw stdout, via
`InvokeOptions.logStream`, the same convention as the pipeline's agent logs).

`report.json` (`EVAL_REPORT_VERSION = 1`, type `EvalReport` in
`src/eval-report.ts`):

```ts
export interface EvalReport {
  version: 1;
  status: "COMPLETE" | "INCOMPLETE";   // INCOMPLETE iff any case is NOT-RUN
  provider: string;                    // provider.name
  pack: string;                        // absolute pack path
  packVersion: 1;
  startedAt: string; finishedAt: string; // ISO-8601 UTC
  maxCalls: number;
  callsUsed: number;                   // invocations dispatched
  costUsd?: number;                    // sum; present only if every dispatched case reported one
  counts: { MATCH: number; MISMATCH: number; "NOT-RUN": number; ERROR: number };
  cases: EvalCaseResult[];             // declared order
}
export interface EvalCaseResult {
  id: string; role: EvalRole; source: string;
  outcome: "MATCH" | "MISMATCH" | "NOT-RUN" | "ERROR";
  expected: EvalExpected;
  actual?: EvalExpected;               // MATCH and MISMATCH only
  error?: string;                      // ERROR only
  callsUsed: 0 | 1;
  costUsd?: number; toolCallCount?: number; durationMs?: number;
  scratchDir?: string;                 // kept directories only (D34)
}
```

Completed cases keep their results when the cap stops a run; the remainder
are `NOT-RUN`; the report says `INCOMPLETE` and carries **no aggregate other
than the four counts** (D24). `INCOMPLETE` surfaces in exactly two places:
`report.json` `status` and the stdout summary line. No Markdown renderer.

**Stdout.** One line per case as it completes —
`[<k>/<n>] <id> (<role>) <outcome>` — and one summary line last:

```
afk eval <COMPLETE|INCOMPLETE>: MATCH <n> / MISMATCH <n> / NOT-RUN <n> / ERROR <n> — calls <used>/<max> — <path to report.json>
```

Carrier: `decisions-review.md` §3 D18, D20; §4 D22; ARCHITECTURE.md hubs rule;
CONTEXT.md **RunJournal**.

### D21 — exit status (settles D21)

**Exit 0 whenever `report.json` was written**, whatever the outcomes: a
pure-`MISMATCH` run exits 0, an `INCOMPLETE` run exits 0, a run whose every
case is `ERROR` exits 0. **Exit 2** for a usage error, a refused pack, or an
output directory that cannot be created — nothing dispatched, no report.
**Exit 1** when the runner itself threw after dispatch began — no report, or a
partial one is not written. The mechanical statement: *the exit code is
non-zero if and only if no `report.json` exists for the run.* `--dry-run`
reads and validates the pack, prints the case list (`<id> (<role>) — <source>`),
dispatches nothing, writes nothing, and exits 0 or 2.

This is the non-gating boundary in mechanical form; a non-zero exit is how a
shell script becomes a gate. S1 ships three tests: a pure-mismatch run exits
0; an `INCOMPLETE` run exits 0; and a source-level test that no module other
than `src/eval-*.ts` and the three CLI entries imports an `eval-*` module —
in particular not `src/orchestrator.ts`, `src/wave.ts`, `src/ship-gate.ts`,
`src/preship.ts`, `src/gate-runner.ts`, `src/base-gates.ts`,
`src/candidate-gate-phase.ts`, `src/post-qa-gates.ts`. Carrier: PRODUCT.md
"No merge-gating on agent-eval results"; intent.md success measures 1 and 4.

### D23, D24 — outcomes and no rate (settle D23, D24)

Four outcome words, exactly: **`MATCH`** (every projected field equal),
**`MISMATCH`** (parsed, projected, at least one field differs), **`NOT-RUN`**
(the cap stopped the run before this case), **`ERROR`** (invocation rejected
or exited non-zero, artifact missing or ambiguous, parser threw). There is no
`STALE` (D4 dropped). **No pass rate, ratio or percentage anywhere** — not in
the report, not on stdout. Counts carry the same information without a
quotable headline. Carrier: PRODUCT.md principle 5 ("never gates until proven
stable"); plan §6.

### D31 — what replay replays (settles D31)

The runner replays a recorded **input** (the case's `prompt` and `files`)
against a **live model** through `AgentProvider.invoke`, and compares the
fresh output to the recorded `expected`. It never replays recorded outputs —
that would test the parsers, which the suites already do. Consequence: every
dispatched case costs a real invocation, which is why the cap and the weekly
cadence exist, and why anything that needs no model call belongs in a unit
test, not in a pack (H2).

### D32, D33, D35 — placement, CLI attachment, tests (settle D32, D33, D35)

New modules, none of them hubs:

| Module | Exports |
|---|---|
| `src/eval-pack.ts` | `EVAL_PACK_VERSION`, `SUPPORTED_EVAL_PACK_VERSIONS`, `EVAL_ROLES`, `EvalRole`, `EvalCase`, `EvalExpected`, `EvalPack`, `readEvalPack(dir)`, `validateEvalCase(value, source)` (pure, for tests), `roleDispatch(role)` → the D9 row (`invokeOptions` template, `artifactFile`, `parse`, `project`) |
| `src/eval-compare.ts` | `projectOutput(role, scratchDir): EvalExpected` (D9 lookup + parser + projection; throws → `ERROR`), `compareProjection(expected, actual): "MATCH" \| "MISMATCH"` — pure |
| `src/eval-report.ts` | `EVAL_REPORT_VERSION`, `EvalReport`, `EvalCaseResult`, `EvalOutcome`, `writeEvalReport(dir, report)`, `readEvalReport(path)`, `formatEvalSummary(report, reportPath): string`, `formatCaseLine(k, n, result): string` — pure except the two file functions |
| `src/eval-command.ts` | `runEvalCli(args: readonly string[], repoRoot: string, provider: AgentProvider, deps: EvalCliDeps = DEFAULT_EVAL_DEPS): Promise<{ output: string; exitCode: 0 \| 1 \| 2 }>` — parses `--pack`, `--max-calls`, `--out`, `--dry-run`; `EvalCliDeps` carries `now()`, `mkScratchDir(id)` and `stdout(line)` so tests inject a clock, a temp root and capture streaming lines |

`runEvalCli` takes the provider as a parameter because each entry binds one
(`runCleanFailedCli(args, provider?)` is the precedent) — the D32 signature
`runEvalCli(args, repoRoot)` in `decisions.md` is widened by that one argument
and by the `deps` object `runStopCli` and `runAdoptCli` already use.

**All three CLI entries** gain `if (args[0] === "eval")` before
`parsePipelineRuntimeOptions`, delegating to `runEvalCli(args.slice(1),
resolve("."), <that entry's provider>)` and printing `output` to stdout on
exit 0 and stderr otherwise — the `stop`/`adopt` pattern at `src/afk.ts:72-86`.
`afk eval` binds `kiroProvider`; `afk-claude eval` the Claude provider;
`afk-codex eval` Codex. Each `usage()` gains one line:

```
afk eval --pack <dir> [--max-calls <n>] [--out <dir>] [--dry-run]
```

(`afk-claude` / `afk-codex` substituted.) `src/orchestrator.ts` and
`src/wave.ts` are not touched by S1 or S2. `ARCHITECTURE.md` gains one
"Agent eval" row (public seam `src/eval-command.ts`; internals the other
three).

**Tests are unit tests over a stub `AgentProvider`** in the
`buildStubProvider` mould: an `invoke` that reads `options.role` and
`options.cwd`, writes the artifact a fixture names into `cwd`, returns a
fixture `InvokeResult`, and records the call. It lives in
`src/eval.fixtures.ts`. Pack reading, validation, projection, comparison,
cap accounting, report shape, exit codes and the stdout lines are all
assertable without git and without a live agent. **No eval scenario is ever
run by `pnpm test`**: `vitest.config.ts` includes only `src/**/*.test.ts`, the
packs live outside `src/`, and the only tests that read a pack read it with
`readEvalPack` and dispatch it — if at all — to the stub. A live-model run is
an operator action, never a test. Carrier: ADR 0063; `AGENTS.md` "Where a new
assertion goes"; `decisions.md` D35.

### D2 — the seed pack: sources, roles, expected values (settles D2)

The AFK-owned pack is `eval-packs/afk/` at the repo root. **Every case carries
a `source`; the count is what the sources yield** (R3). S2 owns the exact
prompt text and `files` of each case (a slice-default under
`decisions-review.md` §5); the sources, the role each yields, and the
expected projection are fixed here so S2 reconstructs rather than decides:

| Source | Yields | `role` | `expected` | Inputs to reconstruct the prompt from |
|---|---|---|---|---|
| **#192** — planner escalated `LOAD_BEARING_SILENCE` three times on PRD 4 slice 01 | 3 cases | `planner` | `pre-restart-1` (D1 `gatePolicy` shapes) → `ESCALATION`; `pre-restart-2` (D5 waiver `path`) → `ESCALATION`; final (D6 glob dialect, decided by "no runtime dependencies") → `CONTRACT`. #192 itself records that two of the three were correct escalations. | `.afk/artifacts/afk-v2-acceptance-scope-gates-codex/slice-01/{pre-restart-1,pre-restart-2,.}/{context.md,planner-escalation.md}`, the #84 issue body as it stood on 2026-09-07, `prd.md` of PRD 4 at `de7b0ec`, `prompts/planner.md` |
| **#194** — contract evaluator blocked on the false premise that `fileScope` comparison is case-sensitive | 1–2 cases | `evaluator-contract` | `{ verdict: "ACCEPT" }` — F-03 was the only BLOCKING finding and its premise is false (`normalizePath` lowercases, `src/acceptance-manifest.ts:64-71`) | `…-claude-code/slice-01/reviews/contract-review-r1-a1.json` (run `run-20260908-014522`) and `pre-restart-*/` for `run-20260908-005855`, the archived `contract.md` + `acceptance-manifest.json` + `feedback-r1-a1.md` |
| **Run 5's steering defect** (#120, ADR 0041, `AGENTS.md:74-77`) | 1 case | `evaluator-qa` | `{ verdict: "FAIL", failureClass: "IMPLEMENTATION" }` — a candidate-owned compile failure is never `INFRASTRUCTURE`; the agent-judgment face of the classification ADR 0041 made deterministic | hand-authored: a minimal project in `files` whose `typecheck` fails on a candidate-introduced type error, prompt rendered from `prompts/evaluator-qa.md` |
| **PRD 4's archived evaluator verdicts** | 4–8 cases | `evaluator-contract`, `evaluator-qa` | the recorded verdict, **only where a human later bore it out** — the slice merged on that verdict, or the planner accepted the `REVISE` finding. A recorded verdict is not an expectation until confirmed; #194's F-03 is a recorded verdict that was wrong | the `reviews/` directories listed under "Verified facts": at most one contract case and one QA case per slice where the archived `contract.md`, manifest and feedback suffice to reconstruct the prompt |

Roughly **9–14 cases** for v1. Dropped, with reasons recorded in H2: PRD 1
envelopes (none exist), #111–#121 (orchestrator defects), classifier cases
(deterministic code, unit tests). Because no prompt was recorded for any of
these, every seed prompt is **hand-reconstructed** from the archived inputs
and the template as it stood at the time; `source` says so. After S3 ships,
incident cases are cut from recorded prompts instead.

**The fixture consumer pack** is `eval-packs/fixtures/consumer-governance/`:
one `pm` case shaped like a rumo-app governance scenario (a `pm-review`
prompt over a small diff and a `PRODUCT.md` in `files`, expected
`{ outcome: "FIX-BEFORE-SHIP" }`), plus one deliberately malformed sibling
pack `eval-packs/fixtures/refused/` (an unknown top-level member) for the
refusal tests. Both are read by unit tests with `readEvalPack` and dispatched
only to the stub. Carrier: R3; PRODUCT.md principle 5; `decisions-review.md`
§3 D2.

### D1, D6 — the prompt recorder (settles D1, D6)

**`--record-prompts`** is a boolean launch flag on all three pipeline entries,
parsed in `parsePipelineRuntimeOptions` (`src/cli-options.ts:239-241` is the
boolean-flag precedent) into `PipelineRuntimeOptions.recordPrompts?: boolean`.
**Default off.** When on, every provider invocation's exact
`InvokeOptions.prompt` is written **beside its per-invocation log**:

```
slice-<NN>-<role>[-r<N>].log         ← exists today (src/logger.ts:243-247)
slice-<NN>-<role>[-r<N>].prompt.md   ← the recorded prompt, bytes unchanged
```

The name is derived from the log's own path — `String(logStream.path)` with
the trailing `.log` replaced by `.prompt.md` — so the recorder reuses whatever
slice, role, round and attempt encoding the log already carries (QA's
`round * 10 + attempt`, the guardians' `all`). If that path already exists
(the log is opened in append mode for a legitimate same-round reopen), the
next record is `….prompt.2.md`, `….prompt.3.md`, … — never appended, never
overwritten, so each file is one copy-pasteable `prompt`. The content is the
prompt string alone: no header, no fence, no metadata. Redaction is not a
question the recorder creates: `.afk/` is gitignored and the `.log` beside it
already quotes the same sources (`decisions-review.md` §3 D5).

**Placement is a provider wrapper, not an orchestrator edit.**
`src/prompt-recorder.ts` exports
`withPromptRecording(inner: AgentProvider): AgentProvider` — `name` is the
inner's (branch namespacing must not change), `parseStreamLine` is forwarded
when present, and `invoke` writes the record then delegates. Each CLI entry
wraps its provider when the flag is set and passes the result as
`config.provider` (`src/afk.ts` today relies on the `kiroProvider` default at
`src/orchestrator.ts:7891` and must pass it explicitly when wrapping). An
invocation with no `logStream` is written nowhere — none exists in production
today (see "Verified facts"), and a future call site without a log is already
an unlogged invocation. This plugs in at ADR 0002's seam; no provider and no
`InvokeOptions` field changes.

**Enabled/disabled is recorded in run evidence**, PRODUCT.md principle 7: the
`run-started` event (`src/run-events.ts:33-40`) gains
`recordPrompts?: boolean`, optional in the type for historical streams and
**always written** by a new run from `config.recordPrompts ?? false` at the
single emission site (`src/orchestrator.ts:7900-7906`). Additive, so
`EVENTS_SCHEMA_VERSION` stays 1 (the precedent at :235, :252, :293). No
`run.log` line, no `run-summary.md` section: one channel. This is S3's only
edit to `src/run-events.ts` and to `src/orchestrator.ts` (the event property
and the matching optional field on `PipelineConfig`, :544 region), and it is
the one place PRD 7 touches a file PRD 5 also touches — see "Concurrency with
PRD 5".

`AGENTS.md`'s self-run launch section will add `--record-prompts` to the
convention beside `--test-command` **after S3 merges, by hand**; it is not
S3's edit, because the convention must not claim a flag that is not yet on
`main`. Carrier: `decisions-review.md` §3 D1, §4 D6; PRODUCT.md principle 7.

### D36 — vocabulary and the `CONTEXT.md` entries (settles D36)

Everything `afk eval` emits or documents says **verdict** for an agent's
structured output and **never `disposition`** — AFK's `GuardianFindingDisposition`
and rumo-app's ledger already hold two meanings. `outcome` is kept only where
production already calls it that (the guardians' `ReviewVerdict` field). S1
adds these entries to `CONTEXT.md` under "Pipeline concepts", in the file's
existing format (`**Term**:` line, wrapped prose, `_Avoid_` line):

```
**Envelope**:
The exact prompt string one agent invocation receives — the `prompt` field of
`InvokeOptions`, assembled by the orchestrator and piped to the provider on
stdin. It is never persisted by a pipeline run; `--record-prompts` writes a
copy beside the invocation's log (see **Prompt record**). An eval case's
`prompt` is an envelope.
_Avoid_: "context", "fixture", "transcript" (a transcript includes the reply)

**Scenario pack**:
A directory of `*.json` eval cases read by `afk eval`. Every file carries the
pack schema `version`; the reader refuses the whole pack on an unknown member,
an unsupported version, or files that disagree on version. AFK owns
`eval-packs/afk/`; consuming projects own their own packs.
_Avoid_: "test suite", "golden set", "benchmark" (nothing here gates or scores)

**Eval case**:
One member of a scenario pack: a `role`, a required `source` naming the issue,
run or artifact it came from, the envelope (`prompt`), the `files` seeded
into a fresh scratch directory, and the `expected` projection of the role's
verdict. Replayed against a live model through `AgentProvider.invoke`; never
replays a recorded reply.
_Avoid_: "scenario" alone, "test case", "recorded envelope" (one case kind)

**Eval outcome**:
The per-case result `afk eval` reports: `MATCH`, `MISMATCH`, `NOT-RUN` (the
model-call cap stopped the run first) or `ERROR` (invocation, artifact or
parser failure). Reported as counts and a per-case table, never as a rate; a
run with any `NOT-RUN` case is `INCOMPLETE`. Never read by a gate.
_Avoid_: "pass", "fail", "pass rate", "disposition", "score"
```

S3 adds a fifth:

```
**Prompt record**:
The `slice-<NN>-<role>[-r<N>].prompt.md` file `--record-prompts` writes beside
the invocation's `.log` in the run directory: the envelope's bytes, unchanged,
one file per invocation. Default off; the `run-started` event records whether
it was on. The raw material for an eval case's `prompt`.
_Avoid_: "prompt log", "transcript", "envelope dump"
```

Plan §3d item 18 already reads `prompt-plus-expected-verdict` (amended on
this branch). Carrier: CONTEXT.md **Verdict** usage in **Evaluator**;
`src/artifacts.ts:62`; plan-debate §7 vocabulary rider.

## What a slice may still decide

Per `decisions-review.md` §5, each of these is recorded in the slice's contract
with the answer this document already gives it, and no slice asks:

- **S2:** the exact case list within D2's sources (which archived verdicts
  qualify as human-confirmed; whether #194 yields one case or two; the
  `files` and hand-rendered prompt of each), case `id` slugs, `source` string
  wording, the byte content of the fixture consumer pack.
- **S1:** internal type names not listed in D32, the exact refusal message
  wording (each must name file and member), the `--out` timestamp format's
  zero-padding, the stub fixture's file layout, the wording of the `--dry-run`
  case list.
- **S3:** the wrapper's internal file-name helper, how `.prompt.<k>.md` picks
  `k` (any deterministic scan is fine), the unit-test layout.

Not open to any slice: the field names and enum values in D7, D9, D12, D13,
D20, D23; the exit-code rule in D21; the flag names and defaults in D15 and
D1; the modules and export names in D32; the CLI entries in D33; the no-git
rule in D34; the absence of a pass rate (D24).

## File-scope map

Finalized against `0faf207`. New modules are marked *(new)*; everything else
exists today. **The map is exhaustive for source, prompt, pack and doc files,
and it does not list test files.** A planner declares its slice's paths plus
the test files it edits, following AGENTS.md's assertion ladder; a path the map
does not name is a scope discovery, not an omission the planner may assume
(ADR 0052 / ADR 0060).

| Path | S1 runner | S2 seed pack | S3 recorder |
|---|---|---|---|
| `src/eval-pack.ts` *(new)* | creates | — | — |
| `src/eval-compare.ts` *(new)* | creates | — | — |
| `src/eval-report.ts` *(new)* | creates | — | — |
| `src/eval-command.ts` *(new)* | creates | — | — |
| `src/eval.fixtures.ts` *(new)* | creates | reads | — |
| `src/prompt-recorder.ts` *(new)* | — | — | creates |
| `src/afk.ts` | `eval` branch + usage line | — | `--record-prompts` wrap + usage line |
| `src/afk-claude.ts` | `eval` branch + usage line | — | wrap + usage line |
| `src/afk-codex.ts` | `eval` branch + usage line | — | wrap + usage line |
| `src/cli-options.ts` | — | — | `recordPrompts` in `PipelineRuntimeOptions` |
| `src/run-events.ts` | — | — | `run-started.recordPrompts?` (one optional field) |
| `src/orchestrator.ts` (hub) | — | — | `recordPrompts` on `PipelineConfig` + one property in the `run-started` emission (:7900-7906) — no behavior |
| `eval-packs/afk/*.json` *(new)* | — | creates | — |
| `eval-packs/fixtures/consumer-governance/*.json` *(new)* | — | creates | — |
| `eval-packs/fixtures/refused/*.json` *(new)* | creates | — | — |
| `CONTEXT.md` | four entries (D36) | — | **Prompt record** |
| `ARCHITECTURE.md` | "Agent eval" row | — | `src/prompt-recorder.ts` in the CLI entries row's internals |
| `package.json` | untouched — `bin`, `exports`, `scripts` and `files` all stay as they are; the packs are not published | — | — |

Untouched by every slice: `src/wave.ts`, `src/ship-gate.ts`, `src/preship.ts`,
`src/gate-runner.ts`, `src/base-gates.ts`, `src/candidate-gate-phase.ts`,
`src/post-qa-gates.ts`, `src/final-evaluation.ts`, `src/gate-policy.ts`,
`src/run-state.ts`, `src/bounds.ts`, `src/logger.ts`, `src/run-journal.ts`,
every provider (`src/claude.ts`, `src/codex.ts`, `src/kiro.ts`,
`src/invocation-runtime.ts`), `src/agent-provider.ts`, every `prompts/*.md`,
every `agents/*.md`, `afk.config.json`, `AGENTS.md`, `CLAUDE.md`.

**Lanes.** S1 and S3 both declare the three CLI entries, so within a wave
`partitionLanes` (`src/lanes.ts`) unions them into one lane and their
generation is serial; their contract negotiation still runs in parallel. S2
is behind S1 (it reads `readEvalPack` and the fixture stub) and forms its own
wave. Expected waves: **1: S1 + S3 (one lane)**, **2: S2**.

## Concurrency with PRD 5

PRD 5 (`.kiro/specs/afk-v2-quality-loops`, slices #87 and #97) runs
concurrently under plan §3c policy 5. Its checklist asks PRD 7 to keep its
file hints off `src/orchestrator.ts`, `src/run-events.ts`, `src/logger.ts` and
`src/ship-gate.ts`. **S1 and S2 do**, entirely. **S3 touches
`src/run-events.ts` (one optional field on `run-started`, :33-40) and
`src/orchestrator.ts` (one optional `PipelineConfig` field and one property at
:7900-7906)** — the only honest place to record enable/disable is the event
the run already emits once. PRD 5 #87 edits `run-events.ts` at
`invocation-completed.role` (:120-146) and appends a new event; both PRDs'
edits are additive and textually distant. Under policy 5 the second merger
pays the rebase; that is accepted here. Neither PRD edits `src/logger.ts` or
`src/ship-gate.ts` for this. `ARCHITECTURE.md` and `CONTEXT.md` gain only
own rows and own entries, as PRD 4's slices did.

Also live on this host: a rumo-app AFK run. One clone per run (policy 5).

## Testing decisions

#152's Testing Decisions stand, read through R1–R3 (no learning-proposal
tests here; no recorded-envelope pack). Additions, all from AGENTS.md's
"where a new assertion goes" ladder — **no slice adds a spawned pipeline
scenario**:

1. **Everything in S1 is unit-shaped.** Pack reading and refusal (each rule in
   D7 and D9 has a refusing fixture), projection per role over fixture
   artifacts, comparison, cap accounting (`--max-calls 2` over a three-case
   pack yields `NOT-RUN` for the third and `INCOMPLETE`), report shape read
   back through `readEvalReport`, exit codes, and the two stdout formats. The
   provider is the `src/eval.fixtures.ts` stub; no git, no agent, no network.
2. **The non-gating boundary is three tests** (D21): pure-mismatch exits 0;
   `INCOMPLETE` exits 0; no non-eval module imports `eval-*` (read
   `src/*.ts` excluding tests and the four `eval-*` files plus the three CLI
   entries; assert no import specifier matches `/\.\/eval-(pack|compare|report|command)\.js/`).
3. **S2's tests read the real packs.** `readEvalPack("eval-packs/afk")` and
   `readEvalPack("eval-packs/fixtures/consumer-governance")` succeed, every
   case's `source` is non-blank, every `expected` validates against its role,
   `eval-packs/fixtures/refused` is refused naming the member. The fixture
   consumer pack is additionally dispatched to the stub end to end (a stub
   writing `review-pm.md` with `FIX-BEFORE-SHIP` → `MATCH`; with `SHIP` →
   `MISMATCH`). **No test dispatches the AFK pack to anything**; its cases are
   live-model cases by construction.
4. **S3's recorder is tested on the wrapper alone**: a fake inner provider, a
   `logStream` on a temp path, assert the `.prompt.md` bytes equal
   `options.prompt`, the `.prompt.2.md` rule, the pass-through of `name`,
   `parseStreamLine`, and the returned `InvokeResult`. The `run-started`
   field is asserted on an **existing** spawned fixture in
   `src/orchestrator.test.ts` (one `it` reading `events.jsonl`), not a new
   spawn.
5. **`pnpm test:budgets` stays the ceiling.** S1 and S2 add no spawned
   scenario, so budgets should not move; if one does, the fix is up the
   ladder.

Slice agents run `pnpm run typecheck && pnpm test:fast` plus the heavy suites
they touch (S3: `pnpm run test:heavy:orchestrator` for the `run-started`
assertion) — never the full suite (AGENTS.md). The evaluator and the pre-ship
gate run it for them.

## Out of scope

#152's Out of Scope stands (per-PR execution, merge gating, model-based
graders, automatic prompt or agent-file changes, rumo-app's governance pack).
Intent.md's list stands in full. Added here:

- **The learning-proposal schema** (R1) — on `feat/learning-proposal-schema`,
  ADR 0066, rumo-app #888.
- **A generator eval role.** Code output has no verdict projection; the suites
  own generator behavior.
- **Retrying an invocation inside `afk eval`.** One case is one call (D14).
- **Recording anything but the prompt.** No stdout, no artifact snapshots, no
  redaction layer (D5 avoided, not decided).
- **The `AGENTS.md` self-run convention line** for `--record-prompts` — a hand
  edit after S3 merges.
- **`ARCHITECTURE.md`'s Prompts row** already reads "shipped" (H4 is closed on
  `0faf207`).

## Launch preconditions

1. `pnpm lint:tickets 262 263 264` exits 0 — run 2026-09-12 on `docs/prd7-spec`:
   0 gating, 0 waived, 0 warnings, no new waiver. Recorded in `issues.md`.
2. PRD 4 is merged (#223 CLOSED); `parseFinalReview`,
   `POST_APPROVAL_WRITING_STAGE_ID` and the `evaluator-final` role are on
   `main` @ `46f6c38`. Verified by the "Verified facts" reads.
3. `afk.json` in this directory selects all three slices, reserves no
   migration prefix, and protects #152 as `OPEN` (the parent stays open for
   the hand tasks above).
4. Launch from a dedicated clone with the verification command explicit:
   `node <clone>/dist/afk-claude.js --prd-dir .kiro/specs/afk-v2-agent-eval-harness
   --test-command "pnpm run typecheck && pnpm test:fast"` after `pnpm build`.
   The globally linked `afk-claude` is not this checkout (PRD 4 precondition
   6).
5. PRD 5 may be live concurrently; the rumo-app run is live. One clone per
   run; the S3 overlap above is the accepted rebase.
