import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { AfkManifest } from "./afk-manifest.js";
import * as artifacts from "./artifacts.js";
import * as git from "./git.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";
import {
  loadRunState,
  saveRunState,
  type MigrationClaimState,
  type RunState,
} from "./run-state.js";

const MIGRATION_REQUIREMENTS_HEADING = /^##\s+Migration requirements\s*$/im;
const MIGRATION_COUNT = /^\s*[-*]\s+New migration files:\s*(\d+)\s*$/im;

export function readContractMigrationCount(
  contractPath: string,
): number | null {
  const content = readFileSync(contractPath, "utf-8");
  const heading = MIGRATION_REQUIREMENTS_HEADING.exec(content);
  if (!heading) return null;
  const rest = content.slice(heading.index + heading[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const count = MIGRATION_COUNT.exec(section);
  if (!count) return null;
  const parsed = Number(count[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function migrationPrefixOf(path: string): string | null {
  const match = /^(\d+)_/.exec(posix.basename(path.replace(/\\/g, "/")));
  return match?.[1] ?? null;
}

function validateClaimState(state: MigrationClaimState): void {
  if (
    !Array.isArray(state.pool) ||
    state.pool.some((prefix) => typeof prefix !== "string") ||
    new Set(state.pool).size !== state.pool.length
  ) {
    throw new Error("Run state contains an invalid migration prefix pool");
  }
  if (!state.claims || typeof state.claims !== "object" || Array.isArray(state.claims)) {
    throw new Error("Run state contains invalid migration claims");
  }
  const seen = new Map<string, string>();
  for (const [issue, prefixes] of Object.entries(state.claims)) {
    if (!Array.isArray(prefixes)) {
      throw new Error(`Run state contains invalid migration claims for #${issue}`);
    }
    for (const prefix of prefixes) {
      if (!state.pool.includes(prefix)) {
        throw new Error(
          `Migration claim ${prefix} for #${issue} is outside the persisted pool`,
        );
      }
      const owner = seen.get(prefix);
      if (owner && owner !== issue) {
        throw new Error(
          `Migration prefix ${prefix} is claimed by both #${owner} and #${issue}`,
        );
      }
      seen.set(prefix, issue);
    }
  }
}

export function initializeMigrationClaims(
  state: RunState,
  manifest: AfkManifest | null,
): void {
  if (!manifest) {
    if (state.migrations) {
      throw new Error(
        "afk.json is required because this run state already contains migration claims",
      );
    }
    return;
  }

  const migrations = state.migrations ?? {
    pool: [...manifest.migrationPrefixes],
    claims: {},
  };
  validateClaimState(migrations);
  const manifestPool = new Set(manifest.migrationPrefixes);
  const missingClaims = Object.values(migrations.claims)
    .flat()
    .filter((prefix) => !manifestPool.has(prefix));
  if (missingClaims.length > 0) {
    throw new Error(
      `afk.json removed claimed migration prefixes: ${[...new Set(missingClaims)].join(", ")}`,
    );
  }
  migrations.pool = [...manifest.migrationPrefixes];
  state.migrations = migrations;
}

export function claimMigrationPrefixes(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
  count: number;
  expectedPool: readonly string[];
}): string[] {
  if (!Number.isSafeInteger(args.count) || args.count < 0) {
    throw new Error(`Invalid migration count for #${args.ghIssue}`);
  }
  // Synchronous read-modify-write makes allocation atomic inside one run.
  const state = loadRunState(args.repoRoot, args.runSlug);
  if (!state.migrations) {
    state.migrations = { pool: [...args.expectedPool], claims: {} };
  }
  validateClaimState(state.migrations);
  if (
    state.migrations.pool.length !== args.expectedPool.length ||
    state.migrations.pool.some(
      (prefix, index) => prefix !== args.expectedPool[index],
    )
  ) {
    throw new Error(
      "Persisted migration pool does not match the current afk.json reservation",
    );
  }

  const existing = state.migrations.claims[args.ghIssue];
  if (existing) {
    if (existing.length !== args.count) {
      throw new Error(
        `Slice #${args.ghIssue} already owns ${existing.length} migration prefix(es), ` +
          `but its contract now declares ${args.count}`,
      );
    }
    return [...existing];
  }

  const claimed = new Set(Object.values(state.migrations.claims).flat());
  const free = state.migrations.pool.filter((prefix) => !claimed.has(prefix));
  if (free.length < args.count) {
    throw new Error(
      `Migration prefix pool exhausted before generation for #${args.ghIssue}: ` +
        `needs ${args.count}, only ${free.length} remain`,
    );
  }
  const allocation = free.slice(0, args.count);
  state.migrations.claims[args.ghIssue] = allocation;
  saveRunState(args.repoRoot, state);
  return [...allocation];
}

export function migrationClaimFor(
  repoRoot: string,
  runSlug: string,
  ghIssue: string,
): string[] | undefined {
  const claim = loadRunState(repoRoot, runSlug).migrations?.claims[ghIssue];
  return claim ? [...claim] : undefined;
}

function contractMigrationPaths(
  contractPath: string,
  options?: LaneResourceOptions,
): string[] {
  return migrationPathsIn(
    artifacts.readContractFiles(contractPath) ?? [],
    options,
  );
}

export function validateContractMigrationClaim(args: {
  contractPath: string;
  claim: readonly string[];
  options?: LaneResourceOptions;
}): string | null {
  const count = readContractMigrationCount(args.contractPath);
  if (count === null) {
    return (
      'Add a "## Migration requirements" section containing exactly ' +
      '"- New migration files: <count>". Use 0 when this slice creates none.'
    );
  }
  if (count !== args.claim.length) {
    return (
      `The contract declares ${count} new migration file(s), but slice ownership is ` +
      `${args.claim.length}. Keep the declared count at ${args.claim.length}.`
    );
  }

  const paths = contractMigrationPaths(args.contractPath, args.options);
  const prefixes = paths.map(migrationPrefixOf);
  if (paths.length !== count || prefixes.some((prefix) => prefix === null)) {
    return (
      `List exactly ${count} new migration path(s) under "Files expected to change", ` +
      `using the assigned prefix${args.claim.length === 1 ? "" : "es"} ` +
      `${args.claim.join(", ") || "(none)"}.`
    );
  }
  if (
    prefixes.length !== args.claim.length ||
    prefixes.some((prefix, index) => prefix !== args.claim[index])
  ) {
    return (
      `This slice owns migration prefix${args.claim.length === 1 ? "" : "es"} ` +
      `${args.claim.join(", ")}. Rename the declared new migration file(s) to use ` +
      `those exact prefixes in that order. Never calculate or substitute another prefix.`
    );
  }
  return null;
}

export function validateGeneratedMigrations(args: {
  worktreeDir: string;
  featBranch: string;
  contractPath: string;
  claim: readonly string[];
  options?: LaneResourceOptions;
}): { ok: true } | { ok: false; error: string } {
  const expected = contractMigrationPaths(args.contractPath, args.options);
  const added = migrationPathsIn(
    git.listAddedFiles(args.worktreeDir, args.featBranch, "HEAD"),
    args.options,
  );
  const sortedExpected = [...expected].sort();
  const sortedAdded = [...added].sort();
  const same =
    sortedExpected.length === sortedAdded.length &&
    sortedExpected.every((path, index) => path === sortedAdded[index]);
  if (!same) {
    return {
      ok: false,
      error:
        `Generated migration files do not match the locked contract. ` +
        `Expected [${expected.join(", ")}], found [${added.join(", ")}]`,
    };
  }
  const prefixes = added.map(migrationPrefixOf);
  if (
    prefixes.length !== args.claim.length ||
    prefixes.some((prefix, index) => prefix !== args.claim[index])
  ) {
    return {
      ok: false,
      error:
        `Generated migration prefixes must be exactly [${args.claim.join(", ")}], ` +
        `found [${prefixes.map((prefix) => prefix ?? "(none)").join(", ")}]`,
    };
  }
  return { ok: true };
}

export function allClaimedPrefixes(state: RunState): string[] {
  if (!state.migrations) return [];
  validateClaimState(state.migrations);
  const claimed = new Set(Object.values(state.migrations.claims).flat());
  return state.migrations.pool.filter((prefix) => claimed.has(prefix));
}
