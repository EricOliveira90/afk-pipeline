# Slice Contract — QA verdicts and retries run on the same rails

**Parent PRD:** .kiro/specs/afk-v2-evidence-backbone/prd.md
**GH issue:** #79
**Status:** LOCKED
**Negotiation round:** 3

## Scope lock
Replace Markdown QA control fields with strict canonical `qa-review.json` and `uat-review.json` artifacts, track each stage's finding lifecycle in code, and route only the computed unresolved set to later evaluators and implementation retries. Markdown remains the human-readable companion, and existing retry accounting and report archives remain intact. (GH #79; parent PRD Solution and stories 1-3, 10-11, 16)

### In scope
- Read deterministic QA from `<slice-dir>/qa-review.json` and shared-preview UAT from `<slice-dir>/uat-review.json`, using the exact version-1 schema below; delete each working JSON before its evaluator attempt. (GH #79 "Slice QA emits the canonical verdict artifact"; parent PRD stories 1, 3)
- Reject missing, malformed, duplicate-key, unknown-key, missing-key, mistyped, or contradictory canonical data. Valid combinations are: `PASS/NONE` with `infrastructureEvidence: null` and no `OPEN/BLOCKING` finding; `FAIL/IMPLEMENTATION` with null infrastructure evidence and at least one `OPEN/BLOCKING` finding; or `FAIL/INFRASTRUCTURE` with nonblank infrastructure evidence and no findings. Every other combination ends the slice as artifact `ERROR`, consumes no implementation round, and cannot merge. (GH #79 AC 1, 5-6; parent PRD stories 2-3)
- Maintain independent deterministic-QA and UAT histories. On a stage's first valid non-infrastructure attempt, every finding is `OPEN`. Each later non-infrastructure attempt repeats every currently `OPEN` ID exactly once as `OPEN` or `RESOLVED`; fresh IDs are `OPEN`; `RESOLVED` IDs cannot return. `CONTESTED` and `WITHDRAWN` are invalid because QA has no planner-response artifact. Infrastructure attempts carry no findings and leave that stage's history unchanged. (GH #79 "reusing the lifecycle module"; parent PRD finding lifecycle; slice 04 terminal-state precedent)
- Treat every `OPEN` finding, including `ADVISORY`, as unresolved. After `FAIL/IMPLEMENTATION`, provide later QA evaluators and the next generator only those findings' IDs, summaries, clear-conditions, and code-derived artifact references; omit resolved findings and the list of all prior reports. A passing attempt may retain unresolved advisory findings but no unresolved blocking finding. (GH #79 AC 2-3; parent design M3 and Generator)
- Preserve raw canonical attempts and code-derived lifecycle records at the exact paths below. For a missing or invalid canonical artifact, preserve any produced raw JSON plus validation evidence, but derive no lifecycle record. (GH #79 "Every QA attempt stays archived"; parent PRD story 16)
- Apply all parsing, transition, routing, and archive rules equally to deterministic QA and shared-preview UAT; only stage identity and `qa-*` versus `uat-*` filenames differ. (GH #79 title and AC 6; ADR 0014)

### Non-goals (explicit out-of-scope)
- Acceptance-gate execution, behavior-ID coverage execution, role context manifests, new roles, or escalation/adjudication routing. (parent PRD Out of Scope)
- Changes to base-gate evidence routing, the three implementation-round cap, infrastructure retry count, preview locking/migrations, or terminal PASS/STUCK policy. (parent PRD Implementation Decisions; ADR 0014)
- Removing Markdown companions or changing their prose format. (parent PRD Out of Scope; GH #79 AC 4)
- Redesigning `generator-stuck`, contract-negotiation lifecycle, or contract-review state rules. (GH #79 limits structured repair input to generator retry rounds)

### Existing behavior to preserve
- Deterministic QA precedes optional lock-isolated shared-preview UAT — `src/orchestrator.ts:runQAStage`.
- `IMPLEMENTATION` advances a generator round; `INFRASTRUCTURE` retries in that round and exhausts as `ERROR` — `src/orchestrator.ts:runQAStage`.
- Markdown attempts remain `<slice-dir>/qa-report-r<round>-a<attempt>.md` and `uat-report-r<round>-a<attempt>.md`, including infrastructure attempts — `src/orchestrator.ts:runQAStage`.
- QA still receives sanity commands, timeout/heartbeat bounds, relevant files, and dependency handoffs — `prompts/evaluator-qa.md`.
- Base-gate failures still reach generator retries with gate-evidence and log references — `src/orchestrator.ts:runSliceExecute`.

### Changes to existing behavior (only if the issue asks for it)
- Markdown verdict and failure-class markers no longer control either QA stage: "Slice QA emits the canonical verdict artifact." (GH #79)
- Evaluators and retry generators no longer reconcile every preserved report: "Generator retry rounds receive the code-computed unresolved finding set." (GH #79)

## Files expected to change
- src/contract-review.ts
- src/qa-review.ts (new file)
- src/qa-review.test.ts (new file)
- src/artifacts.ts
- src/artifacts.test.ts
- src/orchestrator.ts
- src/qa-orchestration.test.ts
- src/test-support.ts
- src/orchestrator.fixtures.ts
- src/wave.fixtures.ts
- src/wave.test.ts
- src/wave-migrations.test.ts
- src/resume-integration.fixtures.ts
- src/prompt-template.test.ts
- prompts/evaluator-qa.md
- prompts/generator.md
- agents/evaluator.md
- agents/generator.md

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- Canonical root, exact keys: `{ version: 1, verdict: "PASS" | "FAIL", failureClass: "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE", infrastructureEvidence: string | null, findings: Finding[] }`.
- `Finding`, exact keys: `{ id, severity, behaviorIds, summary, evidence, expected, observed, clearCondition, state }`; finding IDs are unique within an attempt, `severity` is `BLOCKING | ADVISORY`, `state` is `OPEN | RESOLVED`, `behaviorIds` is a duplicate-free array of nonblank strings (possibly empty), and every other field is a nonblank string. These are the shared finding fields plus QA retry `summary`; contract-only `revisionCitation` and planner-position fields are absent.
- Valid-attempt record: `.afk/artifacts/<run-slug>/slice-<NN>/reviews/<qa|uat>-review-r<round>-a<attempt>-record.json`, exact root `{ version: 1, stage: "deterministic" | "shared-preview", round, attempt, verdict, failureClass, findings }`; each record finding is `{ id, severity, state, unresolved, summary, clearCondition, artifactReferences }`, where `unresolved` is exactly `state === "OPEN"` and references name that attempt's canonical and Markdown archives.
- Raw canonical archive: the same directory with `<qa|uat>-review-r<round>-a<attempt>.json`. Refused-attempt evidence: `<qa|uat>-review-r<round>-a<attempt>-validation.txt`. Raw and validation files exist when their source/evidence exists; records exist only for schema-valid attempts.
- No new dependency or database schema.

## Test plan
- Given each valid combination and one-at-a-time malformed, duplicate-key, duplicate-finding-ID, extra, missing, mistyped, or contradictory data, when `pnpm vitest run src/qa-review.test.ts` parses them, then valid typed data is retained and every invalid variant is refused with no record.
- Given a stub writes a passing Markdown report but omits or corrupts the canonical QA JSON, or writes canonical `PASS` with `IMPLEMENTATION` or an `OPEN/BLOCKING` finding, when `pnpm run test:heavy:qa` runs, then the slice ends `ERROR`, does not merge, and archives the Markdown, any raw JSON, and named validation evidence.
- Given attempt 1 leaves valid canonical `FAIL/INFRASTRUCTURE` JSON and attempt 2 emits only Markdown, when `pnpm run test:heavy:qa` runs, then the working JSON is not reused, the slice ends `ERROR` without merge, and attempt 2 archives missing-artifact validation evidence.
- Given a first non-infrastructure attempt starts `RESOLVED`, a later attempt omits or duplicates an open ID, or a resolved ID returns, when `pnpm vitest run src/qa-review.test.ts` validates the lifecycle, then each transition is refused; given an infrastructure attempt after a nonempty open set, the open set remains unchanged.
- Given round 1 QA returns implementation failure with blocking and advisory `OPEN` findings, when round 2 marks one ID `RESOLVED`, leaves one `OPEN`, and adds one fresh `OPEN` ID, then the generator/evaluator prompts contain exactly the two open IDs with summaries, clear-conditions, and archive references; the resolved ID and blanket prior-report list are absent; lifecycle records show the transitions.
- Given QA returns valid `FAIL/INFRASTRUCTURE` then `PASS/NONE`, when the QA fixture runs, then one generator round is used, both Markdown and canonical attempts are archived under the specified names, the infrastructure lifecycle record identifies no findings, and failure-class accounting is unchanged.
- Given deterministic QA passes and UAT round 1 returns `FAIL/IMPLEMENTATION` with an open ID, when the next generator runs and UAT later repeats that ID as `RESOLVED` with `PASS/NONE`, then only the open UAT finding drives the retry, QA history is not mixed into UAT lifecycle, the slice passes, and all named UAT raw/record/Markdown archives exist.
- Given verdict-driving fixtures, when the evaluator runs `pnpm test:fast`, `pnpm run test:heavy:qa`, `pnpm run test:heavy:orchestrator`, `pnpm run test:heavy:wave`, and `pnpm run test:heavy:resume`, then canonical artifacts drive their existing outcomes and Markdown markers never do.

## Definition of done
- [ ] QA and UAT advance only from schema-valid canonical artifacts; Markdown-only PASS ends `ERROR` without merge.
- [ ] Verdict, failure-class, finding-state, and infrastructure-evidence invariants fail closed.
- [ ] Each stage enforces the defined transition matrix and independently computes unresolved findings.
- [ ] Implementation retries receive only unresolved IDs, summaries, clear-conditions, and canonical/Markdown archive references.
- [ ] Every attempt preserves the specified evidence while existing retry accounting, stage isolation, and Markdown archive names remain unchanged.
