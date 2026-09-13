import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimMigrationPrefixes,
  claimContractMigrations,
  initializeMigrationClaims,
  migrationClaimFor,
  releaseUnmergedMigrationClaims,
  validateContractMigrationClaim,
  validateGeneratedMigrations,
} from "./migration-claims.js";
import { loadRunState, saveRunState } from "./run-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateRoot(slug = "run", pool = ["144", "145", "146"]) {
  const root = mkdtempSync(join(tmpdir(), "afk-claims-"));
  roots.push(root);
  const state = loadRunState(root, slug);
  initializeMigrationClaims(state, {
    version: 1,
    selectedSlices: ["01"],
    migrationPrefixes: pool,
    protectedIssues: [],
  });
  saveRunState(root, state);
  return { root, slug, pool };
}

function writeAcceptanceManifest(
  dir: string,
  paths: string[],
  migrationCount: number,
): void {
  writeFileSync(
    join(dir, "acceptance-manifest.json"),
    JSON.stringify({
      version: 1,
      fileScope: { kind: "paths", paths },
      migrationCount,
    }),
  );
}

describe("migration claims", () => {
  it("never overlaps allocations across issue keys — allocation is synchronous by construction", () => {
    // Regression note (#66): a previous version wrapped two claims in
    // Promise.all over Promise.resolve().then(sync fn), which still ran
    // them one after the other on the microtask queue — it exercised no
    // real race. There is none to exercise: claimMigrationPrefixes is a
    // single-process synchronous read-modify-write of run state, so
    // "allocation inside one run is serial by construction" (ADR 0034).
    // Sequential claims from mixed issue keys are the real-world shape;
    // assert the invariant they must uphold — allocations never overlap
    // and drain the pool in order, with re-claims reusing, not
    // re-allocating.
    const setup = stateRoot("run", ["144", "145", "146", "147"]);
    const claim = (ghIssue: string, count: number) =>
      claimMigrationPrefixes({
        repoRoot: setup.root, runSlug: setup.slug, ghIssue, count,
        expectedPool: setup.pool,
      });

    const allocations = [
      claim("1001", 1),
      claim("1002", 2),
      claim("1001", 1), // re-claim between fresh claims must not re-allocate
      claim("1003", 1),
    ];

    expect(allocations).toEqual([["144"], ["145", "146"], ["144"], ["147"]]);
    const distinct = new Set(allocations.flat());
    expect(distinct.size).toBe(4); // no prefix has two owners
    expect(() => claim("1004", 1)).toThrow(/pool exhausted before generation/);
  });

  it("reuses the same claim on resume", () => {
    const setup = stateRoot();
    const input = {
      repoRoot: setup.root, runSlug: setup.slug, ghIssue: "1001", count: 2,
      expectedPool: setup.pool,
    };
    expect(claimMigrationPrefixes(input)).toEqual(["144", "145"]);
    expect(claimMigrationPrefixes(input)).toEqual(["144", "145"]);
    expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual(["144", "145"]);
  });

  it("fails before generation when the pool is exhausted", () => {
    const setup = stateRoot("run", ["144"]);
    expect(() => claimMigrationPrefixes({
      repoRoot: setup.root, runSlug: setup.slug, ghIssue: "1001", count: 2,
      expectedPool: setup.pool,
    })).toThrow(/pool exhausted before generation/);
  });

  it("releases claims of slices that never merged, keeping merged claims (#65)", () => {
    const setup = stateRoot();
    const claim = (ghIssue: string) =>
      claimMigrationPrefixes({
        repoRoot: setup.root, runSlug: setup.slug, ghIssue, count: 1,
        expectedPool: setup.pool,
      });
    expect(claim("1001")).toEqual(["144"]);
    expect(claim("1002")).toEqual(["145"]);

    const state = loadRunState(setup.root, setup.slug);
    state.slices["1001"] = { phase: "PASS", mergedToFeature: true };
    state.slices["1002"] = { phase: "ESCALATE", error: "contract rounds exhausted" };

    // The escalated slice's reservation is unused: it never delivered a
    // migration to the feature branch, so the ship-gate trim must not
    // carry it into the verified draft.
    expect(releaseUnmergedMigrationClaims(state)).toEqual({
      retained: ["144"],
      released: ["1002"],
    });
    expect(state.migrations?.claims).toEqual({ "1001": ["144"] });
  });

  it("reports every released slice key, so the caller knows to save (#65)", () => {
    const setup = stateRoot();
    const claim = (ghIssue: string, count: number) =>
      claimMigrationPrefixes({
        repoRoot: setup.root, runSlug: setup.slug, ghIssue, count,
        expectedPool: setup.pool,
      });
    claim("1001", 1);
    claim("1002", 0);

    const state = loadRunState(setup.root, setup.slug);
    state.slices["1001"] = { phase: "PASS", mergedToFeature: true };
    state.slices["1002"] = { phase: "ESCALATE", error: "boom" };

    // Regression: a released slice does not always change the manifest.
    // Slice 1002 claimed no prefix, and a reviewed manifest already
    // trimmed by an earlier run needs no trim either. The caller must
    // save on `released` alone; on the trim alone the drop lives in
    // memory and the stale claim rides into the next run. ADR 0034 step 7.
    expect(releaseUnmergedMigrationClaims(state)).toEqual({
      retained: ["144"],
      released: ["1002"],
    });
    expect(state.migrations?.claims).toEqual({ "1001": ["144"] });
  });

  it("keeps separate PRD pools isolated", () => {
    const first = stateRoot("prd-a", ["144"]);
    const second = stateRoot("prd-b", ["200"]);
    expect(claimMigrationPrefixes({
      repoRoot: first.root, runSlug: first.slug, ghIssue: "1001", count: 1,
      expectedPool: first.pool,
    })).toEqual(["144"]);
    expect(claimMigrationPrefixes({
      repoRoot: second.root, runSlug: second.slug, ghIssue: "2001", count: 1,
      expectedPool: second.pool,
    })).toEqual(["200"]);
  });

  it("claims the migration count and paths declared by the acceptance manifest", () => {
    const setup = stateRoot("manifest-claim", ["144", "145"]);
    const contract = join(setup.root, "contract.md");
    writeFileSync(
      contract,
      [
        "## Files expected to change",
        "- src/prose-only.ts",
        "",
        "## Migration requirements",
        "- New migration files: 0",
        "",
      ].join("\n"),
    );
    writeAcceptanceManifest(
      setup.root,
      [
        "supabase/migrations/144_first.sql",
        "supabase/migrations/145_second.sql",
      ],
      2,
    );

    expect(
      claimContractMigrations({
        repoRoot: setup.root,
        runSlug: setup.slug,
        ghIssue: "1001",
        contractPath: contract,
        expectedPool: setup.pool,
      }),
    ).toBeNull();
    expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual([
      "144",
      "145",
    ]);
  });

  it("returns an objection when a manifest changes a persisted claim count", () => {
    const setup = stateRoot("manifest-count-change", ["144", "145"]);
    const contract = join(setup.root, "contract.md");
    writeFileSync(contract, "# Slice Contract\n");
    writeAcceptanceManifest(
      setup.root,
      ["supabase/migrations/144_first.sql"],
      1,
    );
    const input = {
      repoRoot: setup.root,
      runSlug: setup.slug,
      ghIssue: "1001",
      contractPath: contract,
      expectedPool: setup.pool,
    };
    expect(claimContractMigrations(input)).toBeNull();

    writeAcceptanceManifest(
      setup.root,
      [
        "supabase/migrations/144_first.sql",
        "supabase/migrations/145_second.sql",
      ],
      2,
    );

    expect(claimContractMigrations(input)).toMatch(
      /declares 2 new migration file\(s\), but slice ownership is 1/,
    );
    expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual(["144"]);
  });

  it("rejects an acceptance manifest that substitutes another prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-contract-"));
    roots.push(root);
    const contract = join(root, "contract.md");
    writeFileSync(contract, [
      "## Files expected to change",
      "- supabase/migrations/144_prose.sql",
      "",
      "## Migration requirements",
      "- New migration files: 1",
      "",
    ].join("\n"));
    writeAcceptanceManifest(
      root,
      ["supabase/migrations/999_machine.sql"],
      1,
    );

    expect(validateContractMigrationClaim({ contractPath: contract, claim: ["144"] }))
      .toMatch(/owns migration prefix 144/);
  });

  /**
   * The placeholder round (#267, ADR 0067). `migrationReservationBlock`
   * tells a planner with no claim yet to write `RESERVED_PREFIX_<name>.sql`;
   * the gate that reads the result is the one that allocates the prefix. So
   * the gate substitutes rather than objecting — but only for the
   * mechanical case.
   */
  describe("reserved-prefix substitution at the lock gate", () => {
    function writePair(
      dir: string,
      paths: string[],
      migrationCount = paths.length,
      prose = paths,
    ): string {
      const contract = join(dir, "contract.md");
      writeFileSync(
        contract,
        [
          "## Files expected to change",
          ...prose.map((path) => `- ${path}`),
          "",
          "## Migration requirements",
          `- New migration files: ${migrationCount}`,
          "",
        ].join("\n"),
      );
      writeAcceptanceManifest(dir, paths, migrationCount);
      return contract;
    }

    function readPair(dir: string) {
      return {
        contract: readFileSync(join(dir, "contract.md"), "utf-8"),
        manifest: readFileSync(join(dir, "acceptance-manifest.json"), "utf-8"),
      };
    }

    it("locks a placeholder contract in the round it was accepted in", () => {
      const setup = stateRoot("placeholder-lock", ["144", "145"]);
      const contract = writePair(setup.root, [
        "supabase/migrations/RESERVED_PREFIX_add_teams.sql",
        "supabase/migrations/RESERVED_PREFIX_add_members.sql",
      ]);
      const substitutions: string[] = [];

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
          onSubstitution: (performed) => {
            for (const one of performed) substitutions.push(`${one.from} -> ${one.to}`);
          },
        }),
      ).toBeNull();

      // Claim order maps to declared order, and both files carry it.
      expect(substitutions).toEqual([
        "supabase/migrations/reserved_prefix_add_teams.sql -> supabase/migrations/144_add_teams.sql",
        "supabase/migrations/reserved_prefix_add_members.sql -> supabase/migrations/145_add_members.sql",
      ]);
      const pair = readPair(setup.root);
      expect(pair.manifest).toContain("supabase/migrations/144_add_teams.sql");
      expect(pair.manifest).toContain("supabase/migrations/145_add_members.sql");
      expect(pair.contract).toContain("- supabase/migrations/144_add_teams.sql");
      expect(pair.contract).toContain("- supabase/migrations/145_add_members.sql");
      expect(pair.manifest).not.toMatch(/RESERVED_PREFIX/i);
      expect(pair.contract).not.toMatch(/RESERVED_PREFIX/i);
      expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual([
        "144",
        "145",
      ]);
    });

    it("keeps the planner's casing and rewrites every mention of the file", () => {
      const setup = stateRoot("placeholder-prose", ["144"]);
      const contract = writePair(
        setup.root,
        ["supabase/migrations/RESERVED_PREFIX_addTeams.sql"],
        1,
        [
          "supabase/migrations/RESERVED_PREFIX_addTeams.sql",
          "src/teams.ts",
        ],
      );
      writeFileSync(
        contract,
        readFileSync(contract, "utf-8") +
          "\nThe new table is created by RESERVED_PREFIX_addTeams.sql alone.\n",
      );

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
        }),
      ).toBeNull();

      const pair = readPair(setup.root);
      expect(pair.manifest).toContain("supabase/migrations/144_addTeams.sql");
      expect(pair.contract).toContain(
        "The new table is created by 144_addTeams.sql alone.",
      );
    });

    it("still objects — and writes nothing — when the planner calculated a prefix", () => {
      const setup = stateRoot("calculated-prefix", ["144"]);
      const contract = writePair(setup.root, [
        "supabase/migrations/007_add_teams.sql",
      ]);
      const before = readPair(setup.root);

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
        }),
      ).toMatch(/owns migration prefix 144/);
      expect(readPair(setup.root)).toEqual(before);
    });

    it("still objects when only some declared migrations are placeholders", () => {
      const setup = stateRoot("mixed-placeholders", ["144", "145"]);
      const contract = writePair(setup.root, [
        "supabase/migrations/144_add_teams.sql",
        "supabase/migrations/RESERVED_PREFIX_add_members.sql",
      ]);
      const before = readPair(setup.root);

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
        }),
      ).toMatch(/Declare exactly 2 new migration path\(s\)/);
      expect(readPair(setup.root)).toEqual(before);
    });

    it("still objects on a count that disagrees with the declared paths", () => {
      const setup = stateRoot("placeholder-count", ["144", "145"]);
      // Two placeholder paths, one declared migration: the count is the
      // objection, and a count is a decision the planner made.
      const contract = writePair(
        setup.root,
        [
          "supabase/migrations/RESERVED_PREFIX_add_teams.sql",
          "supabase/migrations/RESERVED_PREFIX_add_members.sql",
        ],
        1,
      );
      const before = readPair(setup.root);

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
        }),
      ).toMatch(/Declare exactly 1 new migration path\(s\)/);
      expect(readPair(setup.root)).toEqual(before);
      // The claim was still allocated, as it always was — only one prefix,
      // because that is what the manifest declared a count for.
      expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual(["144"]);
    });

    it("is idempotent: a second gate call on the substituted pair passes untouched", () => {
      const setup = stateRoot("placeholder-idempotent", ["144"]);
      const contract = writePair(setup.root, [
        "supabase/migrations/RESERVED_PREFIX_add_teams.sql",
      ]);
      const input = {
        repoRoot: setup.root,
        runSlug: setup.slug,
        ghIssue: "1001",
        contractPath: contract,
        expectedPool: setup.pool,
      };

      expect(claimContractMigrations(input)).toBeNull();
      const substituted = readPair(setup.root);
      expect(claimContractMigrations(input)).toBeNull();
      expect(readPair(setup.root)).toEqual(substituted);
    });

    it("leaves a slice that declares no migration alone", () => {
      const setup = stateRoot("placeholder-none", ["144"]);
      const contract = writePair(setup.root, ["src/teams.ts"], 0);

      expect(
        claimContractMigrations({
          repoRoot: setup.root,
          runSlug: setup.slug,
          ghIssue: "1001",
          contractPath: contract,
          expectedPool: setup.pool,
        }),
      ).toBeNull();
      expect(migrationClaimFor(setup.root, setup.slug, "1001")).toEqual([]);
    });
  });

  it("rejects wrong generated migration filenames before QA or merge", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-generated-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    execFileSync("git", ["switch", "-c", "slice"], { cwd: root });
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(root, "supabase", "migrations", "999_wrong.sql"), "-- wrong\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "wrong migration"], { cwd: root });
    const contract = join(root, "contract.md");
    writeFileSync(contract, [
      "## Files expected to change",
      "- supabase/migrations/999_wrong.sql",
      "",
      "## Migration requirements",
      "- New migration files: 1",
      "",
    ].join("\n"));
    writeAcceptanceManifest(
      root,
      ["supabase/migrations/144_right.sql"],
      1,
    );

    expect(validateGeneratedMigrations({
      worktreeDir: root,
      featBranch: "main",
      contractPath: contract,
      claim: ["144"],
    })).toMatchObject({ ok: false, error: expect.stringMatching(/do not match/) });
  });
});
