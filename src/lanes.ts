import type { Slice } from "./issues-parser.js";

/**
 * A lane is a serial chain of slices that share at least one declared
 * file (transitive closure). Lanes run in parallel; within a lane each
 * slice runs to completion and merges into the feature branch before
 * the next lane-mate starts. See `docs/adr/0005-file-overlap-lanes.md`.
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
 * Group slices into lanes via union-find on the shared-file graph.
 *
 * Algorithm:
 * 1. Each slice starts in its own component.
 * 2. For every declared path, the *first* slice that mentions it
 *    becomes the path's anchor; later slices declaring the same
 *    path union with the anchor.
 * 3. Slices whose `files === undefined` (planner did not declare a
 *    usable list) union with **every other slice** in the wave —
 *    conservative fallback per ADR 0005.
 * 4. Group slices by component root, sort each lane by ascending
 *    `parseInt(slice.number, 10)` (deterministic execution order
 *    within a lane), and sort lanes by their lowest slice number
 *    (deterministic dispatch order across lanes).
 *
 * Slices with `files === []` (planner explicitly declared "no files
 * change") never union via files — they end up in singleton lanes
 * unless they were also pulled in by an undeclared slice.
 */
export function partitionLanes(slices: Slice[]): Lane[] {
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

  // Step 2: union every undeclared slice with every other slice in the
  // wave. A single undeclared slice collapses the whole wave into one
  // lane — that's the deliberate conservative outcome.
  const undeclared = slices.filter((s) => s.files === undefined);
  if (undeclared.length > 0) {
    const anchor = undeclared[0]!.ghIssue;
    for (const s of slices) {
      if (s.ghIssue !== anchor) union(anchor, s.ghIssue);
    }
  }

  // Step 3: bucket by component root.
  const buckets = new Map<string, Slice[]>();
  for (const s of slices) {
    const root = find(s.ghIssue);
    const list = buckets.get(root);
    if (list) list.push(s);
    else buckets.set(root, [s]);
  }

  // Step 4: sort each lane by slice number ascending. `parseInt` with
  // base 10 lets "10" follow "09" correctly (string compare wouldn't).
  const lanes: Lane[] = [];
  for (const lane of buckets.values()) {
    lane.sort(
      (a, b) => parseInt(a.number, 10) - parseInt(b.number, 10),
    );
    lanes.push(lane);
  }

  // Sort lanes by their lowest slice number. Determinism is observable
  // — log line ordering, integration test assertions, and resume
  // semantics all rely on it.
  lanes.sort(
    (a, b) =>
      parseInt(a[0]!.number, 10) - parseInt(b[0]!.number, 10),
  );

  return lanes;
}
