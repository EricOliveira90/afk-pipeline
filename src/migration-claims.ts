import { dirname, join, posix } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { AfkManifest } from "./afk-manifest.js";
import * as git from "./git.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  acceptanceManifestPaths,
  loadAcceptanceManifest,
} from "./acceptance-manifest.js";
import {
  loadRunState,
  updateRunState,
  assertMigrationClaimShape,
  isSliceComplete,
  type MigrationClaimState,
  type RunState,
} from "./run-state.js";

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
  return updateRunState(args.repoRoot, args.runSlug, (state) => {
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
    return [...allocation];
  });
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
  const manifest = loadAcceptanceManifest(dirname(contractPath));
  return migrationPathsIn(
    acceptanceManifestPaths(manifest),
    options,
  );
}

export function validateContractMigrationClaim(args: {
  contractPath: string;
  claim: readonly string[];
  options?: LaneResourceOptions;
}): string | null {
  const manifest = loadAcceptanceManifest(dirname(args.contractPath));
  const count = manifest.migrationCount;
  if (count !== args.claim.length) {
    return (
      `The acceptance manifest declares ${count} new migration file(s), but slice ` +
      `ownership is ${args.claim.length}. Keep migrationCount at ${args.claim.length}.`
    );
  }

  const paths = contractMigrationPaths(args.contractPath, args.options);
  const prefixes = paths.map(migrationPrefixOf);
  if (paths.length !== count || prefixes.some((prefix) => prefix === null)) {
    return (
      `Declare exactly ${count} new migration path(s) in acceptance-manifest.json, ` +
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

/**
 * The token `migrationReservationBlock` tells a planner with no claim yet
 * to write where a prefix would go (`RESERVED_PREFIX_<name>.sql`), because
 * the prefix is not knowable to it. Anchored: only a basename that *opens*
 * with the token is a placeholder, and the `_` lookahead keeps the
 * descriptive tail intact when the claim replaces it.
 */
const RESERVED_PREFIX_TOKEN = /^RESERVED_PREFIX(?=_)/i;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MigrationPrefixSubstitution {
  /** The declared placeholder path, as the manifest normalised it. */
  from: string;
  /** The same path with its placeholder token replaced by the claim. */
  to: string;
}

/**
 * Substitute a slice's claimed prefixes into the placeholder migration
 * paths of its contract pair, in claim order (#267, ADR 0067).
 *
 * AFK tells the planner to write `RESERVED_PREFIX_<name>.sql` and then
 * allocates the prefix in the same gate call that reads the result, so the
 * first draft of every migration-bearing contract is refused for obeying
 * the instruction it was given. The correction is a string substitution
 * with exactly one right answer, so the gate makes it rather than spending
 * a planner round asking for it — the same shape as ADR 0061's repair
 * pass, minus the dispatch.
 *
 * Returns the substitutions performed, or an empty list when this contract
 * pair is not the mechanical case: then nothing is written and the caller's
 * objection stands. Deliberately narrow, because an objection that is
 * *about* something — a count that disagrees with the claim, or a prefix
 * the planner calculated for itself — is a decision the planner made, and
 * still owes a round.
 */
export function substituteClaimedMigrationPrefixes(args: {
  contractPath: string;
  claim: readonly string[];
  options?: LaneResourceOptions;
}): MigrationPrefixSubstitution[] {
  if (args.claim.length === 0) return [];
  const sliceDir = dirname(args.contractPath);
  const manifest = loadAcceptanceManifest(sliceDir);
  if (manifest.migrationCount !== args.claim.length) return [];

  const declared = migrationPathsIn(
    acceptanceManifestPaths(manifest),
    args.options,
  );
  if (declared.length !== args.claim.length) return [];

  const basenames = declared.map((path) => posix.basename(path));
  if (basenames.some((name) => !RESERVED_PREFIX_TOKEN.test(name))) return [];
  // One placeholder basename contained in another would make the rewrite
  // below order-dependent, and a repeated one would make the claim order
  // ambiguous. Neither is reachable from a valid manifest; both are
  // cheaper to refuse than to reason about.
  if (
    basenames.some((name, index) =>
      basenames.some((other, otherIndex) => {
        return index !== otherIndex && name.includes(other);
      }),
    )
  ) {
    return [];
  }

  const substitutions = declared.map((path, index) => ({
    from: path,
    to:
      posix.dirname(path) === "."
        ? basenames[index]!.replace(RESERVED_PREFIX_TOKEN, args.claim[index]!)
        : `${posix.dirname(path)}/${basenames[index]!.replace(
            RESERVED_PREFIX_TOKEN,
            args.claim[index]!,
          )}`,
  }));
  if (
    substitutions.some(
      (substitution, index) =>
        migrationPrefixOf(substitution.to) !== args.claim[index],
    )
  ) {
    return [];
  }

  /**
   * Replace every mention of each placeholder basename — the machine path
   * in `fileScope`, the contract's human-readable file list, and any prose
   * that names the file — with the claimed one. Matched case-insensitively
   * because the manifest parser lowercases the paths it returns, and the
   * replacement is derived from the *matched* text so the planner's casing
   * of the descriptive tail survives.
   */
  const rewrite = (text: string): string =>
    basenames.reduce(
      (acc, name, index) =>
        acc.replace(new RegExp(escapeRegExp(name), "gi"), (match) =>
          match.replace(RESERVED_PREFIX_TOKEN, args.claim[index]!),
        ),
      text,
    );

  const manifestPath = join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME);
  const manifestText = readFileSync(manifestPath, "utf-8");
  const nextManifest = rewrite(manifestText);
  // The path came out of this file, so it is in this file; a manifest the
  // rewrite does not touch means the assumption is wrong somewhere, and
  // writing nothing leaves the caller's objection to say so.
  if (nextManifest === manifestText) return [];

  const contractText = readFileSync(args.contractPath, "utf-8");
  const nextContract = rewrite(contractText);
  // Contract first, manifest last. The manifest is what the gate re-reads
  // and what the lock attests to, so a crash between the two writes leaves
  // the placeholder in the machine file and the gate objects on the next
  // pass exactly as it does today — the recoverable order.
  if (nextContract !== contractText) {
    writeFileSync(args.contractPath, nextContract, "utf-8");
  }
  writeFileSync(manifestPath, nextManifest, "utf-8");
  return substitutions;
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

export interface MigrationClaimRelease {
  /** Prefixes still claimed by a merged slice, in pool order. */
  retained: string[];
  /** Slice keys whose claim record this call dropped. */
  released: string[];
}

/**
 * Retain the migration claims of merged slices and release every other
 * claim. Ship-gate input: a claim held by a slice that failed,
 * escalated, or was descoped from a narrowed re-run never delivered a
 * migration to the reviewed branch, so its reservation must not survive
 * into the verified draft (#65) — the parent spec's "unused
 * reservations do not remain in the verified draft".
 *
 * This mutates `state.migrations.claims`. The caller must save run state
 * whenever `released` is non-empty, even when the manifest needed no
 * trim, or the drop lives in memory only and the stale claim rides into
 * the next run. `released` exists to make that condition testable.
 */
export function releaseUnmergedMigrationClaims(
  state: RunState,
): MigrationClaimRelease {
  if (!state.migrations) return { retained: [], released: [] };
  validateClaimState(state.migrations);
  const released: string[] = [];
  for (const ghIssue of Object.keys(state.migrations.claims)) {
    if (!isSliceComplete(state, ghIssue)) {
      delete state.migrations.claims[ghIssue];
      released.push(ghIssue);
    }
  }
  const merged = new Set(Object.values(state.migrations.claims).flat());
  return {
    retained: state.migrations.pool.filter((prefix) => merged.has(prefix)),
    released,
  };
}

/**
 * Contract-lock half of the claim flow (ADR 0034 steps 1–3): read the
 * acceptance manifest's migration count, claim that many prefixes from
 * the reserved pool, and validate its paths against the claim.
 * Returns the planner-facing objection, or `null` when the contract
 * satisfies its claim.
 *
 * A claim allocated here is new information: the planner wrote the pair
 * before AFK had a prefix to give it, and was told to leave a placeholder.
 * So a first objection is re-asked once with that placeholder substituted
 * (`substituteClaimedMigrationPrefixes`, #267). `onSubstitution` reports a
 * substitution that happened, because the locked pair then differs from
 * what the planner wrote and the operator must be able to see that in the
 * journal.
 */
export function claimContractMigrations(args: {
  repoRoot: string;
  runSlug: string;
  ghIssue: string;
  contractPath: string;
  expectedPool: readonly string[];
  options?: LaneResourceOptions;
  onSubstitution?: (
    substitutions: readonly MigrationPrefixSubstitution[],
  ) => void;
}): string | null {
  const manifest = loadAcceptanceManifest(dirname(args.contractPath));
  const existingClaim = migrationClaimFor(
    args.repoRoot,
    args.runSlug,
    args.ghIssue,
  );
  if (
    existingClaim &&
    existingClaim.length !== manifest.migrationCount
  ) {
    return validateContractMigrationClaim({
      contractPath: args.contractPath,
      claim: existingClaim,
      options: args.options,
    });
  }

  const claim = claimMigrationPrefixes({
    repoRoot: args.repoRoot,
    runSlug: args.runSlug,
    ghIssue: args.ghIssue,
    count: manifest.migrationCount,
    expectedPool: args.expectedPool,
  });
  const objection = validateContractMigrationClaim({
    contractPath: args.contractPath,
    claim,
    options: args.options,
  });
  if (objection === null) return null;

  const substitutions = substituteClaimedMigrationPrefixes({
    contractPath: args.contractPath,
    claim,
    options: args.options,
  });
  if (substitutions.length === 0) return objection;
  args.onSubstitution?.(substitutions);
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
