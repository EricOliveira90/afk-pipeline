# PRD 7 — independent review of `decisions.md`

Second opinion on the 37 decisions, formed from the primary sources in this
order: `docs/PRODUCT.md`, `docs/intent/agent-eval-harness.intent.md`, plan
§2/§3d/§4/§6, `CONTEXT.md`. Section H was checked against the code and both
trackers before anything else was answered. Written 2026-09-12 against
`main@dbd6fdc`; `docs/prd7-intent` (`a20eb2f`) reached `main` later the same
day via the `integration/2026-09-12-hand-fixes` merge (`46f6c38`).

Verified facts this review rests on:

- `assembleContextEnvelope` returns `{ prompt, evidence }`; the prompt goes to
  the provider on **stdin** (`claude.ts:183`, `codex.ts:278`, `kiro.ts:184`)
  and is never written anywhere. `.afk/` is gitignored. No dump flag exists.
- `src/context-envelope.ts` first commit: `a93d0ff` 2026-09-01 (#83). PRD 1
  merged 2026-08-28. Only PRD 4 runs exist under `.afk/logs` and
  `.afk/artifacts` (41 run dirs, 138 `prompt-assembly` events, archived
  `contract-review-rN-aM.json` / `qa-review-rN-aM.json` for slices 04 and 07).
- `classifyNegotiateFailure` / `KILL_SIGNATURES` are regex tables. The only
  agent-authored classification is `QAReview.failureClass`, which the
  orchestrator trusts after parse-time consistency checks (`qa-review.ts:377-412`,
  `orchestrator.ts:5465`). ADR 0041 governs gate-runner status, not that field.
- The contract evaluator **reads `contract.md` and the acceptance manifest from
  disk** and writes `contract-review.json` to `{{SLICE_DIR}}`
  (`prompts/evaluator-contract.md:21-28,132`). A replay therefore needs a
  scratch directory with fixture files, not just a prompt string.
- AFK code already uses **`disposition`** for guardian finding lifecycle
  (`GuardianFindingDisposition = OPEN|RESOLVED|REPEATED|REOPENED|REGRESSED`,
  `artifacts.ts:62`). `decisions.md` D36 missed this.
- rumo-app #809: CLOSED 2026-09-02 via PR #812. `findings-ledger.test.ts`
  validates the **ledger entry** (six bolded fields, kebab-case class, positive
  count, `none|proposal opened|eval-candidate`, newest-first). The
  **proposal** is five prose items in `post-merge-cleanup/SKILL.md`, delivered
  "as an ordinary branch diff" or an issue. No file, no template, no schema,
  no `learning-proposals.json` anywhere in rumo-app. rumo-app already consumes
  `afk-pipeline/afk-manifest` from a pinned commit.
- Of the seed sources item 18 names, the incidents that are genuinely agent
  judgment are **#192** (planner over-escalates), **#194** (contract evaluator
  blocks on a false premise) and the run-5 steering defect. #111–#121 are
  orchestrator defects; #196 is the assembler.

---

## 1. Headline: rescope item 18 before specifying it

Three parts of item 18 should change shape. Each is a plan-level ruling,
not a slice's call.

**R1 — Pull the learning-proposal schema out of PRD 7 and do it by hand.**
It shares no code, no concept and no test with the eval runner; it sits in
PRD 7 only because the 2026-09-02 review bundled two playbook plays into one
item. It is a JSON shape, a validator, a package export and a `CONTEXT.md`
entry — smaller than one round's overhead, which is plan §5's own rule for
"do it by hand". Doing it now, on `main`, removes PRD 6's dependency on PRD 7
entirely and takes the cross-repo negotiation off the critical path of the
critical path. Carrier: plan §5 (rule of thumb) and PRODUCT.md principle 2
(name what a change simplifies). If you keep it in PRD 7, D37 stands: slice 1.

**R2 — Ship one case kind, not two.** A "recorded-envelope case" is a
prompt-plus-expected-verdict case whose prompt text came from a recording and
whose `source` cites the run. Once that is said, the second kind, the keying
(D3), staleness (D4), redaction of recordings (D5), and half of D7 disappear.
The founder constraint "reuse the recorded envelope format; do not invent a
parallel fixture format" has no file-format referent (H1); its honest reading
is that the case input must be the exact string `AgentProvider.invoke`
receives, and the runner must dispatch through `AgentProvider.invoke` itself.
Carrier: source intent "Constraints", ADR 0002 / principle 9, and the KISS
brief you gave me.

