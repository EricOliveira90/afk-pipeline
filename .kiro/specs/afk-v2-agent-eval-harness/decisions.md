# PRD 7 — decision inventory

Companion to `intent.md`. Every load-bearing decision the PRD 7 spec must
settle before a slice is written.

Each item carries the options, the trade-off, and one of two marks:

- **MAINTAINER** — an operator decision. Do not let a slice make it. Under
  plan §3c policy 1 a slice hitting one of these escalates
  `LOAD_BEARING_SILENCE`, which costs a round and, on PRD 4's evidence,
  sometimes a whole slice.
- **DEFAULT** — a defensible default exists and is named. The maintainer
  confirms or replaces it; either way the spec states it and no slice asks.

Why this file exists: PRD 4's slice 01 escalated `LOAD_BEARING_SILENCE` on
one unstated JSON shape and was split twice; its `prd.md` D1 records the
correction. #192 filed the general pattern — a role reasoning from an
assumption the repository had already settled. Almost everything in PRD 7 is
a persisted schema or a public type shape, which is precisely that class.

Counts: **15 MAINTAINER**, **22 DEFAULT**, 37 in total. Section H records
three contradictions between item 18 and the repository, plus one smaller
inconsistency. Read section H first — D1 and D2 cannot be answered without
it.

---

## A. Recorded envelopes — what a recording is, and whether one exists

### D1 — where a recorded-envelope case gets its envelope. **MAINTAINER**

Nothing persists an assembled envelope today. `assembleContextEnvelope`
(`src/context-envelope.ts:1200`) returns `{ prompt, evidence }`; the prompt
goes straight into `provider.invoke` and is never written to disk. The only
durable trace is the `prompt-assembly` event (`src/run-events.ts:97`), which
records `assembledByteSize`, `includedArtifactClasses`,
`includedArtifactIds`, `omittedArtifactClasses` and
`contextManifestVersion` — counts and ids, never content. See H1.

Options:

1. **Start persisting the assembled prompt.** New per-invocation artifact in
   the run directory. Honest, complete, and immediately useful for #196
   diagnosis too. Cost: up to 65 KB per invocation on the happy path, plus a
   redaction question (D5).
2. **Re-assemble from the archive.** `includedArtifactIds` plus the
   negotiation archive (`.afk/artifacts/<runSlug>/slice-<NN>/`) plus the
   manifest can rebuild an envelope. Cheap at run time. But it reproduces
   *today's* assembler, so a case can never detect an assembly regression —
   which is one of the three things the harness exists to catch.
3. **Hand-author the seed pack.** No new machinery. The pack then tests the
   role's judgment on a plausible envelope, not on a real one, and the
   "reuse the recorded format, do not invent a parallel fixture format"
   constraint quietly becomes a fiction.

Trade-off in one line: option 1 pays a recurring happy-path cost to get a
real recording; option 2 is free and blind to the regression class it most
needs to see; option 3 is free and drops the word "recorded".

This is the decision the whole PRD hangs on. Answer it before slicing.

### D2 — what the seed pack is actually seeded from. **MAINTAINER**

Item 18 names three sources: recorded PRD 1 envelopes, the #111–#121
incidents, and evaluator and classifier verdict cases. All three need
review — see H1, H2 and H3. Concretely: PRD 1 ran before envelope assembly
existed, most #111–#121 defects are orchestrator code rather than agent
behavior, and the failure classifier is deterministic code that needs no
model call. The spec must name the actual per-source case counts and reject
sources that cannot produce a case.

### D3 — how a recorded envelope is keyed. **DEFAULT**

Default: **identity is the tuple** `(runSlug, ghIssue, role, round,
attempt)`, and the pack additionally stores a `sha256` of the assembled
prompt as an integrity check, not as the key. Precedent: PRD 4 D22 chose the
repo-relative evidence path over a sha256 for `evidenceArtifactId`, for the
same reason — a human must be able to find the thing the id names.
Alternative: content-hash as the primary key. That deduplicates identical
envelopes but makes a case unnameable in a report and unattributable to the
run it came from.

### D4 — what happens when a recorded envelope no longer assembles or parses. **DEFAULT**

