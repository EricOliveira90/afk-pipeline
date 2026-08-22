import type { Slice } from "./issues-parser.js";

/**
 * A lane is a serial chain of slices that share at least one declared
 * file, or that contend for the same lane-shared *resource* (transitive
 * closure over both). Lanes run in parallel; within a lane each slice
 * runs to completion and merges into the feature branch before the next
 * lane-mate starts. See `docs/adr/0005-file-overlap-lanes.md` and
 * `docs/adr/0027-migrations-as-lane-resource-key.md`.
 */
export type Lane = Slice[];

/**
 * Normalise a path for overlap comparison. Two slices share a file when
 * their normalised paths are equal.
 *
 * - Backslashes → forward slashes (worktrees on Windows mix both).
 * - Strip leading `./`.
 * - Lowercase (Windows + git-on-Windows are case-insensitive, and
 *   `src/Cli.py` vs `src/cli.py` should fold to the same file).
 *
 * Limitation: exact path equality only — no directory-prefix overlap,
 * no glob expansion. Two slices that both touch *anything* under
 * `src/auth/` but no specific shared file will look disjoint.
 */
function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Recognises a declared path as a database migration: a `migrations`
 * path segment plus a `.sql` extension. Matched against *normalised*
 * paths (forward slashes, no leading `./`, lowercased), so it needs no
 * case or separator alternatives.
 *
 * Deliberately layout-agnostic — `migrations/001.sql`,
 * `supabase/migrations/001.sql`, and `packages/db/migrations/2024/001.sql`
 * all match. Override it via {@link LaneResourceOptions} for a project
 * whose schema changes live elsewhere.
 */
export const DEFAULT_MIGRATION_PATH_PATTERN = /(^|\/)migrations\/.*\.sql$/;

/** Resource key every recognised migration path unions under. */
const MIGRATION_RESOURCE_KEY = "migrations";

export interface LaneResourceOptions {
  /**
   * Replaces {@link DEFAULT_MIGRATION_PATH_PATTERN}. A supplied pattern
   * *replaces* the default rather than adding to it, so a project that
   * overrides this opts out of the `.sql` default entirely. Matched
   * case-insensitively against normalised paths; `g` and `y` flags are
   * ignored (see {@link matcherFor}).
   */
  migrationPathPattern?: RegExp;
}

/**
 * Adapt a caller's pattern for repeated matching against normalised
 * paths:
 *
 * - Drop `g` and `y`. `RegExp.prototype.test` on a stateful pattern
 *   advances `lastIndex`, so reusing one regex across many paths would
 *   match only every other one.
 * - Add `i`. Paths are lowercased before matching, so a pattern written
 *   as `/Migrations\//` would otherwise never match anything — a
 *   silent no-op rather than a visible error.
 */
function matcherFor(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, "");
  const wanted = flags.includes("i") ? flags : `${flags}i`;
  return wanted === pattern.flags ? pattern : new RegExp(pattern.source, wanted);
}

/**
 * The subset of `files` the configured pattern recognises as database
 * migrations, normalised (forward slashes, no leading `./`, lowercased).
 *
 * One definition of "this is a migration path" for both consumers: lane
 * grouping only needs to know whether a slice declares any (see
 * {@link laneResourceGroups}), while the contract-lock prefix gate needs
 * the paths themselves so it can compare their numeric prefixes against
 * the feature-branch tip (ADR 0028). A second recognition rule would be
 * free to drift from this one.
 */
export function migrationPathsIn(
  files: readonly string[],
  options?: LaneResourceOptions,
): string[] {
  const pattern = matcherFor(
    options?.migrationPathPattern ?? DEFAULT_MIGRATION_PATH_PATTERN,
  );
  return files
    .map((raw) => normalisePath(raw))
    .filter((key) => key !== "" && pattern.test(key));
}

/**
 * Ascending slice-number order. `parseInt` with base 10 lets "10"
 * follow "09" correctly (string compare wouldn't).
 */
const bySliceNumber = (a: Slice, b: Slice) =>
  parseInt(a.number, 10) - parseInt(b.number, 10);

/**
 * Slices that *contend* for a shared resource rather than a shared
 * file, keyed by resource and listed in ascending slice-number order.
 *
 * Only resources with two or more declarers are reported: a lone
 * declarer contends with nobody, so there is nothing to serialise and
 * nothing to tell the operator about.
 *
 * Today the only resource is `migrations`. Two slices that each add
 * their own migration file overlap on no path, yet they contend for the
 * same thing: the next free numeric prefix. Each computes it from an
 * identical feature-branch tip, so they always agree and always
 * collide — hours later, at the merge mutex. See ADR 0027.
 *
 * Slices whose `files === undefined` are skipped: they already union
 * with every sibling under the conservative undeclared rule, so there
 * is nothing to add, and claiming they "declare a migration" would
 * overstate what the pipeline knows.
 */
