export interface AcceptanceManifest {
  version: 1;
  fileScope:
    | { kind: "paths"; paths: string[] }
    | { kind: "no-repository-changes" };
  migrationCount: number;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  source: string,
): void {
  const expectedKeys = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${source} ${field} must contain exactly ${expected.join(", ")}`,
    );
  }
}

function normalizePath(raw: unknown, source: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${source} fileScope paths must contain only strings`);
  }

  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.toLowerCase();

  if (path === "") {
    throw new Error(`${source} fileScope paths must be non-empty file paths`);
  }
  if (/<[^>]*>/.test(path)) {
    throw new Error(`${source} fileScope path "${raw}" contains a placeholder`);
  }
  if (/[*?[]/.test(path)) {
    throw new Error(`${source} fileScope path "${raw}" contains glob syntax`);
  }
  if (
    path.startsWith("/") ||
    /^[a-z]:\//i.test(path) ||
    path.startsWith("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `${source} fileScope path "${raw}" must be an exact repo-relative path`,
    );
  }
  if (path.endsWith("/")) {
    throw new Error(`${source} fileScope path "${raw}" must name a file path`);
  }
  return path;
}

export function parseAcceptanceManifest(
  value: string | unknown,
  source = ACCEPTANCE_MANIFEST_FILENAME,
): AcceptanceManifest {
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
  requireExactKeys(
    input,
    ["version", "fileScope", "migrationCount"],
    "root object",
    source,
  );
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }
  if (
    !Number.isSafeInteger(input.migrationCount) ||
    (input.migrationCount as number) < 0
  ) {
    throw new Error(
      `${source} migrationCount must be a non-negative safe integer`,
    );
  }
  const migrationCount = input.migrationCount as number;

  if (
    !input.fileScope ||
    typeof input.fileScope !== "object" ||
    Array.isArray(input.fileScope)
  ) {
    throw new Error(`${source} fileScope must be an object`);
  }
  const fileScope = input.fileScope as Record<string, unknown>;
  if (fileScope.kind === "no-repository-changes") {
    requireExactKeys(fileScope, ["kind"], "fileScope", source);
    if (migrationCount !== 0) {
      throw new Error(
        `${source} no-repository-changes requires migrationCount 0`,
      );
    }
    return {
      version: 1,
      fileScope: { kind: "no-repository-changes" },
      migrationCount,
    };
  }

  if (fileScope.kind !== "paths") {
    throw new Error(
      `${source} fileScope kind must be "paths" or "no-repository-changes"`,
    );
  }
  requireExactKeys(fileScope, ["kind", "paths"], "fileScope", source);
  if (!Array.isArray(fileScope.paths) || fileScope.paths.length === 0) {
    throw new Error(
      `${source} paths fileScope requires a non-empty paths array`,
    );
  }
  const paths = fileScope.paths.map((path) => normalizePath(path, source));
  if (new Set(paths).size !== paths.length) {
    throw new Error(`${source} normalized fileScope paths must be unique`);
  }

  return {
    version: 1,
    fileScope: { kind: "paths", paths },
    migrationCount,
  };
}

export function loadAcceptanceManifest(sliceDir: string): AcceptanceManifest {
  const path = join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing`);
  }
  return parseAcceptanceManifest(readFileSync(path, "utf-8"), path);
}

export function acceptanceManifestPaths(
  manifest: AcceptanceManifest,
): string[] {
  return manifest.fileScope.kind === "paths"
    ? [...manifest.fileScope.paths]
    : [];
}
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ACCEPTANCE_MANIFEST_FILENAME = "acceptance-manifest.json";
