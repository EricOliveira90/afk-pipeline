import { describe, it, expect } from "vitest";
import type { Slice } from "./issues-parser.js";
import {
  DEFAULT_MIGRATION_PATH_PATTERN,
  laneResourceGroups,
  partitionLanes,
} from "./lanes.js";

/**
 * Tests for the lane partitioner. A lane is a serial chain of slices
 * that share at least one declared file (transitive closure). Lanes
 * run in parallel; within a lane, slices execute serially.
 */

function slice(
  number: string,
  files?: string[] | undefined,
  blockedBy: string[] = [],
): Slice {
  return {
    number,
    ghIssue: number, // tests treat the slice number as the issue id
    title: `Slice ${number}`,
    type: "AFK",
    blockedBy,
    userStories: "",
    files,
  };
}

describe("partitionLanes", () => {
  it("returns no lanes when given no slices", () => {
    expect(partitionLanes([])).toEqual([]);
  });

  it("wraps a single slice in a lane of size 1", () => {
    const s = slice("01", ["src/cli.py"]);
    expect(partitionLanes([s])).toEqual([[s]]);
  });

  it("splits two slices with disjoint files into two lanes", () => {
    const a = slice("01", ["src/foo.ts"]);
    const b = slice("02", ["src/bar.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toEqual([a]);
    expect(lanes[1]).toEqual([b]);
  });

  it("merges two slices that share a file into one lane", () => {
    const a = slice("01", ["src/cli.py", "src/foo.ts"]);
    const b = slice("02", ["src/cli.py", "src/bar.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("forms a transitive lane: A↔B (file X), B↔C (file Y) → all three", () => {
    const a = slice("01", ["src/x.ts"]);
    const b = slice("02", ["src/x.ts", "src/y.ts"]);
    const c = slice("03", ["src/y.ts"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("collapses the whole wave into one lane when any slice is undeclared", () => {
    // The conservative undeclared rule from ADR 0005: a slice with
    // `files === undefined` could touch anything, so it must serialise
    // with every sibling in the wave.
    const a = slice("01", ["src/foo.ts"]);
    const b = slice("02", undefined);
    const c = slice("03", ["src/bar.ts"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("treats `src/Cli.py` and `src/cli.py` as the same file (case-insensitive)", () => {
    const a = slice("01", ["src/Cli.py"]);
    const b = slice("02", ["src/cli.py"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("normalises `./src/cli.py` and `src/cli.py` and `src\\cli.py`", () => {
    const a = slice("01", ["./src/cli.py"]);
    const b = slice("02", ["src\\cli.py"]);
    const c = slice("03", ["src/cli.py"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("orders slices within a lane by ascending slice number", () => {
    const c = slice("03", ["src/x.ts"]);
    const a = slice("01", ["src/x.ts"]);
    const b = slice("02", ["src/x.ts"]);
    // Insertion order is shuffled to ensure sort, not insertion, drives output.
    const lanes = partitionLanes([c, a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "02", "03"]);
  });

  it("orders lanes deterministically by lowest slice number", () => {
    // Lane A: slices 02, 04. Lane B: slices 01, 03.
    // Insertion order of the input shouldn't change lane order.
    const s2 = slice("02", ["src/a.ts"]);
    const s4 = slice("04", ["src/a.ts"]);
    const s1 = slice("01", ["src/b.ts"]);
    const s3 = slice("03", ["src/b.ts"]);
    const lanes = partitionLanes([s2, s4, s1, s3]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "03"]);
    expect(lanes[1]!.map((s) => s.number)).toEqual(["02", "04"]);
  });

  it("treats two-digit slice numbers as numeric, not lexicographic", () => {
    // Lexicographic sort would put "10" before "9" — break that.
    const s9 = slice("9", ["src/x.ts"]);
    const s10 = slice("10", ["src/x.ts"]);
    const lanes = partitionLanes([s10, s9]);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["9", "10"]);
  });

  it("places empty-files slices (`[]`) in their own singleton lanes", () => {
    // An empty list means the planner explicitly declared "no files
    // change". That's not the same as undefined and shouldn't collapse
    // the wave; the slice runs alone.
    const a = slice("01", []);
    const b = slice("02", ["src/x.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(2);
  });
});

/**
 * Resource keys (ADR 0027). Two slices that each declare *their own*
 * migration file share no path, so exact-path unioning left them in
 * separate lanes — where they generated concurrently from an identical
 * base and computed the same "next free prefix". A declared path
 * recognised as a migration now unions into one shared component.
 */
describe("partitionLanes — migration resource key", () => {
  it("puts two slices declaring different migration files in one lane", () => {
    const a = slice("01", ["supabase/migrations/20240101000000_a.sql"]);
    const b = slice("02", ["supabase/migrations/20240202000000_b.sql"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("recognises a `migrations` segment anywhere, not one project's layout", () => {
    // Three unrelated layouts: top-level, nested under a package, and
    // nested below the `migrations` segment itself.
    const a = slice("01", ["migrations/001_init.sql"]);
    const b = slice("02", ["packages/db/migrations/002_users.sql"]);
    const c = slice("03", ["db/migrations/2024/003_orders.sql"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "02", "03"]);
  });

  it("leaves slices declaring no migration paths in their own lanes", () => {
    const a = slice("01", ["supabase/migrations/001_a.sql"]);
    const b = slice("02", ["src/foo.ts"]);
    const c = slice("03", ["src/bar.ts"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(3);
    expect(lanes.map((l) => l.map((s) => s.number))).toEqual([
      ["01"],
      ["02"],
      ["03"],
    ]);
  });

  it("keeps a migration slice unioned with a slice it shares an unrelated file with", () => {
    // 01 and 02 share `src/db.ts`; 03 declares only a migration. All
    // three land in one lane: the file overlap pulls 02 in, the
    // resource key pulls 03 in.
    const a = slice("01", ["supabase/migrations/001_a.sql", "src/db.ts"]);
    const b = slice("02", ["src/db.ts"]);
    const c = slice("03", ["db/migrations/002_b.sql"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "02", "03"]);
  });

  it("does not union on a non-`.sql` file inside a migrations directory", () => {
    const a = slice("01", ["supabase/migrations/README.md"]);
    const b = slice("02", ["db/migrations/notes.txt"]);
    expect(partitionLanes([a, b])).toHaveLength(2);
  });

  it("does not union on a `.sql` file outside a `migrations` segment", () => {
    const a = slice("01", ["src/queries/report.sql"]);
    const b = slice("02", ["db/seed.sql"]);
    expect(partitionLanes([a, b])).toHaveLength(2);
  });

  it("does not union on a path whose segment merely starts with `migrations`", () => {
    const a = slice("01", ["db/migrations-archive/001_a.sql"]);
    const b = slice("02", ["db/migrations_old/002_b.sql"]);
    expect(partitionLanes([a, b])).toHaveLength(2);
  });

  it("normalises before matching: backslashes, `./`, and case", () => {
    const a = slice("01", [".\\Supabase\\Migrations\\001_A.SQL"]);
    const b = slice("02", ["db/migrations/002_b.sql"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("orders the shared-resource lane by ascending slice number", () => {
    const c = slice("10", ["migrations/c.sql"]);
    const a = slice("02", ["migrations/a.sql"]);
    const b = slice("09", ["migrations/b.sql"]);
    const lanes = partitionLanes([c, a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["02", "09", "10"]);
  });

  it("honours a caller-supplied pattern instead of the default", () => {
    // A project whose schema changes live in Liquibase changesets.
    const pattern = /(^|\/)changesets\/.*\.xml$/;
    const a = slice("01", ["db/changesets/001_a.xml"]);
    const b = slice("02", ["db/changesets/002_b.xml"]);
    const c = slice("03", ["supabase/migrations/003_c.sql"]);
    const d = slice("04", ["supabase/migrations/004_d.sql"]);
    const lanes = partitionLanes([a, b, c, d], {
      migrationPathPattern: pattern,
    });
    // The changesets union; the `.sql` migrations no longer do, because
    // the supplied pattern replaces the default rather than adding to it.
    expect(lanes.map((l) => l.map((s) => s.number))).toEqual([
      ["01", "02"],
      ["03"],
      ["04"],
    ]);
  });

  it("is unaffected by a global-flagged pattern's statefulness", () => {
    // `RegExp.test` on a /g pattern advances lastIndex — a naive
    // implementation would match every other path.
    const a = slice("01", ["migrations/a.sql"]);
    const b = slice("02", ["migrations/b.sql"]);
    const c = slice("03", ["migrations/c.sql"]);
    const lanes = partitionLanes([a, b, c], {
      migrationPathPattern: /(^|\/)migrations\/.*\.sql$/g,
    });
    expect(lanes).toHaveLength(1);
  });

  it("still collapses the wave when a slice is undeclared", () => {
    const a = slice("01", ["migrations/a.sql"]);
    const b = slice("02", undefined);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
  });
});

/**
 * The groups also feed the wave's lane-composition log line and its
 * `lanes-partitioned` event, so their shape is observable.
 */
describe("laneResourceGroups", () => {
  it("reports the contending slices in slice-number order", () => {
    const c = slice("03", ["migrations/c.sql"]);
    const a = slice("01", ["migrations/a.sql", "src/x.ts"]);
    const b = slice("02", ["src/y.ts"]);
    expect(laneResourceGroups([c, a, b])).toEqual(
      new Map([["migrations", ["01", "03"]]]),
    );
  });

  it("reports nothing when only one slice declares a migration", () => {
    // A lone declarer contends with nobody: no serialisation happened,
    // so there is no grouping to report.
    const a = slice("01", ["migrations/a.sql"]);
    const b = slice("02", ["src/y.ts"]);
    expect(laneResourceGroups([a, b])).toEqual(new Map());
  });

  it("reports nothing when no slice declares a migration", () => {
    expect(laneResourceGroups([slice("01", ["src/x.ts"])])).toEqual(new Map());
  });

  it("matches a pattern written with uppercase, since paths are lowercased", () => {
    const a = slice("01", ["db/Migrations/001_a.SQL"]);
    const b = slice("02", ["db/Migrations/002_b.SQL"]);
    expect(
      laneResourceGroups([a, b], {
        migrationPathPattern: /(^|\/)Migrations\/.*\.SQL$/,
      }),
    ).toEqual(new Map([["migrations", ["01", "02"]]]));
  });

  it("exposes the default pattern so callers can document it", () => {
    expect(DEFAULT_MIGRATION_PATH_PATTERN.test("db/migrations/001_a.sql")).toBe(
      true,
    );
    expect(DEFAULT_MIGRATION_PATH_PATTERN.test("db/seed.sql")).toBe(false);
  });
});
