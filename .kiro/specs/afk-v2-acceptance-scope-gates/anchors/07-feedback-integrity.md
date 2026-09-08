# Code anchors — slice 07 (#193), Feedback integrity and gate-scope revisions

Verified against `integration/pre-prd4` on 2026-09-08. Read this before writing
the contract. Kept out of the issue body deliberately: slice 01 overflowed the
65,536-byte inline budget twice, once on the contract pair and once on the
planner prompt, and a file the planner opens on demand costs a pointer instead
of several KB.

## Code anchors — verified against `integration/pre-prd4` on 2026-09-08

**Method, and why it matters.** Every gap found on #84 came from a **type
signature or a persisted schema version**, never from a missing path — `prd.md`'s
file-scope map was validated for paths only. Before writing your contract, open
each file in your row of that map and check the PRD's claim about it against the
actual declaration. Check in particular: `package.json` dependencies (**there are
none** — AFK has no runtime dependencies), every `version:` literal on a
persisted interface, and whether a helper you call takes an attestation argument
with no default.

### What already exists — reuse it, do not rebuild it

| Anchor | What it already does |
|---|---|
| `src/orchestrator.ts` ~5372–5450 | ADR 0052's whole focused-revision door: escalation archive, `parseScopeEscalation`, `MAX_SCOPE_REVISIONS_PER_ROUND`, `listChangedFiles`, `outOfScopeChangedPaths`, refusal. D12's "the same request is refused once the requested path has already been edited" **is already implemented here.** Let a `GATE-SCOPE` escalation through this existing door; do not build a second one. |
| `src/orchestrator.ts` ~5350 | The accepted-pair integrity check (`acceptedPair`, `mutatedOwned`, `restoreAcceptedContractPair`). This is what earns `acceptedPairIntact: true` at the `outOfScopeChangedPaths` call. |
| `src/artifacts.ts:745` | `ValidArchivedScopeEscalation` stores the whole `ScopeEscalation`, so once that type gains `gateEvidence` the review-archive record preserves the gate ID and evidence ID **automatically**. Do not add a second mechanism. |
| `src/escalation.ts:48` | `PRE_BUILD_SCOPE_FINDING_ID` — export `GATE_SCOPE_FINDING_ID` beside it. |
| `src/escalation.ts:288` | `requireExactKeys(input, ["version","findingIds","paths","reason"], source)` is an **exact**-key check. It must admit `gateEvidence` conditionally on the version, not unconditionally. |
| `src/post-qa-gates.ts:37` | `QA_WINDOW_ARTIFACT_NAME`, the existing artifact allowlist regex. Reuse; do not write a second dialect. Note it does **not** admit `escalation.md` — that path is exempted by `outOfScopeChangedPaths`'s slice-artifact-dir carve-out. |
| `src/run-events.ts:30` | `RunEventPayload` is an explicitly open union and `gate-outcome` already exists. New waiver events need **no** schema decision. |

### What the PRD asserts and the code confirms

- `prompts/evaluator-contract.md` and `-revision.md` both carry the
  `# Durable finding lineage` and `# Control-plane situation` sections and the
  `severity` / `state` bullets (lines 106/108 and 132/134). D13's warning is
  accurate: the rubric addition is **additive**; do not remove them.
- All three generator prompt/agent files carry the version-1 escalation JSON
  literal and the two-way `PRE-BUILD-SCOPE` branch, as D12 says.
- `src/acceptance-manifest.ts` is already `version: 2`. Confirmed: it stays there.

### Load-bearing details settled here (do not escalate these)

1. **`src/prompt-template.test.ts:184` asserts the escalation JSON literal
   verbatim** with `toContain`, and line 188 pins the "Never mix
   `PRE-BUILD-SCOPE` with a real finding ID" sentence by regex. D12's three-way
   branch therefore **requires editing that test file.** Declare it in your file
   scope.
2. **`escalation.md` version 2 may omit `gateEvidence`.** Version is a schema
   version, not a document kind: a v2 document without `gateEvidence` is an
   ordinary cited-finding or `PRE-BUILD-SCOPE` escalation. Version 1 must never
   carry it. The parser accepts both versions; the generator prompts emit
   version 2. Requiring `gateEvidence` in v2 was rejected because it would make a
   generator pick its schema version from what it happens to be citing.
3. **`GATE-SCOPE` joins the existing mutual-exclusion rule.** `gateEvidence`
   present implies `findingIds` is exactly `["GATE-SCOPE"]`; `GATE-SCOPE` present
   implies `gateEvidence` is required; never mixed with cited IDs or with
   `PRE-BUILD-SCOPE`.
4. **`evidenceArtifactId` is the repo-relative evidence path**, not a sha256.
   `src/candidate-gate-phase.ts:111-116` already computes
   `relative(repoRoot, evidencePath)` with forward slashes and passes it as
   `evidenceArtifactId` to every `gate-outcome` run event; a `GATE-SCOPE`
   citation uses that same value so it cross-references the event for the same
   gate run. Corrected 2026-09-08 — an earlier prd.md D22 said sha256.
5. **`RunState` is `version: 3`** (`src/run-state.ts:50`), a persisted schema, so
   the waiver record is a bump to **4** with an optional per-slice
   `appliedWaivers` array of D5's four fields; the reader accepts 3 and defaults
   the array empty (prd.md D22).
6. **The `feedback-integrity` gate takes `acceptedPairIntact` from the existing
   integrity check, never a fresh one.** If that check has not run for the tree
   being gated, the gate **fails closed** rather than passing `true`.
7. **A waiver `path` is one exact repo-relative path, never a glob**, and the
   glob dialect for `testGlobs` is #84's narrow hand-rolled subset — literal
   segments, `*`, `**`, case-sensitive on every platform (prd.md D5, D6). Call
   #84's matcher; do not write a second one.

### Size discipline

#84 overflowed the contract-evaluator's 65,536-byte inline budget. Keep the
contract pair well inside it: state each behavior once, cite `prd.md` and this
issue by reference rather than restating them, and do not mirror these anchors
into `contract.md`.


