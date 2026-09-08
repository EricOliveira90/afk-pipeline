# PRD 4: Acceptance and scope gates

**GH issue:** #72 — the parent contract. Its Problem Statement, Solution,
24 user stories, Implementation Decisions, Testing Decisions and Out of
Scope are authoritative and are **not restated here**.
**Slice issues:** #84, #85, #91, #96, #86, #132, #193, #195 — see `issues.md`.
**Note on ownership:** slice 01 was split twice on 2026-09-08. Where a decision
below says "slice 01", read the split note after the file-scope map — it is
authoritative for which of #84, #195 and #193 owns each part.
**Parent design:** `docs/specs/afk-v2-plan.md` §2 (PRD 4 row), §3 items 2,
5, 12, 13, §3b item 15, §3c policies 1, 2, 4, §3d item 17;
`docs/specs/afk-v2-agent-roles.md` mechanisms M2, M6, M7 and roles 5, 8.
**Binding ADRs:** 0060 (parser regression surfaces, gate-evidenced scope
discovery), 0052 (pre-build scope discovery), 0051, 0050 (focused
revision bounds), 0048 (QA-warranted amendment), 0029 (merge outcomes),
0012 (candidate-tree authorization), 0027 (lane resource keys).
**Supersedes:** issue #51 and
`docs/specs/afk-deterministic-quality-gauntlet.md` for this scope.
**Written:** 2026-09-07, after ADR 0060 closed #183.

This document exists for one reason: **to leave the planner no
load-bearing decision to discover.** Everything below is a settled
operator decision. Where this document and #72 differ on a fact, this
document controls and #72 should be amended; where it and a binding ADR
differ, the ADR controls.

## What was still undecided, and what is decided now

Each decision names the test it would otherwise have fired (plan §3c
policy 1 / AGENTS.md "do not leave a load-bearing decision unmade").

### D1 — the gate policy lives in `afk.config.json`, and slice 01 builds its reader

`afk.config.json` (repo root, plan §3c policy 2) gains one optional
top-level `gatePolicy` object. Absent, every consumer falls back to
today's derived baseline catalog in `src/base-gates.ts`, so a consuming
project with no policy keeps current behavior — that is #85's "works with
the derived baseline catalog when no quality policy exists".

A new module `src/gate-policy.ts` reads and validates it. Ownership is
split so that one slice creates the module and two extend it:

