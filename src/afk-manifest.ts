import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProtectedIssue {
  number: number;
  state: "OPEN" | "CLOSED";
}

export interface AfkManifest {
  version: 1;
  selectedSlices: string[];
  migrationPrefixes: string[];
  protectedIssues: ProtectedIssue[];
}

function normalizeSlice(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  return /^\d+$/.test(trimmed) ? trimmed.padStart(2, "0") : trimmed;
}

function normalizeProtectedIssue(
  entry: unknown,
  source: string,
): ProtectedIssue {
  // Version one originally allowed bare source issue numbers. Treat those
  // as OPEN while retaining the explicit state form for closed issues.
  if (typeof entry === "number") {
    if (Number.isInteger(entry) && entry > 0) {
      return { number: entry, state: "OPEN" };
    }
  }

  const value = (entry ?? {}) as { number?: unknown; state?: unknown };
  const number = Number(value.number);
  const state = String(value.state ?? "").toUpperCase();
  if (
    !Number.isInteger(number) ||
    number <= 0 ||
    (state !== "OPEN" && state !== "CLOSED")
  ) {
    throw new Error(
      `${source} protectedIssues entries require a positive number and OPEN/CLOSED state`,
    );
  }
  return { number, state };
}

export function parseAfkManifest(
  value: string | unknown,
  source = "afk.json",
): AfkManifest {
  let manifest: unknown;
  try {
    manifest = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = manifest as Record<string, unknown>;
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }

  if (!Array.isArray(input.selectedSlices)) {
    throw new Error(`${source} selectedSlices must contain unique slice numbers`);
  }
  const selectedSlices = input.selectedSlices.map(normalizeSlice);
  if (
    selectedSlices.length === 0 ||
    selectedSlices.some((slice) => !/^\d+$/.test(slice)) ||
    new Set(selectedSlices).size !== selectedSlices.length
  ) {
    throw new Error(`${source} selectedSlices must contain unique slice numbers`);
  }

  const rawPrefixes = input.migrationPrefixes ?? [];
  if (!Array.isArray(rawPrefixes)) {
    throw new Error(
      `${source} migrationPrefixes must contain unique numeric prefixes`,
    );
  }
  const migrationPrefixes = rawPrefixes.map(String);
  if (
    migrationPrefixes.some((prefix) => !/^\d{3,}$/.test(prefix)) ||
    new Set(migrationPrefixes).size !== migrationPrefixes.length
  ) {
    throw new Error(
      `${source} migrationPrefixes must contain unique numeric prefixes`,
    );
  }

  const rawProtected = input.protectedIssues ?? [];
  if (!Array.isArray(rawProtected)) {
    throw new Error(`${source} protectedIssues must be an array`);
  }
  const protectedIssues = rawProtected.map((entry) =>
    normalizeProtectedIssue(entry, source),
  );
  if (
    new Set(protectedIssues.map((entry) => entry.number)).size !==
    protectedIssues.length
  ) {
    throw new Error(`${source} protectedIssues must contain unique issue numbers`);
  }

  return {
    version: 1,
    selectedSlices,
    migrationPrefixes,
    protectedIssues,
  };
}

/** Load `<prd-dir>/afk.json`; absence is the documented legacy mode. */
export function loadAfkManifest(prdDir: string): AfkManifest | null {
  const path = join(prdDir, "afk.json");
  if (!existsSync(path)) return null;
  return parseAfkManifest(readFileSync(path, "utf-8"), path);
}

export interface TrimManifestResult {
  changed: boolean;
  manifest: AfkManifest;
}

/** Keep only claimed prefixes before the feature branch enters its ship gate. */
export function trimUnclaimedMigrationPrefixes(
  prdDir: string,
  claimedPrefixes: readonly string[],
): TrimManifestResult {
  const path = join(prdDir, "afk.json");
  if (!existsSync(path)) {
    throw new Error(`Cannot trim migration reservations: ${path} is missing`);
  }
  const manifest = parseAfkManifest(readFileSync(path, "utf-8"), path);
  const claimed = new Set(claimedPrefixes);
  const unknown = [...claimed].filter(
    (prefix) => !manifest.migrationPrefixes.includes(prefix),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Persisted migration claims are outside ${path}: ${unknown.join(", ")}`,
    );
  }
  const migrationPrefixes = manifest.migrationPrefixes.filter((prefix) =>
    claimed.has(prefix),
  );
  if (migrationPrefixes.length === manifest.migrationPrefixes.length) {
    return { changed: false, manifest };
  }

  const next = { ...manifest, migrationPrefixes };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { changed: true, manifest: next };
}