export function laneResourceGroups(
  slices: Slice[],
  options?: LaneResourceOptions,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const slice of [...slices].sort(bySliceNumber)) {
    if (slice.files === undefined) continue;
    if (migrationPathsIn(slice.files, options).length === 0) continue;
    const members = groups.get(MIGRATION_RESOURCE_KEY);
    if (members) members.push(slice.ghIssue);
    else groups.set(MIGRATION_RESOURCE_KEY, [slice.ghIssue]);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) groups.delete(key);
  }
  return groups;
}

/**
 * Group slices into lanes via union-find on the shared-file graph.
 *
 * Algorithm:
 * 1. Each slice starts in its own component.
 * 2. For every declared path, the *first* slice that mentions it
 *    becomes the path's anchor; later slices declaring the same
 *    path union with the anchor.
 * 3. For every *resource key* (see {@link laneResourceGroups}), all
 *    slices declaring that resource union together even when they
 *    share no path — a migration is contended for as a whole, not
 *    file by file. See ADR 0027.
 * 4. Slices whose `files === undefined` (planner did not declare a
 *    usable list) union with **every other slice** in the wave —
 *    conservative fallback per ADR 0005.
 * 5. Group slices by component root, sort each lane by ascending
 *    `parseInt(slice.number, 10)` (deterministic execution order
 *    within a lane), and sort lanes by their lowest slice number
 *    (deterministic dispatch order across lanes).
 *
 * Slices with `files === []` (planner explicitly declared "no files
 * change") never union via files — they end up in singleton lanes
 * unless they were also pulled in by an undeclared slice.
 */
export function partitionLanes(
  slices: Slice[],
  options?: LaneResourceOptions,
): Lane[] {
  if (slices.length === 0) return [];
  if (slices.length === 1) return [[slices[0]!]];

  const parent = new Map<string, string>();
  for (const s of slices) parent.set(s.ghIssue, s.ghIssue);

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root)!;
      parent.set(root, parent.get(next)!);
      root = parent.get(root)!;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Step 1: union slices that declare overlapping paths.
  const pathAnchor = new Map<string, string>();
  for (const slice of slices) {
    if (slice.files === undefined) continue;
    for (const raw of slice.files) {
      const key = normalisePath(raw);
      if (!key) continue;
      const anchor = pathAnchor.get(key);
      if (anchor === undefined) {
        pathAnchor.set(key, slice.ghIssue);
      } else {
        union(anchor, slice.ghIssue);
      }
    }
  }

  // Step 2: union slices that contend for the same shared resource.
  // Unlike a shared path, a resource is contended for as a whole: two
  // slices adding their own migration file collide on the next free
  // numeric prefix, which each computes from the same base. One lane
  // makes the successor re-negotiate against a base that already
  // contains its predecessor's merged migration. See ADR 0027.
  for (const members of laneResourceGroups(slices, options).values()) {
    const anchor = members[0]!;
    for (const member of members) union(anchor, member);
  }

  // Step 3: union every undeclared slice with every other slice in the
  // wave. A single undeclared slice collapses the whole wave into one
  // lane — that's the deliberate conservative outcome.
  const undeclared = slices.filter((s) => s.files === undefined);
  if (undeclared.length > 0) {
    const anchor = undeclared[0]!.ghIssue;
    for (const s of slices) {
      if (s.ghIssue !== anchor) union(anchor, s.ghIssue);
    }
  }

  // Step 4: bucket by component root.
  const buckets = new Map<string, Slice[]>();
  for (const s of slices) {
    const root = find(s.ghIssue);
    const list = buckets.get(root);
    if (list) list.push(s);
    else buckets.set(root, [s]);
  }

  // Step 5: sort each lane by slice number ascending.
  const lanes: Lane[] = [];
  for (const lane of buckets.values()) {
    lane.sort(bySliceNumber);
    lanes.push(lane);
  }

  // Sort lanes by their lowest slice number. Determinism is observable
  // — log line ordering, integration test assertions, and resume
  // semantics all rely on it.
  lanes.sort((a, b) => bySliceNumber(a[0]!, b[0]!));

  return lanes;
}