A manifest version bump, a renamed artifact class, or a retired role makes an
old case unreplayable. Default: a **distinct per-case outcome `STALE`**,
never a mismatch, and `STALE` never counts toward a pass rate. Alternative:
treat it as a failure, which turns every deliberate manifest change into a
wall of red and teaches the maintainer to ignore the report — the
`test:budgets` lesson (plan §3c policy 4).

### D5 — redaction of recorded content. **MAINTAINER**

An assembled envelope embeds repository source, issue text, and prior
artifacts. A committed scenario pack is a permanent public-ish copy of all
of it. AFK's own pack is low risk; the runner's rule is not, because
consuming projects own packs and rumo-app handles clinic data.

Options: no redaction and a documented warning; a declared deny-list of
paths and patterns; refuse to record unless the project declares a policy
(fail closed, per PRODUCT.md principle 6).

This is a **security posture**, which plan §3c policy 1 names as a declared
risk class. A slice must not decide it.

### D6 — recording is on or off by default. **DEFAULT**

Default: **off**, enabled by an explicit flag, with enable/disable recorded
in run evidence. PRODUCT.md principle 7 ("new machinery defaults off") and
principle 4 ("nothing adds minutes to the happy path") both point here.
Only relevant if D1 resolves to option 1.

---

## B. Scenario-pack schema, version 1

### D7 — the version-1 member shapes. **MAINTAINER**

