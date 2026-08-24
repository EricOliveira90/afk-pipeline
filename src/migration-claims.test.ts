import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimMigrationPrefixes,
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

describe("migration claims", () => {
  it("serializes concurrent slice allocations to unique prefixes", async () => {
    const setup = stateRoot();
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => claimMigrationPrefixes({
        repoRoot: setup.root, runSlug: setup.slug, ghIssue: "1001", count: 1,
        expectedPool: setup.pool,
      })),
      Promise.resolve().then(() => claimMigrationPrefixes({
        repoRoot: setup.root, runSlug: setup.slug, ghIssue: "1002", count: 1,
        expectedPool: setup.pool,
      })),
    ]);

    expect(first).toEqual(["144"]);
    expect(second).toEqual(["145"]);
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
    expect(releaseUnmergedMigrationClaims(state)).toEqual(["144"]);
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

  it("rejects a contract that substitutes another prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-contract-"));
    roots.push(root);
    const contract = join(root, "contract.md");
    writeFileSync(contract, [
      "## Files expected to change",
      "- supabase/migrations/999_wrong.sql",
      "",
      "## Migration requirements",
      "- New migration files: 1",
      "",
    ].join("\n"));

    expect(validateContractMigrationClaim({ contractPath: contract, claim: ["144"] }))
      .toMatch(/owns migration prefix 144/);
  });

  it("rejects wrong generated migration filenames before QA or merge", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-generated-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
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
      "- supabase/migrations/144_right.sql",
      "",
      "## Migration requirements",
      "- New migration files: 1",
      "",
    ].join("\n"));

    expect(validateGeneratedMigrations({
      worktreeDir: root,
      featBranch: "main",
      contractPath: contract,
      claim: ["144"],
    })).toMatchObject({ ok: false, error: expect.stringMatching(/do not match/) });
  });
});
