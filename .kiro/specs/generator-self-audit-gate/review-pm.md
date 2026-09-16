# PM review — Generator self-audit gate (#298; slices #299, #300, #301)

**Verdict:** ACCEPT-WITH-NOTES

## What I checked, and how

I read the PRD, all three locked contracts and handoffs, then traced each
user story to code I read myself. Narrow commands only: `vitest run
src/self-audit.test.ts` (29 passed) and `vitest run src/logger.test.ts -t
"#301"` (9 passed, rest skipped). No full-suite run.

| PRD story | Outcome delivered? | Evidence I read/ran |
|---|---|---|
| 1 — candidate audited before QA dispatch | Yes | `src/orchestrator.ts:6425-6485` — the single `runSelfAuditStage({...})` call sits in the gates-passed branch after the `qaBaseGate` literal (`:6410-6424`) and before the changed-tree branch and QA dispatch (`:6634-6659`) |
| 2 — `--self-audit`, default off | Yes | `src/cli-options.ts:265-266,301` (`args.includes("--self-audit") ? true : undefined`; near misses excluded); `src/self-audit.ts:347` returns `{ ran: false }` when not opted in; `src/orchestrator.ts:6452` makes even the `git log` change summary a thunk so a declined run pays nothing |
| 3 — verdict from exact git tree comparison | Yes | `src/self-audit.ts:78-129` `classifySelfAuditVerdict` (pure, tree-id inputs only); `dispatchAudit` re-hashes with `resolveCandidateTreeId(input.worktreeDir)` at `:467` — the gate-cache identity. No agent claim is read anywhere |
| 4 — changed tree re-runs required cheap gates before QA | Yes | `src/orchestrator.ts:6514-6592` — `selectAuditedGateDeclarations(preQaDeclarations, resolveCheapGateCatalog(...))` into `verifyAuditedTree` with `runCandidateGatePhase` and label `"audited-tree cheap gates"`; `src/self-audit.ts:607-672` asserts release of the *audited* tree and builds a fresh base-gate object naming it |
| 5 — exactly one audit invocation per QA submission | Yes | `src/self-audit.ts:380-393` — the retry loop `break`s on the first completed invocation; `AuditedTreeVerificationInput` (`:538`) declares no `dispatch`; the changed-tree branch has no second `runSelfAuditStage(` (single occurrence at `orchestrator.ts:6433`) |
| 6 — audit excluded from the generator round budget | Yes | I grepped `orchestrator.ts` for `bumpEvalRound` between `:6433` and the QA dispatch: none. The audited-`REPAIR` exit at `:6594-6623` re-enters the existing repair loop (`continue` / `exhaustDeterministicGates`) with no new counter |
| 7 — dead invocation → `AUDIT_NOT_RUN`, candidate proceeds | Yes | `src/self-audit.ts:436-475` reports failures instead of throwing; `:394-423` classifies, records, and returns `{ ran: true, verdict, treeId: <released> }`; `resolveGradedCandidate` (`:673`) then yields the pre-audit pair. Covered by the tests I ran |
| 8 — per-candidate outcomes with run-ID provenance; spent on resume | Yes | `src/run-state.ts:76` (`RUN_STATE_VERSION = 8`), `:378-385` (`runId` required), `:1079` sanitization; `src/self-audit.ts:365-378` short-circuits with `{ ran: false, spent }` when a persisted entry names the released tree in either id field |
| 9 — per-run totals and changed rate in the run summary | Yes | `src/logger.ts:296-337` (`deriveSelfAuditOutcomes` / `readSelfAuditOutcomes`) and `:887-908` — the `## Self-Audit` table plus `Changed rate: N% (C of G graded audits)` / `n/a`, rendered only when an outcome event exists |
| 10 — reports, never gates | Yes | The rate's only comparison is `=== undefined` for the render (`logger.ts:891-895`); no `self-audit` symbol appears in `src/gate-runner.ts` (grep) and no branch outside the summary consumes it |
| 11 — envelope carries locked pair, handoff, change summary; stricter-only budget | Yes | `SELF_AUDIT_CONTEXT_MANIFEST` in `src/context-envelope.ts`: `inputOrder` exactly `locked-contract, acceptance-manifest, candidate-handoff, change-summary`, `inlineSizeBudgetBytes: 65_536`, worktree-limited `allowedWriteScope`; assembly runs through `assembleContextEnvelope` |
| 12 — unchanged resubmission is legitimate | Yes | `prompts/generator-audit.md:51-69` — "Resubmitting this candidate unchanged is a legitimate outcome… An audit that finds nothing has done its job", plus the four audit obligations at `:33-49` |
| 13 — QA sees candidates that survived the re-read | Yes | Follows from 1 and 4: on `AUDIT_CHANGED` the QA dispatch, approved baseline, shared-preview stage and `runPostQAGates` all read the one `gradedCandidate` binding (`orchestrator.ts:6634,6656-6659,6684-6685,6744,6888`) |
| 14 — outcomes visible in run status surfaces | Partly — see P-01 | Live narration reaches `run.log` (`src/orchestrator.ts:6454` → `RunJournal.phase`, `src/run-journal.ts:90-105`) and one `self-audit-outcome` event lands in `events.jsonl` (`:124-129`); `afk status` / draft-PR surfaces carry nothing (slice 03 non-goal) |
| 15 — ADR with mechanism, provenance, bound | Yes | `docs/adr/0069-…md` — SwarmForge `swarm_handoff.sh` provenance (`:13-18`), structural verdict (`:41-50`), "One **completed** invocation per QA submission" with the retry reconciliation (`:52-65`), changed-tree and report-never-gate consequences (`:83-128`) |
| 16 — prompt prose superseded | No — see P-02 | `prompts/generator.md` and `prompts/generator-repair.md` still carry `# Self-audit before commit`; the PRD's own "Out of Scope" defers this retirement |

