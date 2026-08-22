# Migrations are a lane-shared resource, not a shared file

Lanes (ADR 0005) union slices on exact declared-path equality. That
catches two slices editing the same file and misses two slices that
contend for the same *resource*. Migration files are the case where the
miss is guaranteed rather than unlucky.

## Failure mode

In the PRD 076 session two slices in the same wave each declared their
own migration file. They shared no path, so they landed in separate
lanes and generated concurrently. Each computed "next free numeric
prefix" from an identical feature-branch tip, so both picked the same
prefix — not sometimes, always. The collision surfaced hours later at
the merge mutex, where the second slice was recorded `CONFLICT` and
discarded after it had already passed QA and committed seven commits.

Nothing was wrong with the work. The two slices were racing on a
resource neither declared as a shared file, because a migration
sequence is contended for as a whole: the prefix is the shared thing,
not the filename.

## Decision

Lane partitioning gains a notion of **resource keys** alongside exact
path equality. A declared path recognised as a migration maps to the
single resource key `migrations`, and every slice mapping to that key
unions into one component — an additional union step in the same
union-find, before the conservative undeclared rule.

Consequences, all of them the point:

- Every migration-bearing slice in a wave lands in **one lane** and
  executes serially.
- Each predecessor's merge is visible to the successor, because a lane
  successor already refreshes onto the current `featBranch` tip and
  re-negotiates (ADR 0005's hybrid Phase A). The successor therefore
  computes its prefix against a base that already contains its
  predecessor's migration.
- The collision stops happening rather than being detected later.

`laneResourceGroups` is the pure function that computes the groups.
`partitionLanes` unions on them; `runWave` also reports them, so the
lane-composition log line and the `lanes-partitioned` event say which
slices were serialised for a shared resource rather than a shared file
(`sharedResources: { migrations: ["101", "102"] }`, present only when
at least two slices contend).

## Configuration, not one project's layout

Recognition is a pattern on `PipelineConfig.migrationPathPattern`,
defaulting to `DEFAULT_MIGRATION_PATH_PATTERN` — a `migrations` path
segment plus a `.sql` extension, matched against the same normalised
path form the partitioner already uses (forward slashes, no leading
`./`, lowercased). So `migrations/001.sql`,
`supabase/migrations/001.sql`, and `packages/db/migrations/2024/001.sql`
all match, and nothing in `src/lanes.ts` knows about Supabase.

A supplied pattern **replaces** the default rather than extending it: a
project whose schema changes are Liquibase changesets wants its own
recognition rule, not its own rule plus a `.sql` rule it does not use.
The pattern's `g` and `y` flags are stripped before use, because
`RegExp.prototype.test` on a stateful pattern advances `lastIndex` and
would match only every other path.

The pattern is programmatic config, not a CLI flag. The pipeline reads
no config file today (the on-hold marker is the only file it reads), and
adding one is out of scope for this change; `--serial-lanes` remains the
operator's blunt override.

## The trade

Migration-bearing slices in a wave lose intra-wave parallelism in
exchange for never racing on prefixes. Accepted, and cheaper than the
alternative in every direction:

- Slices declaring no migration paths are untouched and keep their
  existing parallelism, so the operator does not pay `--serial-lanes`
  for the whole wave to protect one file.
- The serialisation an operator would otherwise reach for is strictly
  broader than the one this produces.
- Two migration slices that also share unrelated files were already in
  one lane; for them nothing changes.

## Considered alternatives

- **Central prefix allocation at wave start** — hand each slice a
  prefix from a reserved range. Needs new configuration surface and
  prompt plumbing, and the lane grouping largely dissolves the need: a
  serialised successor computes the free prefix against a base that
  already has its predecessor's migration. Revisit only if collisions
  persist.
- **Detect the cross-contract collision between siblings at
  contract-lock** — a sibling gate is unnecessary once migration-bearing
  slices share a lane, because the successor re-negotiates after its
  predecessor merges and sees the real tip. The contract-lock check
  against the *feature branch* remains worthwhile in its own right, and
  now exists — see ADR 0028, which is scoped to the feature-branch tip
  alone for exactly this reason.
- **Automatic renumbering of a colliding migration** — rewriting a
  filename and its references is a semantic change to someone's schema
  history, and a strictly larger change than not colliding.
- **Directory-prefix unioning in general** (any two slices touching
  anything under a shared directory) — over-serialises ordinary code
  and does not describe what migrations actually contend for. A named
  resource key says the true thing and leaves the rest of the
  partitioner's semantics alone.

## Extends

Extends ADR 0005: the partitioner unions on resource keys in addition
to shared files. The undeclared-slice rule, the ordering guarantees,
the hybrid Phase A re-negotiate, and the merge mutex are unchanged.
