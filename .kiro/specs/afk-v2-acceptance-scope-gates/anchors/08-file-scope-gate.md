# Code anchors — slice 08 (#195), File-scope gate

Verified against `integration/pre-prd4` on 2026-09-08. Read this before writing
the contract. It is kept out of the issue body deliberately: the planner prompt
overflowed its 65,536-byte inline budget by 769 bytes with the anchors inline,
and a file the planner opens on demand costs the prompt a pointer instead of
3.5 KB.

## Code anchors — verified on `integration/pre-prd4`, 2026-09-08

Three `LOAD_BEARING_SILENCE` escalations and one round-1 `REVISE` on this slice
all traced to **type signatures and persisted schema versions**, never to a
missing path. See `LAUNCH-BLOCKERS.md` and #192.

| Anchor | What it already does |
|---|---|
| `src/orchestrator.ts:5525` | `runCandidateGatePhase` is the pre-QA candidate-gate call site. **It is NOT where the `scope` gate goes** — see the call-site decision below. |
| `src/orchestrator.ts` ~5350 | The accepted-pair integrity check (`acceptedPair`, `mutatedOwned`, `restoreAcceptedContractPair`) — what earns `acceptedPairIntact: true`. |
| `src/candidate-gate-phase.ts:93-144` | The bounded infrastructure retry wraps the whole `runGates` call and re-runs on any *required* gate's `INFRASTRUCTURE` status, never inspecting declaration shape. An in-process gate gets the retry free, so **this file is NOT in your scope** (closes round 1's F-02). |
| `src/candidate-gate-phase.ts:111-116` | Already computes `relative(repoRoot, evidencePath)` and passes it as `evidenceArtifactId` to `gate-outcome` events. That **is** the artifact id; do not invent a second. `evidenceSha256` stays the integrity check. |
| `src/run-events.ts:30` | `RunEventPayload` is an explicitly open union; `gate-outcome` exists but carries no offending-path list. A new variant needs no schema decision. |
| `src/logger.ts:394` | The run-summary is one template literal (`## Base Gates`, `## Dependency Holds`, `## Adopted Slices`). Your section is a new `## ` block; there is no per-slice machinery. |

Confirmed by reading: **no code reads `afk.config.json` today** (you write the
first reader; the file holds `version`, `resourceKeys`, `architectureDoc`, and
`gatePolicy.version` is its own independent schema version).
`src/acceptance-manifest.ts` is already `version: 2` and already refuses a
`fileScope` path containing `*`, `?` or `[` — it stays at 2.

**Settled; do not escalate:** the scope gate takes `acceptedPairIntact` from the
existing integrity check, never a fresh one, and **fails closed** if that check
has not run for the tree being gated.

**Size discipline.** This slice has now overflowed the 65,536-byte inline budget
twice — once on the contract pair, once on the planner prompt. State each
behavior once, cite `prd.md` and this issue by reference, and do not mirror these
anchors into `contract.md`. Use tracked casing for paths (`ARCHITECTURE.md`).

## Manifest path casing — settled, and state it in the contract

`normalizePath` (`src/acceptance-manifest.ts:64-71`) **lowercases**, and the
parser stores the normalized form (`line 269`:
`fileScope.paths.map((path) => normalizePath(path, source))`).
`outOfScopeChangedPaths` lowercases each changed path before comparing against
that stored set. So **manifest path comparison is case-insensitive by
construction** and a casing mismatch in `fileScope` can never cause a false
out-of-scope report.

Round 1 of 2026-09-08 was nonetheless blocked (F-03) on `architecture.md` versus
`ARCHITECTURE.md`. Do two things so it does not recur:

1. **Write the tracked casing in `fileScope`** — `ARCHITECTURE.md`, as
   `git ls-files` and this repo's `afk.config.json` `architectureDoc` both record
   it. It costs nothing and it matches every other statement of the path.
2. **Say in the contract that the comparison is case-insensitive**, citing
   `src/acceptance-manifest.ts:64-71` and `:269`. A reviewer that does not know
   this reads a casing mismatch as a live scope hazard.

Do not conflate this with B-03. D6's `testGlobs` matching is **case-sensitive on
every platform** — that is a deliberate decision about matching test-file paths,
and it is a different comparison from the manifest's, for a different purpose.

## Where the `scope` gate's call site goes — settled, do not escalate

Recorded 2026-09-08 after this slice's planner raised it as a
`SPEC_CONTRADICTION`. Correctly: #195 AC1 said "does not reach evaluation or
merge" and this file said `:5525` was the one call site, while #72 says "the scope
gate runs against the final candidate before merge" and binding ADR 0048 needs
something the pre-QA placement makes impossible.

**Decision: the required `scope` gate runs on the final candidate, after the QA
window closes and before the merge.** Not in the pre-QA declaration set.

The reason is ADR 0048, which `prd.md` lists as binding and which `prd.md:24-25`
gives precedence over the PRD itself. ADR 0048's "Cross-reference" section states
that the amendment door's warrant is **an independent evaluator finding** — "a
generator cannot forge one, so 'the work is there' is evidence an evaluator judged
the work correct and only the bookkeeping is wrong." A required pre-QA scope gate
makes that warrant unobtainable: a red deterministic gate returns to the generator
and never dispatches an evaluator (D19), so QA never runs on a tree holding the
undeclared change, so `planScopeAmendment` — which requires the path to be
**already changed** — can never fire. That would silently delete the recovery door
ADR 0048 was written to provide, and with it the protection against #112's
destructive remedy. Deleting a binding ADR's mechanism is not this slice's to do.

Consequences, all authorized:

- **#195 AC1 weakens from "does not reach evaluation or merge" to "does not
  merge."** An undeclared change still reaches the candidate evaluator. The
  security property is unharmed: the merge is still blocked, and an ADR 0048
  amendment still requires an independent QA finding, so the actor being
  constrained still cannot author its own exemption.
- `src/post-qa-gates.ts` already governs the QA-window-to-merge transition and is
  the natural home for the call site. Read it before choosing the exact seam.
- D12's `GATE-SCOPE` channel remains the pre-build door for a discovery made
  before the path is edited; ADR 0052's full-tree cleanliness refusal is
  unchanged. The two doors stay asymmetric on purpose — ADR 0048's own words are
  "Do not 'reconcile' them."