Operator terms are defined for humans too: `CONTEXT.md:277-288` defines all
three outcome terms with an `_Avoid_:` line and cites ADR 0069.

## Notes (non-blocking)

- **P-01 — story 14 is delivered through the run log, not a status surface.**
  A babysitter can distinguish a post-audit gate re-run from a stall today,
  but only by reading `run.log` (`self-audit: AUDIT_CHANGED — …`, plus
  `gate-outcome` events labelled `audited-tree cheap gates`) or
  `events.jsonl`. `afk status` and the draft PR body are untouched — slice
  03's contract names them an explicit non-goal and assigns the slice the run
  summary instead. The user outcome is present in a different place than the
  story imagined, not absent, so this is a note. Worth a follow-up issue once
  `--self-audit` is used on a real run.
- **P-02 — story 16 contradicts the PRD's own Out of Scope, and the
  implementation followed Out of Scope.** The prose `# Self-audit before
  commit` section survives in `prompts/generator.md` and
  `prompts/generator-repair.md`, so with `--self-audit` on the obligation is
  stated twice with two enforcement strengths — the exact duplication story 16
  wanted removed. Correct call for this branch (the flag is default-off, so
  the prose is still the only self-audit pressure on almost every run), but
  the PRD should be reconciled when the default-on decision is taken.
- **P-03 — the flag is not documented anywhere an operator would look.**
  `--self-audit` appears in `src/cli-options.ts`, ADR 0069 and CONTEXT.md, but
  in no user-facing flag list. That matches existing practice for
  `--record-prompts` and `--infrastructure-retries` (also undocumented in
  README), so it is consistent rather than a regression.
- **P-04 — first real dispatch is still unexercised end to end, by design.**
  Slice 01's contract states this outright: no spawned scenario binds the
  injected `dispatch` to a real generator invocation, and `pnpm run typecheck`
  is the only check on that wiring. I read the callback
  (`src/orchestrator.ts:6463-6484`: `invoke({ role: "generator", … cwd:
  ctx.worktreeDir, logStream: auditLog, …longCommandRoleBounds })`) and it is
  shaped like the other invocation sites, but the first `--self-audit` run
  should be treated as the smoke test — an operator opt-in run is the cheapest
  place to learn this, and the failure mode is a recorded `AUDIT_NOT_RUN`
  rather than a blocked slice.

## Out-of-scope PRD gaps

- Story 14's `afk status` / babysitter-surface half (slice 03 non-goal).
- Story 16's retirement of the prompt-prose self-audit section (PRD "Out of
  Scope"), together with the default-on decision the changed-rate evidence is
  meant to inform.
- No spawned-pipeline exercise of the audit dispatch (PRD "Testing Decisions"
  permitted this deliberately).

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Audit outcomes reach run.log and events.jsonl but not afk status or the draft PR (story 14 partial)","class":"PRODUCT","clearCondition":"Either an afk status / PR-body surface reports the per-candidate audit outcome, or story 14 is amended to name the run log and run summary as the intended surfaces.","disposition":"OPEN"},{"id":"P-02","title":"Prompt-prose self-audit section still duplicates the gate obligation (story 16 vs PRD Out of Scope)","class":"PRODUCT","clearCondition":"When the default-on decision lands, the prose section is retired on gate-active dispatch paths, or story 16 is struck from the PRD as superseded by its Out of Scope entry.","disposition":"OPEN"},{"id":"P-03","title":"--self-audit has no operator-facing documentation","class":"DOCS","clearCondition":"The flag appears in a user-facing flag reference alongside the other runtime options, or the repo adopts a convention that ADR plus CONTEXT.md is that reference.","disposition":"OPEN"},{"id":"P-04","title":"Orchestrator-to-provider audit dispatch is proven only by typecheck","class":"RISK","clearCondition":"One operator run launched with --self-audit records a self-audit-outcome event, or an existing spawned scenario exercises the dispatch callback.","disposition":"OPEN"}]}