This is PRD 4 D1 repeating itself. Naming the concepts is not fixing the
JSON. The spec must write out, field by field, the shared scenario fields
and the per-kind fields for both case kinds, and state that an unknown
member refuses the pack (PRD 4 D1's rule).

Minimum the spec must fix: the discriminator field name and its values; how
a case names its role; how a case names its source incident; how the
expected value is represented (D9); whether a case can carry a per-case call
budget; and whether unknown fields are ignored or refused.

### D8 — pack layout and discovery. **DEFAULT**

Default: a **pack directory** holding one JSON file per scenario plus an
index file carrying `version: 1`; the pack path is passed on the command
line, with an optional `afk.config.json` key naming the project's default
pack. Rationale: a scenario is edited and reviewed one at a time, and one
file per scenario keeps diffs readable and avoids merge conflicts when two
sessions add scenarios. Alternative: a single JSON file — simpler to
validate, worse to review, and a guaranteed conflict surface.

### D9 — what the expected value is, exactly. **MAINTAINER**

Item 18 says "compare exact structured dispositions". The evaluator artifacts
are not uniformly comparable. `ContractReview` is
`{ version: 2, verdict, findings }` where each `ContractReviewFinding`
carries `id`, `severity`, `behaviorIds`, `state`, `clearCondition` — and also
`evidence`, `expected` and `observed`, which are **free prose**. `QAReview`
adds `failureClass` and `infrastructureEvidence`. `FinalReview` adds
`baselineTreeId`/`finalTreeId`, which differ per run by construction.

Exact deep equality over these artifacts yields a permanent 0% match rate.
So "exact" must mean exact over a **named projection**, and the spec must
name it per role. Candidate projection: `verdict`, plus `failureClass` where
present, plus the set of finding `severity` values, plus `behaviorIds`. Prose
fields and tree ids excluded.

Do not let a slice choose the projection. It determines what the harness can
detect and is the single field-shape decision most likely to be silently
wrong.

### D10 — comparison operates on parsed values, not text. **DEFAULT**

Default: parse the role's output with the **production parser**
(`parseContractReview`, `parseQAReview`, `parseFinalReview`,
`parseGuardianReview`) and compare parsed values. Precedent: final
evaluation validates the copied-back `final-review.json` exactly once and
the parsed value keys the verdict, so validation and verdict cannot describe
different documents (`ARCHITECTURE.md`, PRD 4 D19). Bonus: a parser
regression then shows up as an eval error rather than as a mismatch.

### D11 — ordering and set semantics inside a projection. **DEFAULT**

Default: **`findings` compare as a set keyed by finding id; every other
collection compares as a set.** Order of findings is not a behavior the
prompts promise, so ordering sensitivity would produce mismatches that mean
nothing.

### D12 — how a case names its role. **DEFAULT**

Default: the pack stores a string, validated against the existing
`ContextEnvelopeRole` union, and an unrecognised value **refuses the pack**
rather than skipping the case. A silently skipped case is a case that reports
green forever. Cost: the pack schema is coupled to an internal union, so
retiring a role is a pack-schema event. That coupling is the point.

### D13 — the version constant and its supported set. **DEFAULT**

Default: follow the established convention exactly — an exported
`EVAL_PACK_VERSION`, a `SUPPORTED_EVAL_PACK_VERSIONS` tuple, a reader that
refuses anything outside it, and the bump rationale in TSDoc above the
constant. Precedent: `GATE_EVIDENCE_VERSION = 3` with
`SUPPORTED_GATE_EVIDENCE_VERSIONS = [1,2,3]` (`src/gate-runner.ts:43-48`);
`RUN_STATE_VERSION = 5` with reader-side adaptation
(`src/run-state.ts:61`); `EVENTS_SCHEMA_VERSION` (`src/run-events.ts:26`).
`ARCHITECTURE.md`'s placement rule requires the reader.

---

## C. The model-call cap

### D14 — what one "model call" is. **MAINTAINER**

The existing counter counts **tool calls**, not model calls:
`toolCallCount` is incremented per `tool_call` stream event in
`src/invocation-runtime.ts:351` and capped by `InvokeOptions.maxToolCalls`
(`src/agent-provider.ts:50`, ADR 0036). There is no model-invocation counter
anywhere. The closest durable record is one `invocation-completed` event per
dispatch.

Options: count **agent invocations** (one `provider.invoke` = one call —
countable, cheap, and what an operator means by "how many agents did this
spend"); count provider-reported model requests (not reported by any
provider today, so it needs new provider surface, which PRODUCT.md forbids
speculatively); count tool calls (already implemented, but measures a
different thing and would make the cap depend on how chatty a role is).

The choice changes both the config name and what `INCOMPLETE` means.

### D15 — where the cap is configured. **DEFAULT**

Default: a **CLI flag** on `afk eval`, plus an optional `afk.config.json`
key, with the pack able to lower but never raise it. Precedent for
stricter-only overrides: the envelope inline-size budget uses `Math.min`
(`src/context-envelope.ts:1245`), and `suite-budgets.json` is a ratchet.
Note that `maxToolCalls` has **no** config path today — it is reachable only
programmatically — so no existing key can be reused.

### D16 — the cap's accounting scope. **DEFAULT**

Default: **one budget for the whole eval run**, decremented per counted
call, checked before each dispatch. Alternative: per-scenario caps, which
bound a runaway case but cannot bound a run's total spend, which is the risk
item 18 names.

### D17 — cost cap as well as call cap. **DEFAULT**

Default: **v1 caps calls only** and *records* `costUsd` from
`InvocationStats`. A cost cap depends on provider-reported cost, which only
some providers populate, so a cost cap would behave differently per backend
and break provider-agnosticism at the interface (ADR 0002).

### D18 — what a capped run does to work already done. **MAINTAINER**

When the cap stops a run mid-pack, the completed cases have real results.
Options: report them alongside `INCOMPLETE` and state how many cases never
ran; report `INCOMPLETE` and nothing else; write partial results but refuse
to compute any aggregate.

Item 18 says report `INCOMPLETE`. It does not say whether partial per-case
results survive. Given the failure mode item 18 itself names — "noisy or
incomplete results mislead maintainers" — this needs an explicit answer, not
an implementation choice.

### D19 — scenario execution order and determinism. **DEFAULT**

Default: **declared order, stable, no parallelism in v1.** A cap plus
parallel dispatch makes "which cases ran" nondeterministic, so two runs of
the same pack with the same cap would report different `INCOMPLETE` sets.

---

## D. Results, `INCOMPLETE`, and the non-gating boundary

### D20 — where `INCOMPLETE` surfaces. **MAINTAINER**

`afk eval` is not a pipeline run. Options: reuse `RunJournal` and get a run
directory, `run.log` and `events.jsonl` for free, at the cost of putting
non-pipeline events into the pipeline's event schema and needing a new event
type in `src/run-events.ts`; or write a standalone report and stay out of the
run record entirely.

Whichever way, the spec must name every surface `INCOMPLETE` reaches:
process exit status (D21), the report artifact (D22), stdout, and the run
record if there is one.

### D21 — exit status semantics. **MAINTAINER**

This is the non-gating boundary in mechanical form. If a mismatch exits
non-zero, someone will eventually put `afk eval` in a CI job and the
recorded "no merge-gating" decision is broken by a shell script, not by a
decision.

Options: **always exit 0 unless the runner itself failed** (a mismatch is
data); exit non-zero on `INCOMPLETE` and runner errors but never on a
mismatch; exit non-zero on any mismatch.

Recommended framing for the maintainer: option 1 or 2, and a test asserting
that a pure-mismatch run exits 0. Success measure 4 in `intent.md` depends on
this.

### D22 — the report artifact. **DEFAULT**

Default: **both a machine-readable JSON result and a rendered Markdown
summary**, written under the eval output directory and **not committed**.
Rationale: the JSON is what a future trend view reads; the Markdown is what
the maintainer reads weekly. Uncommitted, because a report is a measurement
and a committed measurement invites a diff-based gate. Contrast: item 19's
*proposals* are deliberately committed.

### D23 — the per-case outcome vocabulary. **DEFAULT**

Default, and it needs a `CONTEXT.md` entry: `MATCH`, `MISMATCH`, `STALE`
(D4), `NOT-RUN` (the cap stopped before this case), `ERROR` (the runner or
the parser failed). A pass rate is computed over `MATCH` + `MISMATCH` only,
and the report always states the other three counts next to it.

### D24 — whether a pass rate is reported at all. **MAINTAINER**

A single percentage is the most quotable and the most misleading number the
harness can emit, and a quotable number is how a report becomes a gate.
Options: report per-case results and no aggregate; report an aggregate only
when zero cases are `NOT-RUN`/`ERROR`; always report it with the caveat
counts.

---

## E. The learning-proposal schema — the cross-repo half

Read before deciding anything in this section: **rumo-app #809 is closed and
shipped.** `rumo-app/docs/governance/findings-ledger.md` exists, its format
is enforced by `rumo-app/scripts/__tests__/findings-ledger.test.ts`, and
`rumo-app/.agents/skills/post-merge-cleanup/SKILL.md` already prescribes
what a recurrence proposal names. So this is a negotiation against a shipped
artifact, not a greenfield design — and item 18's phrasing that PRD 7
"defines" the schema (H3) is only half true.

### D25 — format: JSON or Markdown. **MAINTAINER**

AFK item 19 says `learning-proposals.json`. rumo-app shipped a **Markdown**
ledger with bolded single-line fields, validated by a regex anchored at
`^\*\*Field:\*\*`. The two are not the same artifact — rumo's is the
occurrence ledger, AFK's is the proposal — but if the *proposal* is the
shared shape, one of the two repos changes.

Options: JSON canonical with a Markdown rendering (AFK's plan wins; rumo
gains a renderer); Markdown canonical (rumo's shipped format wins; AFK drops
the `.json` name item 19 already states); both, with the JSON canonical and
the Markdown generated and validated against it.

Coordination cost: highest of anything in this file. Decide it first, in
both repos, in writing.

### D26 — the field set, field by field. **MAINTAINER**

The two repos already name different sets:

| Field | AFK item 19 | rumo shipped | Note |
|---|---|---|---|
| finding class | yes | yes | stable kebab-case identifier in rumo |
| occurrence count | yes | in the ledger | rumo derives it from prior ledger entries |
| target asset | yes | yes | shape disputed — see D27 |
| proposed diff | yes | "proposed change" | diff vs prose is a real difference |
| occurrence links | **no** | yes, "both occurrence links" | rumo needs provenance AFK does not currently plan |
| validation | **no** | yes | how the proposer knows the change is right |
| date | no | yes | ledger field |
| PRD slug | no | yes | ledger field |
| disposition | no | yes | `none \| proposal opened \| eval-candidate` |

The union is not automatically right. Each added field is a permanent
cross-repo coordination cost; each omitted field is a repo that cannot
express its own case. Decide per field, and record which repo needs each one.

### D27 — the shape of `target asset`. **MAINTAINER**

rumo's routing table enumerates targets: owning skill, `docs/CONVENTIONS.md`
via `@architect-review`, `docs/PRODUCT.md` via `@pm-review`,
`docs/BUSINESS.md` via `@ceo-review`, a deterministic check, a
governance-eval scenario, and `AGENTS.md` as last resort. Protected-memory
targets carry a guardian owner.

AFK has no `@ceo-review` and no `docs/BUSINESS.md`; its guardians are the
architect reviewer and the PM reviewer. So a shared enum is a superset
neither repo fully uses, and a free-form string is a field no consumer can
route on.

Options: free string path; `{ type, path }` with a shared enum; a shared
enum plus an optional `guardian` field; per-repo extension values under a
declared prefix.

### D28 — whether the occurrence ledger is shared too, or only the proposal. **DEFAULT**

Default: **share only the proposal.** rumo's ledger is shipped, Markdown, and
tied to its Close phase and its `docs/governance/log.md` conventions. AFK has
no ledger and item 19 derives counts from tracked review and spec history.
Forcing one ledger format on both is a large change to a working artifact for
no stated benefit.

### D29 — who owns the canonical schema and how a bump is coordinated. **MAINTAINER**

Plan §6 says changing the fields requires cross-repo coordination. It does
not say what coordination is. Undefined, this becomes "whoever edits last
wins", which is exactly how two repos end up silently disagreeing about a
version-1 format.

The spec must name: which repository holds the canonical definition; whether
a version bump requires a paired change in the other repo before merge; and
what a consumer does when it reads a version it does not know (refuse, per
PRODUCT.md principle 6, is the obvious answer, but it must be written).

### D30 — whether AFK publishes a validator the consumer can run. **DEFAULT**

Default: **yes** — export the schema and its validator as a package entry
point, so rumo-app runs AFK's validator rather than reimplementing the rules.
Precedent: ADR 0034 exports `./afk-manifest` for exactly this reason, so the
consuming repository's preflight applies the same rules. Alternative: publish
the schema as prose and let each repo validate its own, which guarantees
divergence.

---

## F. Runner shape and placement

### D31 — what "replay" replays. **DEFAULT**

Default, and it must be stated because it is easy to get backwards: the
harness replays a recorded **input** against a **live model**, and compares
the fresh output to a recorded expectation. It does not replay recorded
outputs — a recorded-output harness would test the parser, which the existing
suites already do, and would need no model-call cap at all.

Consequence: the cap and the weekly cadence exist because every
recorded-envelope case costs a real agent invocation. Which in turn is why
D2 matters: any case that needs no model call belongs in a unit test, not in
a capped pack.

### D32 — module placement and CLI attachment. **DEFAULT**

Default: a new `src/eval-command.ts` exporting
`runEvalCli(args, repoRoot)`, plus sibling `src/eval-*.ts` modules for the
pack reader, the comparator and the report; an `if (args[0] === "eval")`
branch in each CLI entry; a line in each `usage()`. `src/orchestrator.ts` and
`src/wave.ts` do not grow — `ARCHITECTURE.md` names both as hubs, and the
existing subcommands (`status`, `stop`, `clean-failed`, `adopt`) are the
worked precedent for the one-module-per-subcommand convention.

### D33 — which CLI entries get `eval`. **DEFAULT**

Default: **all three** (`afk`, `afk-claude`, `afk-codex`), because the
provider under test is the point of the exercise and each entry binds one
provider. Note the current asymmetry: `afk-claude` and `afk-codex` carry only
`stop` and `clean-failed` today, so this is a small deliberate widening.

### D34 — whether an eval run touches git at all. **DEFAULT**

Default: **no worktrees, no branches, no run state.** `provider.name` feeds
branch, worktree and run-slug namespacing (`src/run-identity.ts`), so a
runner that reuses the pipeline's identity machinery starts creating
branches. An eval reads a pack and invokes agents; it has no slice and no
merge.

### D35 — how the runner itself is tested. **DEFAULT**

Default: **unit tests over a stub `AgentProvider`.** `buildStubProvider`
(`src/orchestrator.fixtures.ts:397`) is the precedent, and ADR 0063 plus
`AGENTS.md` make a new spawned pipeline scenario the last resort. An eval
scenario is not a test of AFK and must never be run by `pnpm test` — that
would put model calls in the deterministic gates.

### D36 — the vocabulary. **MAINTAINER**

`CONTEXT.md` defines **verdict**, **agent failure cause**, **kill class** and
**failure class**. It defines neither "disposition" nor "envelope", although
plan §3d and the source intent use both. Worse, rumo-app's shipped ledger
already uses **disposition** for a different thing: a ledger entry's routing
outcome, `none | proposal opened | eval-candidate`.

Options: use **verdict** for an agent's structured output and never say
disposition; keep "disposition" for the eval-comparison concept and add a
`CONTEXT.md` entry that distinguishes it from rumo's usage; rename rumo's
field.

PRD 7 must not ship a third meaning. `CONTEXT.md` also needs entries for
whatever survives, plus **envelope**, **scenario pack** and the D23 outcome
words — a new term with no glossary entry is how the next agent invents a
parallel one.

---

## G. Sequencing inside the PRD

### D37 — slice order, given that PRD 6 waits on the schema. **DEFAULT**

Default: **the learning-proposal schema ships first**, as its own slice, and
does not sit behind the runner's plumbing. It is the smallest deliverable, it
is the only thing PRD 6 needs, and it is the only part requiring another
repository's agreement — so it has the longest lead time and the highest
blast radius. Alternative: build the runner first and derive the schema from
what it produces, which is tidier and puts the cross-repo negotiation on the
critical path of the critical path.

---

## H. Contradictions found between item 18 and the repository

Recorded because a tidy document that hides these is worse than an untidy one
that names them. Each needs a maintainer ruling, not a slice's improvisation.

### H1 — "recorded PRD 1 envelopes" cannot exist

Item 18 seeds the pack from "recorded PRD 1 envelopes". Two independent
problems:

1. **No envelope is recorded, ever.** The assembled prompt is never written
   to disk; only the `prompt-assembly` evidence event survives, and it holds
   counts and artifact ids, not content (`src/run-events.ts:97`).
2. **PRD 1 predates envelopes.** PRD 1 (#69) merged 2026-08-28. Envelope
   assembly is PRD 3's deliverable — plan §2 names PRD 3 "Context envelopes
   and prompts v2", and `ARCHITECTURE.md` still describes prompts as
   templates with "PRD 3 replaces raw templates with assembled envelopes" in
   the future tense. PRD 1's run used interpolated templates. There is no
   PRD 1 envelope to record, in any format.

The source intent's constraint "reuse recorded envelope format; do not invent
a parallel fixture format" therefore has no referent. Resolve via D1 and D2.

### H2 — the classifier cases need no model call, and the incidents are mostly not agent behavior

Item 18 seeds from "the #111–#121 reliability-wave incidents" and "classifier
verdict cases". But the failure classifier is **deterministic code**:
`classifyNegotiateFailure` (`src/orchestrator.ts:1809`) pattern-matches the
provider's rejection message against `KILL_SIGNATURES` and returns a
`NegotiateFailureCause`. No model is involved. A classifier case is a unit
test, and putting it in a model-call-capped weekly pack makes it both slower
and rarer than it is today.

Likewise most of #111–#121 are orchestrator defects — a restart destroying
commits (#113), a Windows stop bypassing the abort path (#114), a crash
bypassing cancellation bookkeeping (#121). Plan §1 classifies all six as "the
pipeline records or classifies something that misleads the next actor", which
is control-plane behavior, not agent judgment. #120 is the closest to an
agent-behavior case and it too was fixed as a deterministic classifier rule
(ADR 0041).

So the seed target of 20–50 scenarios may not have 20–50 genuine
agent-behavior sources behind it. Either the seed count or the seed sources
needs revising. D2 owns the answer.

### H3 — "the runner defines the schema" understates a shipped dependency

Plan §3d item 18 says the runner "also defines the versioned
learning-proposal schema item 19 consumes", and §2's PRD 6 row and §6 both
treat it as PRD 7's deliverable. But rumo-app #809 is **closed and shipped**:
the findings ledger exists, its Markdown format is enforced by a test, and
the recurrence-proposal contents are already prescribed in a shipped skill.
PRD 7 is therefore constrained by a live artifact in another repository, and
item 19's own "shape is shared with rumo-app's Close learning pass" is
already the operative fact.

Practical effect: the schema slice cannot be written from the AFK plan alone.
It needs the D25–D29 rulings, agreed in both repos, before a ticket exists.

### H4 — a smaller inconsistency worth one line

`ARCHITECTURE.md`'s Prompts row still says "PRD 3 replaces raw templates with
assembled envelopes" in the future tense, although `src/context-envelope.ts`
shipped and PRD 4 has merged on top of it. Plan §2's PRD 3 row lists "the
`ARCHITECTURE.md` envelope entry" as PRD 3 scope. Not PRD 7's problem to fix,
but PRD 7 will be read alongside that line, and a document that misleads the
next operator is the defect class the v2 plan exists to kill.