**R3 — Replace the 20–50 seed count with "every case cites a source; the
count is what the sources yield."** The verified sources give roughly 5–15
cases for v1: #192, #194, run 5's steering defect, and the PRD 4 archived
evaluator verdicts (inputs hand-reconstructed once from the archived
`contract.md` + feedback + the issue body). The number 20–50 came from the
playbook, not from an inventory. Success measures 2 and 6 in `intent.md`
collapse into one. Carrier: PRODUCT.md principle 5 (evidence over argument)
and the source intent's real value line — "every future incident becomes a
permanent scenario". The pack grows from incidents; #192 and #194 are the
first two.

Nothing else in item 18 should be dropped. A report-only `afk eval` with a
call cap is the right size; its value is the two maintainer questions in
`intent.md` §Problem, and both are answerable with a verdict-only comparison.

---

## 2. Section H rulings

| | Ruling | Basis |
|---|---|---|
| H1 | **Accept**, and amend the remedy: no envelope is persisted (stdin, never written) and PRD 1 predates envelopes by four days. The "recorded envelope format" constraint's referent is the `InvokeOptions.prompt` string, not a file; satisfy it as R2 says. | code timeline above; source intent |
| H2 | **Accept.** Classifier cases are unit tests today and must stay there (D31's own consequence). Of #111–#121 none is an agent-judgment case. Revise the seed sources per R3. | `orchestrator.ts:1828-1930`; plan §1 |
| H3 | **Amend.** #809 is closed and shipped, but what shipped is a tested **ledger** and a prose **proposal requirement**. There is no proposal *format* in rumo-app to negotiate against. rumo's story 12 says the proposal format should "match AFK's mistake-twice loop output shape" — rumo is waiting on AFK, not the reverse. So the schema is greenfield, AFK-canonical, and the only cross-repo constraint is success measure 5: every required field must be fillable from a ledger entry plus the skill's five items. This shrinks D25–D29 substantially. | rumo `SKILL.md`, `findings-ledger.test.ts`, #809 body |
| H4 | **Accept.** One-line fix to `ARCHITECTURE.md`'s Prompts row; hand it to whoever next touches that file, not to PRD 7. | plan §2 PRD 3 row |

---

## 3. The 15 MAINTAINER decisions

| # | Recommendation | Reasoning | Carrier |
|---|---|---|---|
| D1 | **Option 3 for v1, plus a 10-line opt-in recorder as a later slice.** Hand-author the seed pack. Separately, a `--record-prompts` flag writes each assembled prompt next to the existing `slice-NN-<role>-rN.log` in the run directory. Not an artifact class, not a schema, no redaction question: `.afk/` is gitignored and the stdout log beside it already quotes the same source. Enable it by convention on self-runs, like `--test-command`. | Nothing exists to record today, so machinery first buys nothing; but without a recorder every future incident case is hand-reconstructed, which defeats "every incident becomes a scenario". Option 2 (re-assemble) is blind to assembler regressions and its inputs (issue body, ADR index, templates, git-derived state) are not archived — verified. | principle 7; source intent; H1 |
| D2 | **Sources: #192, #194, run-5 steering defect, PRD 4 archived contract/QA reviews, rumo's first governance case as a fixture consumer pack. Drop PRD 1 and #111–#121 and classifier cases.** Count = what these yield. | R3. | plan §1 classification; principle 5 |
| D5 | **No runner-level redaction policy in v1.** The committed pack is hand-curated by the repo that owns it; recordings stay in the gitignored run directory. Consumer packs live in the consumer's repo under its own rules. | With R2 and the D1 recorder placement, the security decision is not created. Do not build a deny-list for a data flow that does not exist. | principle 2; §3c policy 1 (risk class avoided, not decided) |
| D7 | **Fix v1 field by field in the spec.** Shared: `version`, `id`, `role`, `source` (required: issue/run/artifact reference), `prompt`, `files` (map of relative path → content, seeded into the scratch dir), `expected` (D9). No per-kind fields; no per-case budget. Unknown top-level field or unknown `version` **refuses the pack**. | `files` is not optional: the contract evaluator reads `contract.md` and the manifest from disk. One kind means one shape. | PRD 4 D1 precedent; `evaluator-contract.md:21-28` |
| D9 | **Projection = the role's top-level verdict enum only, plus one named secondary enum per role where the incident class lives:** `evaluator-contract` → `verdict`; `evaluator-qa` → `verdict` + `failureClass`; `evaluator-final` → `verdict`; `planner` → produced artifact (`CONTRACT` \| `ESCALATION`); `pm`/`architect` → `outcome`. No findings, no ids, no prose. | The two maintainer questions are about the verdict. Finding sets vary run to run and would manufacture mismatches; behaviorIds are contract-specific. Start narrow and widen on evidence. | source intent "exact structured dispositions"; principle 5 |
| D14 | **One model call = one `AgentProvider.invoke`.** With one invocation per case and sequential order, the cap is "cases dispatched", which is honest and deterministic. Record `costUsd` and `toolCallCount` when present. | Provider-reported model requests would need new provider surface (forbidden); tool calls measure chattiness. | PRODUCT.md "No speculative provider features"; ADR 0036 |
| D18 | **Completed cases keep their results; the remainder are `NOT-RUN`; the report carries `status: INCOMPLETE` and never an aggregate (D24).** | A partial list of per-case facts is data; a partial percentage is a lie. Item 18's own failure mode. | item 18; intent.md success measure 3 |
| D20 | **Standalone report; no `RunJournal`, no run directory, no new event type.** `INCOMPLETE` surfaces in the JSON report's `status`, in the stdout summary line, and nowhere else. | An eval is not a pipeline run; `src/run-events.ts` is the pipeline's schema. Consistent with D34. | ARCHITECTURE.md hubs rule; CONTEXT.md **RunJournal** |
| D21 | **Exit 0 unless the runner itself failed** (pack refused, provider unreachable, parser threw). Mismatch and `INCOMPLETE` are both data. Add the test that a pure-mismatch run exits 0 and grep-assert that no gate, ship-gate or CLI run path imports `eval-*`. | The non-gating boundary in mechanical form; a non-zero exit is how a shell script becomes a gate. | PRODUCT.md "No merge-gating on agent-eval results"; success measures 1 and 4 |
| D24 | **No pass rate. Report counts** (`MATCH n / MISMATCH n / NOT-RUN n / ERROR n`) and the per-case table. | A single quotable number is the path from measurement to gate; counts carry the same information without a headline. Disagrees with D23's default computation. | principle 5 ("never gates until proven stable"); plan §6 |
| D25 | **JSON canonical, AFK-owned, `learning-proposals.json` as item 19 already states. rumo changes nothing shipped.** | H3 amended: rumo has a ledger, not a proposal format, and is waiting on AFK's shape. No renderer is owed to rumo in v1. | item 19; mistake-twice intent "canonical `learning-proposals.json`" |
| D26 | **Five fields, all required:** `findingClass` (kebab-case, matches rumo's class rule), `occurrenceCount` (≥ 2), `occurrences` (array of ≥ 2 links — the evidence for "second occurrence"), `targetAsset` (D27), `proposedChange` (string; a unified diff when the target is a file). **Omit** `validation`, `date`, `prdSlug`, `disposition` — they are ledger fields or prose that belongs in the PR body. | Item 19's four plus provenance. Every field is fillable from a ledger entry plus the skill's five items (success measure 5). Each extra field is a permanent coordination cost. | item 19; principle 3 |
| D27 | **`targetAsset: string`** — a repo-relative path when the target is a file, otherwise a stable token (`skill:<name>`, `gate:<id>`, `eval-scenario`). No enum, no `{type,path}`, no `guardian` field in v1. | Nobody routes on it mechanically in v1 — item 19 renders it for a human and rumo's routing is a human running a skill. An enum neither repo fully uses is speculative surface. | principle 1; PRODUCT.md "No speculative provider features" (same spirit) |
| D29 | **AFK holds the canonical definition and exports it as `./learning-proposal` (schema + validator), exactly as `./afk-manifest`. A bump is an AFK commit that bumps `LEARNING_PROPOSAL_VERSION`; rumo consumes it when it moves its pinned `afk-pipeline` commit; a consumer reading an unknown version refuses.** Coordination = an issue filed in rumo-app at bump time naming the field change. | rumo already pins `afk-pipeline` by SHA and imports `afk-manifest`, so the mechanism exists and costs nothing new. | ADR 0034; principle 6 |
| D36 | **Say `verdict`. Never `disposition` in anything `afk eval` emits or documents.** AFK already carries a second meaning (`GuardianFindingDisposition`) and rumo a third; leave both, add none. `CONTEXT.md` gets: **envelope**, **scenario pack**, **eval case**, **eval outcome** (D23 words), **learning proposal**. Plan §3d's "prompt-plus-disposition" wording gets a one-line erratum pointing at the glossary. | Three live meanings is already one too many; the eval concept is exactly what `CONTEXT.md` calls a verdict. | CONTEXT.md **Verdict**; `artifacts.ts:62` |

---

## 4. DEFAULTs I would change

| # | Their default | Take instead | Why |
|---|---|---|---|
| D3 | tuple key + sha256 | **Drop.** One case kind; `id` is a human-chosen slug, `source` carries provenance. | R2 removes the concept it keys. |
| D4 | `STALE` outcome | **Drop.** A case whose `files` no longer parse under the production parser is `ERROR`, with the parser message. | No recorded-envelope kind, no staleness class. Fewer outcome words. |
| D6 | recording off by default | **Keep the rule, move it to the D1 recorder flag.** `--record-prompts`, default off, enabled by convention on self-runs. | principle 7; only meaningful once the recorder exists. |
| D8 | directory + index file | **Directory of `*.json`, no index.** Every file carries `version`; the reader refuses a directory whose files disagree. | Two things to keep in sync becomes one. |
| D12 | validate against `ContextEnvelopeRole` | **Validate against a runner-owned `EVAL_ROLES` list** = `evaluator-contract`, `evaluator-qa`, `evaluator-final`, `planner`, `pm`, `architect`. Refuse on unknown, as they say. | The generator's output is code, not a verdict; the guardians are not in that union. The union is the wrong set on both sides. |
| D15 | flag + config key, pack may lower | **Flag only, `--max-calls`, default 50; pack cannot change it.** | No consumer needs a config key yet; a pack lowering its own cap is a feature nobody asked for. |
| D22 | JSON + Markdown file | **JSON file + stdout summary.** No Markdown renderer. | The weekly reader reads the terminal; the trend reader reads JSON. A second renderer is maintenance with no reader. |
| D23 | 5 words incl. `STALE`, plus a pass rate | **4 words: `MATCH`, `MISMATCH`, `NOT-RUN`, `ERROR`. No rate** (D24). | See D4, D24. |
| D34 | no git, no state | **Agree, and add the one thing it omits:** each case runs in a fresh temp scratch directory seeded from `files`, and the role's output artifact is parsed from there with the production parser (D10). cwd = that directory, so tool use finds only what the case declares. | Roles read and write disk; determinism by construction rather than by author discipline. |

Accepted as written: D10, D11 (mostly moot under D9), D13, D16, D17, D19,
D28, D30, D31, D32, D33, D35, D37 (if R1 is declined).

---

## 5. Settle before slicing vs. a slice may default

**Must be settled in `prd.md` before any ticket exists** — each is a public
interface, a persisted format or a plan change:

- R1–R3 (scope), and the resulting rewrite of `intent.md` success measures 2, 5, 6.
- D7 + D9 + D12 + D13: the pack schema v1, field by field, with the projection table and `EVAL_ROLES`.
- D26 + D27 + D29: the learning-proposal schema v1, field by field, the export name, the bump rule — recorded in both repos (a rumo-app issue citing this file is enough).
- D21 + D24 + D23: exit semantics and outcome vocabulary — the non-gating boundary.
- D14: what one call is.
- D36 + the `CONTEXT.md` entries.

**A slice may default, with the answer above recorded in its contract:**
D1's recorder placement, D2's exact case list, D8, D10, D11, D15–D20, D22,
D30–D35.

---

## 6. Slice order that follows

1. **Learning-proposal schema** — by hand on `main` if R1 is accepted; else PRD 7 slice 1. Unblocks PRD 6 either way.
2. **Pack reader + comparator + report + `afk eval` in all three entries**, unit-tested over `buildStubProvider`; grep/test for the non-gating boundary.
3. **Seed pack** from the D2 sources, each with `source`; fixture consumer pack for the rumo-shaped case.
4. **`--record-prompts`** — one flag, one `writeFile`, default off. May trail everything else or wait for the first incident that needs it.
