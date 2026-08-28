import {
  acceptanceManifestPaths,
  normalizeAcceptanceManifestPath,
  type AcceptanceManifest,
} from "./acceptance-manifest.js";
import { migrationPathsIn, type LaneResourceOptions } from "./lanes.js";

export const ESCALATION_FILENAME = "escalation.md";

export interface ScopeEscalation {
  version: 1;
  findingIds: string[];
  paths: string[];
  reason: string;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  source: string,
): void {
  const keys = Object.keys(value);
  const expectedSet = new Set(expected);
  if (
    keys.some((key) => !expectedSet.has(key)) ||
    expected.some((key) => !(key in value))
  ) {
    throw new Error(
      `${source} root object must contain exactly ${expected.join(", ")}`,
    );
  }
}

function parseNonBlankStrings(
  value: unknown,
  field: "findingIds" | "paths",
  source: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} ${field} must be a non-empty array`);
  }
  if (
    value.some(
      (item) => typeof item !== "string" || item.trim() === "",
    )
  ) {
    throw new Error(
      `${source} ${field} must contain only non-blank strings`,
    );
  }
  return (value as string[]).map((item) => item.trim());
}

function displayPath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

export function parseScopeEscalation(
  value: string | unknown,
  manifest: AcceptanceManifest,
  options?: LaneResourceOptions,
  source = ESCALATION_FILENAME,
): ScopeEscalation {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = parsed as Record<string, unknown>;
  requireExactKeys(
    input,
    ["version", "findingIds", "paths", "reason"],
    source,
  );
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }

  const findingIds = parseNonBlankStrings(
    input.findingIds,
    "findingIds",
    source,
  );
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error(`${source} findingIds must be unique`);
  }

  const rawPaths = parseNonBlankStrings(input.paths, "paths", source);
  const normalizedPaths = rawPaths.map((path) =>
    normalizeAcceptanceManifestPath(path, source),
  );
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error(`${source} normalized paths must be unique`);
  }

  const declared = new Set(acceptanceManifestPaths(manifest));
  const alreadyDeclared = rawPaths.filter((_path, index) =>
    declared.has(normalizedPaths[index]!),
  );
  if (alreadyDeclared.length > 0) {
    throw new Error(
      `${source} paths already on the locked file scope: ${alreadyDeclared.join(", ")}`,
    );
  }

  const migrations = migrationPathsIn(normalizedPaths, options);
  if (migrations.length > 0) {
    throw new Error(
      `${source} paths include migration files (${migrations.join(", ")}); ` +
        "migration prefixes are allocated at contract lock (ADR 0028/0034)",
    );
  }

  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new Error(`${source} reason must be a non-blank string`);
  }

  return {
    version: 1,
    findingIds,
    paths: rawPaths.map(displayPath),
    reason: input.reason.trim(),
  };
}