| Key | Owner | Contents |
|---|---|---|
| `version` (required, `1`), `protectedPaths`, `riskClasses` | slice 01 (#84) | protected gate-policy paths, test globs, catalog-declared escalation risk classes |
| `acceptance` | slice 02 (#85) | the behavior-ID gate command and its match-count matcher |
| `cost` | slice 05 (#86) | cheapness threshold, related-test selection, prerequisites, `environmentSensitive` members, cache settings, skip detectors |

*Test fired: load-bearing silence about a data format.* Consequence:
**slices 02 and 05 are blocked by slice 01**, correcting both tickets'
former "none within this PRD".

**The version-1 member shapes are named arrays, not rule records.**
Recorded 2026-09-07 after slice 01's planner escalated
`LOAD_BEARING_SILENCE` on this exact point: the table above named the
concepts and no line fixed their JSON. `protectedPaths` is an object of
two string arrays; `riskClasses` is a flat array of the risk-class
strings D5 declares. The association between a risk class and the paths
it covers is **code in `src/gate-policy.ts`, not config** —
`gatePolicyPaths` members raise `gate-policy`, and `testGlobs` members
raise `deleted-test` or `skipped-test` per D6 and D7.

```json
{
  "gatePolicy": {
    "version": 1,
    "protectedPaths": {
      "gatePolicyPaths": ["afk.config.json", "suite-budgets.json"],
      "testGlobs": ["**/*.test.ts"]
    },
    "riskClasses": ["gate-policy", "deleted-test", "skipped-test"]
  }
}
```

**An unknown member of `gatePolicy` is malformed and refuses the launch,
naming the key.** Slice 01's validator knows `version`, `protectedPaths`
and `riskClasses`; slice 02 widens the known set with `acceptance` and
slice 05 with `cost`. This is safe because the PRD's lanes are serial, so
each slice's validator merges before the config key that needs it. It is
D5's own lesson applied forward: `parseAfkManifest` accepted and silently
discarded `protectedChangeWaivers`, and a validator that passes over what
it does not understand reproduces exactly that defect. Accepted cost: an
`afk.config.json` written for a newer AFK refuses on an older one.

Both members are optional; each defaults to the values shown, which are
the derived baseline D6 and D5 already specify. The rejected alternative
was records associating a `riskClass` with paths or globs plus per-class
validation metadata: it is more expressive, but D6 already cites the
dotted path `gatePolicy.protectedPaths.testGlobs`, so a record array
would have made that citation unresolvable, and no consumer in this PRD
reads a per-class option. A malformed member fails closed at launch
naming the offending key, as the paragraph above already requires.

### D2 — the file-scope gate reuses the two helpers that already exist

`outOfScopeChangedPaths` (`src/escalation.ts`) is already the normalized
comparison of a changed set against a locked manifest, with the slice
artifact directory, the migration paths and the orchestrator-owned
`contract.md` / `acceptance-manifest.json` pair handled. `listChangedFiles`
(`src/git.ts`) is already the three-command union of `base...HEAD`,
working tree, and `ls-files --others --exclude-standard` — so **untracked
files already count**, and its `ChangedFilesProbe` already fails closed on
an unknown answer.

Slice 01 adds `src/scope-gate.ts`, which wraps both as a declared gate
with evidence and one call site in `src/orchestrator.ts`. It does not add
a second path normalizer or a second changed-set probe.

*Test fired: spec contradiction* — a fresh implementation would have
disagreed with the guard that already refuses a laundered revision.

### D3 — the scope comparison base, including after a merge-resolution round

The candidate comparison base is the slice's own work:
`merge-base(<feature-branch tip>, HEAD)...HEAD`, plus working tree and
untracked, exactly as `listChangedFiles` computes it.

After a merge-resolution round (slice 06) the base is **re-resolved to the
feature-branch tip that was merged in**, so paths owned by already-merged
siblings are attributed to those siblings and are never reported as this
slice's violations. Without this rule the resolution round and the scope
gate contradict each other: the resolved tree contains every sibling's
files by construction.

*Test fired: spec contradiction between #84 and #132.*

### D4 — role write-scope is a tree-to-tree diff

A writing role's changed paths are `diffTreePaths(inputCheckpointTree,
outputCheckpointTree)` (`src/git.ts`), not a working-tree probe: the
checkpoint is what later evidence cites, so the comparison must be
between the two checkpoints that bracket the role.

### D5 — a protected-change waiver is an operator launch input

The waiver record lives in the PRD directory's `afk.json` as
`protectedChangeWaivers`, an array of
`{ riskClass, path, author, reason }`. It is read once at launch from
`--prd-dir`, alongside `selectedSlices` and `migrationPrefixes`. An agent
never writes one: a waiver that appears only in a candidate tree is not a
waiver, because the gate compares against the launch-time snapshot.

**Slice 01 must extend the manifest parser, not only read the key.**
`parseAfkManifest` (`src/afk-manifest.ts`) builds its result from four known
fields and rejects no unknown key, so `protectedChangeWaivers` in an `afk.json`
today is accepted and then silently discarded — including the one this PRD
pre-records. `AfkManifest`, `parseAfkManifest` and `trimUnclaimedMigrationPrefixes`
(which rebuilds the manifest from the parsed fields and would drop the array on
any rewrite) are therefore slice 01's, and an unknown `riskClass` must fail
closed at launch rather than at a park.

The `riskClass` vocabulary is an operator decision, settled here so no planner
spends a dispatch on it: slice 01 declares the literal strings
`gate-policy` (for `afk.config.json` and `suite-budgets.json`),
`deleted-test` and `skipped-test`. `gate-policy` is the class the pre-recorded
waiver in this directory's `afk.json` uses, and the two must match exactly.
Contract file scope never implies a waiver (plan §3d item 17). Each
applied waiver's four fields are recorded in gate evidence and
`run-summary.md`; an unwaived protected change parks the slice through
PRD 2's park-and-continue machinery with its risk class and exact path.

**A waiver's `path` is one exact repository-relative path, never a glob.**
Recorded 2026-09-07 after slice 01's planner escalated
`LOAD_BEARING_SILENCE` on it. Matching is string equality after
normalization to forward slashes with no leading `./`; a `path` containing
`*`, `?` or `[` refuses the launch, as does a duplicate
`riskClass` + `path` pair. `src/acceptance-manifest.ts` already refuses a
`fileScope` path containing those characters, so this keeps one rule for
both operator-authored path lists. The rejected alternative was globs with
overlap-precedence rules: a broad pattern silently exempts files nobody
reviewed, which is the posture this gate exists to prevent, and it would
have made slice 01 build precedence rules no consumer in this PRD needs.
Accepted cost: slices 02 and 05 each need their own `afk.config.json`
waiver record rather than sharing one pattern.

*Test fired: load-bearing silence about a security posture.* The whole
point of the gate is that the actor being constrained cannot author its
own exemption.

### D6 — deleted-test detection

A path matching `gatePolicy.protectedPaths.testGlobs` that exists on the
comparison base and not in the candidate tree is a deletion. Absent
policy, AFK's TypeScript/Vitest default glob `**/*.test.ts` applies. A
deletion fails closed naming the exact path unless a D5 waiver covers it.

**The glob dialect is a narrow hand-rolled subset, not minimatch and not
gitignore.** Recorded 2026-09-07 after slice 01's planner escalated
`LOAD_BEARING_SILENCE` on the matcher semantics. Neither option the
planner offered named the real cost: **AFK has no runtime dependencies at
all** — `package.json` has no `dependencies` key and `src/` contains no
glob matcher — so "minimatch-compatible" means either AFK's first runtime
dependency or a reimplementation that then has to stay faithful to a
dialect it does not own.

Slice 01 writes a pure matcher in `src/gate-policy.ts` supporting exactly
literal segments, `*` (within one segment) and `**` (zero or more
segments), over paths normalized to forward slashes, **case-sensitive on
every platform**. This is deliberately *not* the same case rule as the
acceptance manifest's `fileScope` comparison, which is case-**in**sensitive
because `normalizePath` (`src/acceptance-manifest.ts:64-71`) lowercases and
the parser stores the normalized form. Two comparisons, two purposes: glob
matching decides which paths are test files, manifest comparison decides
which paths a contract declared. Do not conflate them — round 1 of
2026-09-08 lost a round to a reviewer that did. Any other metacharacter in a `testGlob` refuses the
launch and names the offending character. That covers the default
`**/*.test.ts` and every glob this PRD needs. Gitignore semantics were
rejected for their platform-native case sensitivity, which would make the
gate decide differently on Windows than on CI. Accepted cost: the dialect
is AFK's own and must be documented, not inherited.

### D7 — skip detection ships one detector, and fails closed elsewhere

Slice 05 ships AFK's TypeScript/Vitest detector for newly introduced
`describe.skip`, `it.skip`, `test.skip`, `it.todo`, `test.todo`,
`describe.only`, `it.only` and `test.only` — counted on the base tree
versus the candidate tree, so pre-existing occurrences do not fire. A
project on another runner declares its own detector in
`gatePolicy.cost.skipDetectors`; with neither a declared detector nor a
waiver the gate fails closed, which is plan item 17's stated and accepted
failure mode. There is no universal cross-language regex.

### D8 — zero matches is decided from structured runner output

The acceptance gate substitutes the behavior ID into the policy's
`acceptance` command and reads a machine-readable match count. AFK ships
one matcher, `vitest-json`: the command runs with `--reporter=json` and
the gate parses `numTotalTests`. Zero is FAIL (behavior untested); one or
more, all passing, is PASS. No stderr or stdout prose is parsed. Absent
policy, the derived baseline binds `acceptance:behaviors` to the
project's vitest binary with `--reporter=json --testNamePattern
<behavior-id>`. A runner with no supported matcher fails the gate closed,
naming the behavior ID and the missing matcher.

*Test fired: load-bearing silence about a data format.* "Zero matches is
FAIL" is unbuildable until something says how a match is counted, and
matching on runner prose is the defect class this PRD exists to remove.

### D9 — the candidate evaluator is the existing `evaluator-qa` role, reshaped

PRD 3 already merged `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST`
(`src/context-envelope.ts`): role `evaluator-qa`, write scope
`slice/qa-review.json` plus `slice/qa-report.md`, output artifact
`qa-review-pair`, `change-summary` first in its input order, `handoff.md`
omitted. Slice 03 therefore reshapes that role in place and its
copy-back allowlist is exactly the set `QA_WINDOW_ARTIFACT_NAME`
(`src/post-qa-gates.ts`) already admits — the two canonical artifacts plus
the orchestrator's own `qa-report-rN-aM.md` archives. No new artifact name
is invented for the candidate verdict.

The **final** evaluator is a new role: a new manifest entry, a new prompt
`prompts/evaluator-final.md`, and its own two artifacts
`final-review.json` and `final-report.md`.

*Test fired: spec contradiction* — inventing a second candidate verdict
artifact would strand a merged PRD 3 manifest entry.

### D10 — the approved behavior baseline is an orchestrator-written record

`approved-baseline.json`, under
`.afk/artifacts/<run-slug>/slice-<n>/`, written by the orchestrator and
never by the evaluator: candidate checkpoint tree ID and commit, the
`contract.md` and `acceptance-manifest.json` blob IDs, and the gate
evidence artifact IDs. Keyed by tree ID, so D20's reuse decision is a
tree comparison and not a heuristic.

### D11 — the change summary is code-generated once, by slice 03

New module `src/change-summary.ts` writes `change-summary.json` beside the
baseline record. Slice 03 owns the candidate variant (feature base →
candidate checkpoint), because PRD 3's merged candidate manifest already
leads with `change-summary` and plan §3 item 5 makes the candidate
evaluator its second consumer. Slice 04 extends the same module with the
baseline → final variant, partitioned per post-approval role (commits,
files, diff stats). Two producers for one artifact class would have
been the alternative; this is one producer, two variants.

### D12 — gate-evidenced scope discovery gets a reserved identity in `escalation.md` v2

`escalation.md` gains schema version 2: an optional
`gateEvidence: { gateId, evidenceArtifactId }`. When it is present,
`findingIds` must be exactly `["GATE-SCOPE"]`; version 1 documents stay
accepted unchanged, and ADR 0052's `PRE-BUILD-SCOPE` identity is
untouched. `findingIds` stays mandatory and non-empty, which is why a
reserved identity is needed at all: a failing gate is not a QA finding
and the generator cannot honestly produce a finding ID for it.

ADR 0052's full-tree cleanliness refusal is unchanged, so the same
request is refused once the requested path has already been edited. The
accepted revision's review-archive record preserves the gate ID and the
evidence artifact ID.

Only a generator can emit `GATE-SCOPE`, so slice 01 also owns the generator's
side of it: `prompts/generator.md`, `prompts/generator-repair.md` and
`agents/generator.md` today teach a two-way branch (routed finding IDs, or
`PRE-BUILD-SCOPE` when nothing was cited) against a version-1 JSON literal, and
`src/prompt-template.test.ts` pins those sections. The branch becomes three-way:
routed finding IDs / `PRE-BUILD-SCOPE` for a pre-build discovery with nothing
cited / `GATE-SCOPE` plus `gateEvidence` when a failing orchestrator-run gate is
cited. Slice 06 also edits `prompts/generator-repair.md` (D15's data block);
same lane, so the two edits stack.

*Test fired: declared risk class (schema history).* Decided here by the
operator so the planner does not spend a slice dispatch escalating it.

### D13 — the parser-regression rule is evaluator rubric text, not a manifest field

Nothing can mechanically decide that a behavior changes a parser's
accepted input language, so ADR 0060's requirement lands where
ARCHITECTURE.md's placement rule sends an unenforceable obligation: the
contract evaluator's rubric, in `prompts/evaluator-contract.md` and
`prompts/evaluator-contract-revision.md`. **The acceptance manifest stays
at version 2.** What slice 01 proves mechanically is that the rendered
evaluator prompt carries the rule, and that a `REVISE` verdict citing it
blocks the lock — the refusal path itself already exists.

The rubric addition is **additive**. Both files gained content on the launch
base that slice 01 must not remove: a `# Durable finding lineage` section, a
`# Control-plane situation` section, and the two bullets enumerating the legal
`severity` and `state` values (ADR 0061). Those bullets are what stop the exact
PRD 072 refusal ADR 0061 was written for, and nothing else marks them
load-bearing.

*Test fired: declared risk class (schema history), avoided rather than
paid.*

### D14 — probe-as-evidence: probes are allowed, transport is what is deferred

#72 story 9 defers probe-as-evidence while
`docs/specs/afk-v2-agent-roles.md` M7 and role 5 describe reviewers
running probes. Resolved: a reviewer may run ad-hoc probes in its
disposable worktree and quote what it observed in a finding's `evidence`
field. **Deferred** is the transport — no schema field carries probe
code, and no mechanism hands a probe file to the generator. Slice 03's
prompt says exactly this.

*Test fired: spec contradiction between #72 and the roles document.*

### D15 — the merge-resolution round is a data block, not a new template

Per M5 (situation variants become data blocks), the conflict hunks and
the merged sibling diffs enter `prompts/generator-repair.md` as a data
block. The resolved tree re-runs the slice's candidate gate phase
(`src/candidate-gate-phase.ts`) and its behavior bindings before the merge
retries inside the same mutex critical section; a resolution failing any
gate writes terminal `CONFLICT` with both branches preserved.

### D16 — an advisory gate is excluded from the required set, never from evidence

`GateDeclaration` (`src/gate-runner.ts`) gains
`environmentSensitive?: boolean`. A declared member still executes and
still records its real status in gate evidence; it is excluded from the
required set, so a failure neither blocks nor enters the repair failure
set nor consumes a round. `run-summary.md` and the draft PR carry an
advisory section listing advisory failures, which is where a human tells
"the machine was loaded" from "someone added an expensive test".
`test:budgets` is the first declared member, and stays blocking for plain
developer runs of `pnpm test` (plan §3c policy 4).

### D17 — the cache key is gate definition plus tree identity

Keyed by gate ID, the resolved command and args, and the tree ID; stored
in `.afk/artifacts/<run-slug>/gate-cache.json`. A changed tree or a
changed definition invalidates. Every reuse and every prerequisite skip
is explicit in gate evidence and `run-summary.md` — a silent skip is
indistinguishable from a gate that never ran.

### D18 — the derived verification command, and the flag that may only narrow it

Required gates in gate order whose `expectedCostMs` is at or below
`gatePolicy.cost.cheapThresholdMs` (default 120000), excluding the full
suite gate. `--test-command` may narrow the derived list to a subset;
it may not replace it, omit it, or name a command outside it, and a
launch that tries is refused. Slice 05 corrects the self-run launch
sections of `AGENTS.md` and `CLAUDE.md`, which still prescribe the
interim hand-written command.

### D19 — round accounting

Candidate evaluation is bounded to three rounds, final evaluation to
three attempts, both through `src/bounds.ts`. A red deterministic gate
returns to the generator and consumes a **generator** round; it never
consumes an evaluator round and never dispatches an evaluator.

### D20 — exact-tree reuse

Compare the final checkpoint's tree ID against `approved-baseline.json`.
Equal means reuse: zero final-evaluator invocations, recorded as reuse in
gate evidence and `run-summary.md`. Different means a fresh final
evaluator, with no exception for a change that "looks cosmetic".

### D21 — unchanged from PRD 1

Behavior IDs keep their `B-01` spelling. The finding schema, the
canonical verdict artifacts, `MERGE-PENDING` semantics (ADR 0029) and the
merge mutex are unchanged.

### D22 — how a code gate plugs into the gate runner, and what it is called

Recorded 2026-09-07, ahead of the escalation it would otherwise have
fired. The scope gate compares trees in process; it does not shell out.
Two facts about today's runner make that unbuildable as written:
`src/gate-runner.ts` treats a `GateDeclaration` with no `command` as
`SKIPPED` with detail "Optional gate has no command", and `GateResult`
carries only `detail?: string`, so there is nowhere to put a violation
path list or an applied-waiver record. #84 requires violations to reach
"the next generator round as structured evidence" and D5 requires each
applied waiver's four fields in gate evidence, so slice 01 grows both
types:

- `GateDeclaration` gains an optional in-process `run`. A declaration
  supplies **either** `command` or `run`. A **required** declaration
  supplying neither is a configuration failure; an **optional** one keeps
  today's `SKIPPED`.

  *Corrected 2026-09-08 after slice 01's planner raised it as a
  `SPEC_CONTRADICTION` and the contract evaluator raised it as F-01 —
  correctly, against an earlier flat version of this rule.*
  `projectSanityGateDeclarations` (`src/base-gates.ts:16-24`) sets
  `required: step != null` and spreads `command` only when the step exists,
  so a project with no `lint` script gets `{ id: "lint", stage: "base",
  required: false }` **with no command** — and `adopt-command.ts:647-649`
  counts that gate as passing *only while its status is `SKIPPED`*. A flat
  rule would therefore have turned the pre-QA gate set red for every
  consuming project without a lint script. `src/base-gates.ts` stays
  unedited, which is what preservation demanded all along.
- `GateResult` gains an optional typed `findings` payload with
  `outOfScopePaths`, `deletedTests`, `protectedChanges` and
  `appliedWaivers` (the four D5 fields per record). Prose in `detail`
  stays human-facing only; nothing parses it.
- `GATE_EVIDENCE_VERSION` goes **1 → 2**. `readGateEvidence` accepts
  version 1 and version 2; only version 2 may carry `findings`.

**Two gate IDs, both at stage `deterministic`:** `scope` for the D2/D3/D4
file-scope comparison, and `feedback-integrity` for the D5/D6
protected-change and deleted-test checks. Two rather than one because
D12's `gateEvidence.gateId` is what a `GATE-SCOPE` revision cites, and a
single ID would leave the citation ambiguous about which rule fired. The
existing IDs `typecheck`, `lint` and `tests` are unchanged.

**`RunState` goes version 3 → 4, and `evidenceArtifactId` is the
evidence sha256.** Two more silences found by reading the code slice 01
must extend rather than by reading this PRD:

- `src/run-state.ts` declares `RunState { version: 3 }`, a persisted
  schema, so the waiver record the file-scope map assigns to slice 01 is a
  schema bump: **3 → 4**, adding an optional per-slice `appliedWaivers`
  array of D5's four fields. The reader accepts version 3 and defaults the
  array empty. Recording waivers only in gate evidence was rejected: a
  resumed run could then not tell which waivers were already applied, and
  D5 reads the record once at launch.
- **`evidenceArtifactId` is the repo-relative evidence path, and that
  convention already exists.** `GateEvidenceArtifact`
  (`src/gate-runner.ts:92`) carries `evidencePath` and `evidenceSha256` and
  no id field, which is why D12's `evidenceArtifactId` looked unreferenced —
  but `src/candidate-gate-phase.ts:111-116` already computes
  `relative(repoRoot, evidencePath)` with forward slashes and passes it as
  `evidenceArtifactId` to every `gate-outcome` run event. D12 uses that same
  value.

  *Corrected 2026-09-08: an earlier version of this decision defined it as
  the `evidenceSha256`.* That would have given one artifact two identities
  and made a `GATE-SCOPE` citation impossible to cross-reference against the
  `gate-outcome` event for the same gate run, which is the whole point of
  citing an ID. The sha256 stays what it is — the integrity check
  `verifyGateEvidence` already performs.

**The bounded infrastructure retry is status-driven, not command-shaped, so
`src/candidate-gate-phase.ts` stays out of slice 01's file scope.** Recorded
2026-09-08 to close the contract evaluator's F-02, which the explorer had left
open. The retry loop (`src/candidate-gate-phase.ts:93-144`) wraps the whole
`runGates` call and re-runs while *any required gate's status is
`INFRASTRUCTURE`* — it never inspects whether the declaration carried a
`command` or a `run`. An in-process gate returning `INFRASTRUCTURE` therefore
gets the bounded retry for free, and no edit to that file is required.

The rejected alternative was keeping the gate command-shaped — a hidden
`afk-codex gate scope` subcommand writing findings to a side artifact.
It needs no schema change, but it spawns a process per gate run and puts
the structured findings outside the evidence record that cites them.

*Test fired: declared risk class (schema history), twice — the gate
evidence version and the gate declaration's shape.* Decided here so the
planner does not spend a dispatch on either.

## File-scope map

Finalized against `de7b0ec` and re-validated against the integration branch
`integration/pre-prd4`, which adds #178, #188 defect 1, ADR 0060 and ADR 0061 on
top of it. New modules are marked *(new)*; everything else exists today.

**The map is exhaustive for source and prompt files, and it does not list test
files.** A planner declares the map's paths for its slice plus the test files it
edits, following AGENTS.md's assertion ladder; a path the map does not name is a
scope discovery, not an omission the planner may assume (ADR 0052 / ADR 0060).

| Path | 01 #84 | 02 #85 | 03 #91 | 04 #96 | 05 #86 | 06 #132 |
|---|---|---|---|---|---|---|
| `src/orchestrator.ts` (hub) | call site | call site | dispatch | dispatch | sequencing | resolution round |
| `src/gate-policy.ts` *(new)* | creates | `acceptance` | — | — | `cost` | — |
| `src/scope-gate.ts` *(new)* | creates | — | — | reads | — | reads |
| `src/escalation.ts` | v2 schema | — | — | — | — | — |
| `src/acceptance-gate.ts` *(new)* | — | creates | — | — | — | reads |
| `src/change-summary.ts` *(new)* | — | — | creates | extends | — | — |
| `src/gate-runner.ts` | evidence fields | `acceptance` stage | — | — | cache, advisory | — |
| `src/base-gates.ts` | — | derived baseline | — | — | cheap set, prerequisites | — |
| `src/candidate-gate-phase.ts` | — | — | reads | — | sequencing | re-run |
| `src/candidate-gate-policy.ts` | — | — | — | — | decisions | — |
| `src/post-qa-gates.ts` | allowlist reuse | — | allowlist reuse | — | — | — |
| `src/qa-review.ts` | — | — | candidate | final | — | — |
| `src/context-envelope.ts` | — | — | candidate manifest | final manifest | — | repair data block |
| `src/acceptance-manifest.ts` | — | binding catalog | — | — | — | — |
| `src/afk-manifest.ts` | waiver parsing (D5) | — | — | — | — | — |
| `src/merge-resolution.ts` *(new)* | — | — | — | — | — | creates |
| `src/run-state.ts` | waiver record | — | baseline record | reuse record | cache record | resolution record |
| `src/run-events.ts` | gate/waiver events | coverage events | baseline event | reuse event | cache events | resolution event |
| `src/logger.ts` | own `run-summary.md` section | own section | own section | own section | own section + advisory | own section |
| `prompts/evaluator-contract.md` | rubric (D13) | — | — | — | — | — |
| `prompts/evaluator-contract-revision.md` | rubric (D13) | — | — | — | — | — |
| `prompts/generator.md` | `GATE-SCOPE` (D12) | — | — | — | — | — |
| `agents/generator.md` | `GATE-SCOPE` (D12) | — | — | — | — | — |
| `prompts/evaluator-qa.md` | — | — | reshaped | — | — | — |
| `prompts/evaluator-final.md` *(new)* | — | — | — | creates | — | — |
| `prompts/generator-repair.md` | `GATE-SCOPE` (D12) | — | — | — | — | data block |
| `afk.config.json` | `gatePolicy` | `acceptance` | — | — | `cost` | — |
| `ARCHITECTURE.md` | own rows | own rows | own rows | own rows | own rows | own rows |
| `AGENTS.md`, `CLAUDE.md` | — | — | — | — | launch command | — |

**Slice 01 was split twice on 2026-09-08; the map's `01` column splits three
ways.** Slice 07 (#193) took feedback integrity and the `GATE-SCOPE` channel, then
slice 08 (#195) took the file-scope gate and D22's plumbing, leaving #84 as the
policy reader alone. Both moves were forced by the same 65,536-byte inline-size
budget in `src/context-envelope.ts`, which the combined slice overflowed three
times: on the contract pair (75,419 bytes), on the revision-round planner prompt
(70,398), and on the evaluator prompt (68,241). Each time the pair was dense
rather than padded, so the slice was too large rather than the planner verbose.

The budget was **not** raised. It is the same kind of ratchet as
`suite-budgets.json`, an override can only lower it (`Math.min` at
`context-envelope.ts:1103`), and raising a context-discipline limit to fit an
oversized slice is the defect rather than the fix.

**Where the map's `01` column now lands.** #84: D1's policy reader and D6's glob
matcher — `src/gate-policy.ts`, `afk.config.json`. #195: D2/D3/D4's comparison and
D22's plumbing — `src/scope-gate.ts`, `src/gate-runner.ts`, the
`src/orchestrator.ts` call site, gate id `scope`. #193: D5, D6's deletion rule,
D12 and D13 — `src/escalation.ts`, `src/afk-manifest.ts`, `src/run-state.ts`,
`src/post-qa-gates.ts`, gate id `feedback-integrity`, the generator prompt trio and
the two evaluator-contract rubrics. `src/run-events.ts`, `src/logger.ts` and
`ARCHITECTURE.md` are shared, as they already are by five slices apiece.

Edges: #195 and #193 are both behind #84; #193 is also behind #195 for the D22
plumbing; #132 gains #195 because D3's re-resolved base is a `scope-gate` rule.
#85, #86, #91 and #96 are unchanged — they need only the policy reader.

Superseded note (kept for the record): Slice 01's first successful negotiation produced a
32,008-byte `contract.md` plus a 24,179-byte `acceptance-manifest.json`
(31 behaviors), assembling a 75,419-byte contract-evaluator prompt against the
65,536-byte inline-size budget in `src/context-envelope.ts`. The pair was dense,
not padded — about 673 bytes per behavior of real given/when/then — so the slice
was too large rather than the planner verbose. The budget was **not** raised: it
is the same kind of ratchet as `suite-budgets.json`, and raising a context
discipline limit to fit an oversized slice is the defect, not the fix.

The seam follows the decisions. **Slice 01 keeps** D1's policy reader, D2/D3/D4's
file-scope comparison, D22's gate plumbing (`GateDeclaration.run`,
`GateResult.findings`, `GATE_EVIDENCE_VERSION` 1 → 2), the gate id `scope`, and
the D6 glob matcher — so `src/gate-policy.ts`, `src/scope-gate.ts`,
`src/gate-runner.ts`, `afk.config.json`. **Slice 07 takes** D5, D6's deletion
rule, D12 and D13 — so `src/escalation.ts`, `src/afk-manifest.ts`,
`src/run-state.ts`, `src/post-qa-gates.ts`, the gate id `feedback-integrity`,
`prompts/generator.md`, `prompts/generator-repair.md`, `agents/generator.md`,
`prompts/evaluator-contract.md` and `prompts/evaluator-contract-revision.md`.
`src/orchestrator.ts`, `src/run-events.ts`, `src/logger.ts` and
`ARCHITECTURE.md` are shared by both, as they already are by five slices apiece.
Slice 07 is blocked by slice 01 and joins wave 2 beside #85 and #86; no other
slice's dependency edges change, because #85 and #86 need only the policy reader.

`prompts/evaluator-contract*.md` is written out as two literal paths
deliberately — `src/acceptance-manifest.ts` refuses a `fileScope` path
containing `*`, `?` or `[`, so a planner copying a glob row into its manifest is
refused at lock.

Two rows are load-bearing for the scope gate slice 01 itself builds.
`src/run-events.ts` and `src/logger.ts` are shared by five slices apiece,
because every slice records its evidence in run events and in its own
`run-summary.md` section, and `run-summary.md` is written from `src/logger.ts`.
Undeclared, they are exactly the ADR 0060 / #183 failure: the work is required
by the ticket and refused by the gate.

**Every slice's contract must declare `src/orchestrator.ts`, and that
declaration is what unions them into one lane.** Within each wave,
`partitionLanes` (`src/lanes.ts` step 1) unions any slices that declare an
overlapping path, so a wave's members collapse into a single lane; across waves
the DAG already serialises. Net effect: contract negotiation still runs in
parallel within a wave, but generation and merges are serial for the whole PRD.
That is the expected shape, not a defect, and it is what makes the shared files
above safe — a lane-mate's worktree is created from the feature tip after its
predecessor merged, so the `ARCHITECTURE.md`, `src/gate-policy.ts`,
`src/run-state.ts`, `src/run-events.ts` and `src/logger.ts` edits stack instead
of conflicting.

The mechanism is the declaration, not the config: `afk.config.json`'s
`orchestrator-core` resource key exists but **no code reads
`afk.config.json` or `resourceKeys` today** (plan item 2; slice 01 adds the
first reader, for `gatePolicy` only). `laneResourceGroups` recognises exactly
one resource, `migrations` (ADR 0027), and this PRD reserves no migration
prefix. So a slice whose planner omits `src/orchestrator.ts` from its file scope
gets its own lane and races its siblings on the shared modules above. Treat the
declaration as a hard requirement on every slice's manifest, not as an
incidental consequence.

Do **not** plan PRD 4 on the expectation of parallel generation. Do not
launch it concurrently with another PRD: plan §3c policy 5's file-overlap
condition fails against anything that touches the orchestrator or the
gate modules.

## Testing decisions

#72's Testing Decisions stand. Four additions, all from AGENTS.md's
"where a new assertion goes" ladder — **no slice may add a new spawned
pipeline scenario without saying in a comment why no existing fixture
reaches the state**:

1. **Unit first, and most of this is unit-shaped.** Policy validation,
   scope normalization and violation listing, the match-count matcher,
   the cache key, the derived command list, the change-summary builder,
   the reuse decision and the waiver reader are pure functions. Assert
   them without git and without agents.
2. **The lying-stub scenarios belong on existing spawned fixtures.** An
   evaluator that prose-PASSes while a gate fails, a generator that
   changes an undeclared path, a reviewer that edits source in its
   worktree, a tagged test that asserts nothing — each is an `it` on a
   `describe` in `src/orchestrator.test.ts`,
   `src/orchestrator-runs.test.ts` or `src/qa-orchestration.test.ts` whose
   `beforeAll` already reaches that state, not a new spawn.
3. **D13's rule is proved on the rendered prompt.** A unit test asserts
   the rubric text is in the assembled contract-evaluator prompt, and an
   existing contract-review test asserts that a `REVISE` citing it blocks
   the lock. Do not invent a mechanical parser-language detector.
4. **`pnpm test:budgets` stays the ceiling.** If a budget goes red, move
   the assertion up the ladder. Raising one needs the measurement in the
   commit message and a `_measured<YYYY_MM_DD>@<branch>` block in
   `suite-budgets.json`.

Slice agents run `pnpm typecheck && pnpm test:fast` plus the heavy suites
they touch — never the full suite (AGENTS.md). The evaluator and the
pre-ship gate run it for them.

## Out of scope

#72's Out of Scope stands in full: cleaner and hardener roles (PRD 5),
probe-as-evidence transport (D14), final-evaluator code attribution while
post-approval writers stay off, guardian and remediator changes (PRD 6),
the declarative external-seam acceptance runner, preservation-attribution
gates, and mutation testing. Three more, added here:

- **Acceptance-manifest schema changes.** D13 removes the only reason PRD
  4 had to touch it. It stays at version 2.
- **Optimistic lanes** (plan §3b item 16). It is a flag plus an ADR
  *after* slice 06 ships, not part of this PRD.
- **`afk.config.json`'s `resourceKeys` and `architectureDoc`.** Slice 01
  adds `gatePolicy` beside them and changes neither.

## Decisions delegated to the slice anchors files

Wave 2 (2026-09-08) escalated three more decisions. They are recorded in
`anchors/<NN>-<slug>.md` rather than here, because each is slice-local and this
document's growth is itself a cost — the explorer's wall-clock rose 154s → 268s
across slice 01's early attempts as `prd.md` grew.

- **`gatePolicy.acceptance`'s JSON shape** (#85) — `anchors/02-behavior-coverage-gate.md`.
  A `{ command, args, matcher }` object with a literal `{behaviorId}` placeholder
  that must appear in `args`, or the launch refuses.
- **`gatePolicy.cost`'s JSON shape** (#86) — `anchors/05-test-cost-split.md`. A
  hybrid: records only for `skipDetectors` and `relatedTests`, where a consuming
  project must express its own rules; `expectedCostMs` and gate prerequisites stay
  code in `src/base-gates.ts`.
- **Where the `scope` gate's call site goes** (#195) — `anchors/08-file-scope-gate.md`.
  On the final candidate after the QA window and before the merge, **not** in the
  pre-QA set. Binding ADR 0048's amendment warrant is an independent evaluator
  finding, and a required pre-QA scope gate makes that warrant unobtainable, since
  a red deterministic gate never dispatches an evaluator (D19). #195's AC1 weakens
  from "does not reach evaluation or merge" to "does not merge"; the merge block,
  which is the security property, is unchanged.

## Launch preconditions

Each is stated so it can be checked rather than asserted. Verified against
`integration/pre-prd4` on 2026-09-07 unless marked otherwise.

1. `pnpm lint:tickets 84 85 86 91 96 132` exits 0. **Verified.** It also prints
   three "waiver matched nothing" notes for #92, #93 and #95 — stale waivers
   belonging to earlier PRDs, not to these tickets. They do not gate.
2. PRD 3's slice issues #83, #90, #95 and #99 are CLOSED and
   `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST` is present in
   `src/context-envelope.ts`. **Verified.** Parent #71 stays OPEN for its
   follow-ups; its state is not the check, because the dependency PRD 4 has is
   the shipped manifest entry (D9, D11), not the umbrella.
3. Plan item 21 (#135, provider environment filtering) is settled, since the
   plan sequences it between PRDs 3 and 4. **WAIVED for this launch on
   2026-09-07:** launch only through `scripts/min-env.sh`, which forwards the
   named platform keys in that script through a clean intermediate environment
   before it execs AFK. The shell may add its own bookkeeping keys; no other
   inherited key is forwarded. The wrapper covers provider processes and
   gate-command descendants for this launch; #135 stays OPEN because an
   unwrapped later launch would still inherit the operator's full environment.

   **Backend changed to Claude Code on 2026-09-08, and the waiver's evidence was
   re-earned for it.** The paragraph above was written about Codex; the operator
   switched backends after observing Codex stopping mid-response. The minimized
   environment was re-smoke-tested against the new backend: `claude` resolves
   under the wrapper's forwarded `PATH` and authenticated successfully with only
   the wrapper's approved keys present, because Claude Code's credentials live
   under `USERPROFILE`/`HOME`, both of which the wrapper forwards. The
   `AWS_PROFILE` / `AWS_DEFAULT_PROFILE` / `AWS_CONFIG_FILE` paragraph below is
   Codex-specific and does not bind a Claude launch; all three were absent on the
   launch machine either way.

   Accepted residual exposure: this is not an OS or network sandbox, so
   credential files under the operator's profile remain readable; applying the
   wrapper is an operator launch obligation rather than an AFK-enforced
   invariant; and the wrapper does not retain `AWS_PROFILE`,
   `AWS_DEFAULT_PROFILE`, or `AWS_CONFIG_FILE`. Those selectors were absent on
   the launch machine and the Codex end-to-end smoke authenticated in the
   minimized environment. If an operator deliberately sets one later, this
   wrapper drops it and Codex may select its managed profile instead. Rebuild
   or invoke the wrapper from the committed copy, never from an unrecorded
   temporary file.
4. No other AFK run is live: see the one-lane note above. Operator-confirmed.
5. `afk.json` in this directory selects all six slices. No slice adds a
   migration, so no prefix is reserved. **Verified** against
   `parseAfkManifest`, with the D5 caveat: `protectedChangeWaivers` is
   accepted-and-ignored until slice 01 parses it, so the pre-recorded waiver is
   inert on this launch. That is the intent (see D5 and `issues.md`).
6. Launch with the verification command explicit until slice 05 derives
   it: `afk-claude --prd-dir .kiro/specs/afk-v2-acceptance-scope-gates
   --test-command "pnpm typecheck && pnpm test:fast"`.

   Two launch mechanics that cost the 2026-09-07 attempts real time, recorded so
   the next operator does not rediscover them:

   - **The globally linked `afk-claude` / `afk-codex` on this machine is not this
     worktree.** It resolves through `PNPM_HOME` to a git-installed copy of
     afk-pipeline, so launching by bare name silently runs old code. A self-run
     invokes `node <repo>/dist/afk-claude.js` after `pnpm build`.
   - **`scripts/min-env.sh` cannot be invoked from a bare `cmd.exe`.** It resolves
     its clean intermediate shell with `type -P bash`, and on an unmodified
     Windows `PATH` that finds `C:\Windows\System32\bash.exe` (WSL), which
     deadlocks with `get_proc_lock: Couldn't acquire sync_proc_subproc`. Put Git's
     `usr\bin` ahead on `PATH` before invoking it. Worth hardening in the script
     itself — prefer `/usr/bin/bash` when it exists.

7. Slice-level code anchors are on the six slice issues, not here: each was
   verified against this branch on 2026-09-08 after slice 01 escalated three
   times on details `prd.md` had validated for paths but not for type signatures
   or persisted schema versions. See `LAUNCH-BLOCKERS.md` for the full account and
   #192 for the planner-policy issue it exposed. Deliberately kept off this
   document: the explorer's cost rose 154s → 206s → 268s across the three
   attempts as `prd.md` grew, so slice-specific detail belongs on the slice.
