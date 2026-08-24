# The afk.json manifest and pipeline-owned migration claims

A preparation step outside this repository (`to-afk`, rumo-app#778) now
computes what a run may do before the run starts: which slices are in
scope and which migration prefixes the PRD may consume. The pipeline's
job is to *enforce* that preparation rather than trust agents to respect
it. This ADR records the two coupled decisions: the pipeline's first
config file, and the claim model that makes migration prefixes a
pipeline-allocated resource instead of an agent-calculated one.

## Failure mode

ADR 0027 serialised migration-bearing slices into one lane and ADR 0028
gated contract-lock against the feature-branch tip. Both keep a *single
run* from colliding with itself. Neither helps when two PRDs run
concurrently against the same repository, or when a resumed run
recomputes "next free prefix" against a tip that moved: the number an
agent calculates is correct at the moment of calculation and wrong by
merge time. The root cause is that agents calculate prefixes at all.

## Decision 1: `afk.json` is the pipeline's first config file

`loadAfkManifest` reads `<prd-dir>/afk.json` automatically. Absence is
the documented legacy mode — everything behaves as before. Presence
means:

- `selectedSlices` becomes the default run scope. A CLI `--slices`
  selection may narrow within it; any slice outside the manifest fails
  closed before dispatch (`cli-run-scope.ts`, `runPipeline`).
- `migrationPrefixes` is the **reservation pool**: the only prefixes
  this run may ever assign. It is a pool, not a per-slice assignment.
- `protectedIssues` records source issues whose GitHub state the run
  must not disturb. The pipeline parses and preserves the field;
  enforcement is consumed by the preparation/babysit tooling that owns
  issue state, not by the orchestrator.

The manifest is validated strictly (`version: 1` required, unique
numeric prefixes, unique slice numbers) because it is a cross-repository
contract: `to-afk` writes it, this pipeline and the consuming
repository's preflight both parse it via the exported `./afk-manifest`
entry point. A loose parser here would let the two sides drift apart
silently.

ADR 0027 declined a config file ("the pipeline reads no config file
today") because nothing then needed one. The preparation workflow is
that need.

## Decision 2: the pipeline owns claims; agents receive them

The manifest owns the allowed pool. The pipeline owns claims. Agents
receive exact prefixes. Machine gates enforce them. **Agents never
calculate the next migration prefix** — the sentence deleted from the
generator-resume prompts.

The claim flow (`migration-claims.ts`):

1. The planner's contract declares need via a `## Migration
   requirements` section — `New migration files: <count>`, `0` when
   none.
2. When count > 0, the orchestrator claims the next free prefixes from
   the pool — a synchronous read-modify-write of run state, so
   allocation inside one run is serial by construction.
3. The exact claim is interpolated into a planner correction pass; a
   contract using any other prefix is refused
   (`validateContractMigrationClaim`), spending a contract round like
   any ADR 0028 gate refusal.
4. The generator receives the claim verbatim; generated migration files
   are diffed against the contract and the claim before QA and again
   before merge (`validateGeneratedMigrations`).
5. Claims persist in run state and are reused on retry and resume — a
   slice keeps its original prefixes across rounds and across runs.
6. Pool exhaustion fails **before generation**, when it costs a message
   rather than a discarded slice.
7. Before the ship gate, the orchestrator keeps only the prefixes
   claimed by slices that actually merged
   (`releaseUnmergedMigrationClaims`) — a claim held by a failed,
   escalated, or descoped slice counts as unused — and
   `trimUnclaimedMigrationPrefixes` removes every other reservation
   from `afk.json` **on the reviewed feature branch**, committing the
   trim, so the verified draft does not carry reservations the PRD
   never used. The released slice's claim record is dropped from run
   state, and run state is saved whenever the release drops a record —
   not only when the manifest changed. The two conditions differ: a
   reviewed manifest an earlier run already trimmed needs no second
   trim, and a slice that declared zero migrations holds an empty
   claim record. Gating the save on the trim alone leaves that stale
   claim on file, and the next run hands its prefix out again while
   the trimmed branch already advertises the prefix as free.

   The release reaches a sibling PRD by two paths with different
   timing. The run-state pool frees immediately, so `to-afk`'s
   run-state scan stops counting the prefix as reserved. The
   base-branch manifest frees only when the draft merges:
   `loadAfkManifest` reads the PRD directory on the base branch, which
   the trim never touches. A **new run** after the trim therefore
   restores the untrimmed pool and can re-claim a released prefix
   instead of failing closed. Treat the trim as "do not ship unused
   reservations", not as an in-run release.

Run state gains one optional field (extending ADR 0018's schema):

```ts
migrations?: { pool: string[]; claims: Record<string, string[]> }
```

Claims are keyed by GitHub issue — the same key the DAG and journal use
for a slice — and validated on every load (`validateClaimState`): claims
must sit inside the pool, and no prefix may have two owners. A pool that
disagrees with the current `afk.json` fails loudly rather than guessing
which side is right; removing a *claimed* prefix from the manifest is
always an error.

## What this changes about 0027 and 0028

- ADR 0027's "central prefix allocation at wave start" alternative was
  rejected as needing "new configuration surface and prompt plumbing".
  Both now exist, paid for by the multi-PRD requirement that lane
  serialisation cannot address. The lane grouping itself is unchanged
  and still worth having: it keeps intra-run merges ordered.
- ADR 0028's contract-lock gate and merge-mutex check are unchanged and
  remain the authority for runs *without* a manifest. With a manifest,
  the claim validation runs alongside them and is stricter: it pins the
  exact prefix instead of objecting to a colliding one, and the
  "renumber to the next free prefix" guidance is gone from the resume
  prompts because renumbering is now a violation, not a remedy.

## Considered alternatives

- **Keep agent-side calculation, widen the gates.** Gates catch a wrong
  prefix after an agent produced it; with concurrent PRDs the "right"
  prefix is unknowable from inside one run. Only reservation fixes the
  race.
- **Per-slice prefix assignment in the manifest.** Rejected by the
  parent spec and by shape: `to-afk` cannot know at preparation time
  which slices' contracts will declare migrations, or how many files
  each needs. A pool defers binding to contract time.
- **A lockfile in the consuming repository instead of run state.**
  Claims are a property of one run's lifecycle (retry, resume, trim);
  run state is where per-run lifecycle already lives (ADR 0018).

## Supersedes / extends

- **Amends ADR 0027:** the pipeline now reads a config file; central
  allocation is adopted for manifest runs. Lane resource keys are
  unchanged.
- **Amends ADR 0028:** for manifest runs, the planner is handed an
  exact claim rather than the next free prefix, and generator prompts
  no longer instruct renumbering. The gate and the merge-mutex check
  stand.
- **Extends ADR 0018:** run state carries the optional `migrations`
  claim field.
