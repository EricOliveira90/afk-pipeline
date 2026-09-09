/**
 * The tree-identity gate cache (#86 D17): a green gate result on an identical
 * tree with an unchanged definition is reused instead of paid for again.
 *
 * The key is the whole of what the run decided — gate id, the *resolved*
 * command and args, and the tree id — so nothing about a cached answer is
 * inferred. A gate whose command changed is a different gate as far as this
 * file is concerned, even under the same id, and a tree that changed by one
 * byte has a different tree id.
 *
 * Three deliberate narrowings:
 *
 * - **Only `PASS` is cached.** A FAIL is a fact about a tree that the next
 *   round exists to change, and an INFRASTRUCTURE result is a fact about the
 *   machine, not the tree; replaying either would turn a transient into a
 *   verdict.
 * - **Nothing here throws.** A missing, unreadable, malformed or
 *   wrong-version document is a *miss* — the gate then runs, which is the safe
 *   direction. A cache that can fail a run is worse than no cache (B-04).
 * - **No eviction beyond per-key overwrite, and no cross-run sharing.** The
 *   document lives under the run's own artifact directory, so a run's reuse
 *   window is its own attempts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** This document's own schema version, independent of gate evidence's. */
export const GATE_CACHE_VERSION = 1;

/** Where the cache lives and whether the policy allows it (`cost.cacheEnabled`). */
export interface GateCacheOptions {
  path: string;
  enabled: boolean;
}

/** Everything a reused answer must be about (D17). */
export interface GateCacheKey {
  gateId: string;
  command: string;
  args: readonly string[];
  treeId: string;
}

export interface GateCacheEntry {
  gateId: string;
  command: string;
  args: readonly string[];
  treeId: string;
  /** Only ever `"PASS"`; spelled as a field so a reader can refuse the rest. */
  status: "PASS";
  durationMs: number;
  exitCode: number | null;
  recordedAt: string;
  detail?: string;
}

interface GateCacheDocument {
  version: number;
  entries: Record<string, GateCacheEntry>;
}

/**
 * The stable string form of a key. Args are JSON-encoded rather than joined, so
 * `["a b"]` and `["a", "b"]` cannot collide into one key.
 */
export function gateCacheKeyOf(key: GateCacheKey): string {
  return JSON.stringify([key.gateId, key.command, [...key.args], key.treeId]);
}

function isEntry(value: unknown, expected: string): value is GateCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.gateId !== "string" ||
    typeof entry.command !== "string" ||
    !Array.isArray(entry.args) ||
    !entry.args.every((arg) => typeof arg === "string") ||
    typeof entry.treeId !== "string" ||
    entry.status !== "PASS" ||
    typeof entry.durationMs !== "number" ||
    !Number.isFinite(entry.durationMs) ||
    entry.durationMs < 0 ||
    (entry.exitCode !== null && typeof entry.exitCode !== "number") ||
    typeof entry.recordedAt !== "string" ||
    (entry.detail !== undefined && typeof entry.detail !== "string")
  ) {
    return false;
  }
  // The record's own fields must still describe the key it is filed under: a
  // hand-edited document that moved an entry must not answer for another gate.
  return (
    gateCacheKeyOf({
      gateId: entry.gateId,
      command: entry.command,
      args: entry.args as string[],
      treeId: entry.treeId,
    }) === expected
  );
}

function readDocument(path: string): GateCacheDocument | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const document = parsed as Record<string, unknown>;
    if (document.version !== GATE_CACHE_VERSION) return null;
    const entries = document.entries;
    if (typeof entries !== "object" || entries === null) return null;
    return {
      version: GATE_CACHE_VERSION,
      entries: entries as Record<string, GateCacheEntry>,
    };
  } catch {
    // Malformed bytes are a miss, never a throw (B-04).
    return null;
  }
}

/**
 * The cached `PASS` for this exact key, or `null` for every kind of miss: the
 * cache is disabled, the file is absent or malformed, the key was never
 * recorded, or the recorded entry does not describe this key.
 */
export function readGateCacheEntry(
  options: GateCacheOptions | undefined,
  key: GateCacheKey,
): GateCacheEntry | null {
  if (!options?.enabled) return null;
  const document = readDocument(options.path);
  if (!document) return null;
  const id = gateCacheKeyOf(key);
  const entry = document.entries[id];
  return isEntry(entry, id) ? entry : null;
}

/**
 * Record one `PASS`. Best effort: a directory that cannot be created or a file
 * that cannot be written leaves the cache cold rather than failing the gate,
 * for the same reason a malformed read is a miss.
 */
export function writeGateCacheEntry(
  options: GateCacheOptions | undefined,
  entry: GateCacheEntry,
): void {
  if (!options?.enabled) return;
  if (entry.status !== "PASS") return;
  try {
    const document = readDocument(options.path) ?? {
      version: GATE_CACHE_VERSION,
      entries: {},
    };
    document.entries[gateCacheKeyOf(entry)] = entry;
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(
      options.path,
      JSON.stringify(document, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    // Nothing to report: the next run pays the gate, which is correct.
  }
}
