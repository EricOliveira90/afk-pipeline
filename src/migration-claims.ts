import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { AfkManifest } from "./afk-manifest.js";
import * as artifacts from "./artifacts.js";
import * as git from "./git.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";
import {
  loadRunState,
  saveRunState,
  assertMigrationClaimShape,
  isSliceComplete,
  type MigrationClaimState,
  type RunState,
} from "./run-state.js";

const MIGRATION_REQUIREMENTS_HEADING = /^##\s+Migration requirements\s*$/im;
const MIGRATION_COUNT = /^\s*[-*]\s+New migration files:\s*(\d+)\s*$/im;

/**
 * Planner-facing objection for a contract that omits the section the
 * claim flow starts from (ADR 0034 step 1). One string, because two
 * gates raise it: contract-lock (`claimContractMigrations`) when there
 * is no count to claim against, and contract validation
 * (`validateContractMigrationClaim`) when re-checking a locked contract.
 */
export const MISSING_MIGRATION_REQUIREMENTS_OBJECTION =
  'Add a "## Migration requirements" section containing exactly ' +
  '"- New migration files: <count>". Use 0 when this slice creates none.';

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
  assertMigrationClaimShape(state);
  const seen = new Map<string, string>();
  for (const [issue, prefixes] of Object.entries(state.claims)) {
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
    return MISSING_MIGRATION_REQUIREMENTS_OBJECTION;
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

/**
 * Retain the migration claims of merged slices and release every other
 * claim, returning the retained prefixes in pool order. Ship-gate
 * input: a claim held by a slice that failed, escalated, or was
 * descoped from a narrowed re-run never delivered a migration to the
 * reviewed branch, so its reservation must not survive into the
 * verified draft (#65) — the parent spec's "unused reservations do not
 * remain in the verified draft". The claim record is dropped alongside
 * the trim so pool and claims stay consistent (`validateClaimState`
 * requires claims inside the pool); a slice retried after the trim
 * fails closed on pool exhaustion and re-enters through a fresh
 * `to-afk` reservation rather than a stale claim.
 */
export function releaseUnmergedMigrationClaims(state: RunState): string[] {
  if (!state.migrations) return [];
  validateClaimState(state.migrations);
  for (const ghIssue of Object.keys(state.migrations.claims)) {
    if (!isSliceComplete(state, ghIssue)) {
      delete state.migrations.claims[ghIssue];
    }
  }
  const merged = new Set(Object.values(state.migrations.claims).flat());
  return state.migrations.pool.filter((prefix) => merged.has(prefix));
}

/**
 * Contract-lock half of the claim flow (ADR 0034 steps 1–3): read the
 * contract's declared migration count, claim that many prefixes from
 * the reserved pool, and validate the contract against the claim.
 * Returns the planner-facing objection, or `null` when the contract
 * satisfies its claim.
 */
export function claimContractMigrations(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
  contractPath: string;
  expectedPool: readonly string[];
  options?: LaneResourceOptions;
}): string | null {
  const count = readContractMigrationCount(args.contractPath);
  if (count === null) return MISSING_MIGRATION_REQUIREMENTS_OBJECTION;
  const claim = claimMigrationPrefixes({
    repoRoot: args.repoRoot,
    runSlug: args.runSlug,
    ghIssue: args.ghIssue,
    count,
    expectedPool: args.expectedPool,
  });
  return validateContractMigrationClaim({
    contractPath: args.contractPath,
    claim,
    options: args.options,
  });
}

/**
 * Post-generation half of the claim flow (ADR 0034 step 4): look up the
 * slice's persisted claim and diff the generated migration files against
 * the contract and the claim. Shared verbatim by the pre-QA gate
 * (orchestrator) and the pre-merge gate (wave); only the error wrapping
 * differs, so `reason` lets each caller keep its own message.
 */
export function checkClaimedGeneratedMigrations(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
  worktreeDir: string;
  featBranch: string;
  contractPath: string;
  options?: LaneResourceOptions;
}):
  | { ok: true }
  | { ok: false; reason: "missing-claim" | "mismatch"; error: string } {
  const claim = migrationClaimFor(args.repoRoot, args.runSlug, args.ghIssue);
  if (!claim) {
    return {
      ok: false,
      reason: "missing-claim",
      error: "no persisted claim record",
    };
  }
  const generated = validateGeneratedMigrations({
    worktreeDir: args.worktreeDir,
    featBranch: args.featBranch,
    contractPath: args.contractPath,
    claim,
    options: args.options,
  });
  return generated.ok
    ? { ok: true }
    : { ok: false, reason: "mismatch", error: generated.error };
}
