export interface AcceptanceBehavior {
  id: string;
  source: string;
  given: string;
  when: string;
  then: string;
  observableResult: string;
  preservation: boolean;
  gateIds: string[];
}

interface AcceptanceManifestBase {
  fileScope:
    | { kind: "paths"; paths: string[] }
    | { kind: "no-repository-changes" };
  migrationCount: number;
}

export interface AcceptanceManifestV1 extends AcceptanceManifestBase {
  version: 1;
}

export interface AcceptanceManifestV2 extends AcceptanceManifestBase {
  version: 2;
  behaviors: AcceptanceBehavior[];
}

export type AcceptanceManifest = AcceptanceManifestV1 | AcceptanceManifestV2;

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

/**
 * The comparison key for one declared path: trimmed, forward-slashed,
 * `./`-stripped, lowercased — or a throw naming the defect.
 *
 * Exported so that a path proposed for the file scope after the lock (a
 * scope amendment, #112) is held to exactly the rules the planner's
 * manifest was held to, rather than to a second copy of them that can
 * drift.
 */
export function normalizeAcceptanceManifestPath(
  raw: unknown,
  source = ACCEPTANCE_MANIFEST_FILENAME,
): string {
  return normalizePath(raw, source);
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
    /^[a-z]:/i.test(path) ||
    path.startsWith("//") ||
    path.includes("//") ||
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

function requireNonBlankString(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${field} must be a non-blank string`);
  }
  return value;
}

function parseBehaviors(
  value: unknown,
  source: string,
): AcceptanceBehavior[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} behaviors must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${source} behaviors must be a non-empty array`);
  }

  const behaviors = value.map((raw, index) => {
    const field = `behaviors[${index}] behavior`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} ${field} must be an object`);
    }
    const behavior = raw as Record<string, unknown>;
    requireExactKeys(
      behavior,
      [
        "id",
        "source",
        "given",
        "when",
        "then",
        "observableResult",
        "preservation",
        "gateIds",
      ],
      field,
      source,
    );

    if (typeof behavior.preservation !== "boolean") {
      throw new Error(`${source} ${field} preservation must be a boolean`);
    }
    if (!Array.isArray(behavior.gateIds)) {
      throw new Error(`${source} ${field} gateIds must be an array`);
    }
    if (behavior.gateIds.length === 0) {
      throw new Error(`${source} ${field} gateIds must be a non-empty array`);
    }
    if (behavior.gateIds.some((gateId) => typeof gateId !== "string")) {
      throw new Error(`${source} ${field} gateIds must contain only strings`);
    }
    const gateIds = behavior.gateIds as string[];
    if (gateIds.some((gateId) => gateId.trim() === "")) {
      throw new Error(
        `${source} ${field} gateIds must contain only non-blank strings`,
      );
    }
    const duplicateGateId = gateIds.find(
      (gateId, gateIndex) => gateIds.indexOf(gateId) !== gateIndex,
    );
    if (duplicateGateId !== undefined) {
      throw new Error(
        `${source} ${field} gateIds must be unique; duplicate "${duplicateGateId}"`,
      );
    }

    return {
      id: requireNonBlankString(behavior.id, `${field} id`, source),
      source: requireNonBlankString(
        behavior.source,
        `${field} source`,
        source,
      ),
      given: requireNonBlankString(behavior.given, `${field} given`, source),
      when: requireNonBlankString(behavior.when, `${field} when`, source),
      then: requireNonBlankString(behavior.then, `${field} then`, source),
      observableResult: requireNonBlankString(
        behavior.observableResult,
        `${field} observableResult`,
        source,
      ),
      preservation: behavior.preservation,
      gateIds: [...gateIds],
    };
  });

  const duplicateBehaviorId = behaviors
    .map((behavior) => behavior.id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateBehaviorId !== undefined) {
    throw new Error(
      `${source} behavior IDs must be unique; duplicate "${duplicateBehaviorId}"`,
    );
  }
  return behaviors;
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
  if (input.version !== 1 && input.version !== 2) {
    throw new Error(`${source} must declare version 1 or 2`);
  }
  requireExactKeys(
    input,
    input.version === 2
      ? ["version", "fileScope", "migrationCount", "behaviors"]
      : ["version", "fileScope", "migrationCount"],
    "root object",
    source,
  );
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
  let parsedFileScope: AcceptanceManifest["fileScope"];
  if (fileScope.kind === "no-repository-changes") {
    requireExactKeys(fileScope, ["kind"], "fileScope", source);
    if (migrationCount !== 0) {
      throw new Error(
        `${source} no-repository-changes requires migrationCount 0`,
      );
    }
    parsedFileScope = { kind: "no-repository-changes" };
  } else {
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
    parsedFileScope = { kind: "paths", paths };
  }

  if (input.version === 2) {
    return {
      version: 2,
      fileScope: parsedFileScope,
      migrationCount,
      behaviors: parseBehaviors(input.behaviors, source),
    };
  }
  return {
    version: 1,
    fileScope: parsedFileScope,
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

const CONTROLLED_BEHAVIOR_SECTIONS = new Set([
  "### In scope",
  "### Existing behavior to preserve",
]);
const BEHAVIOR_ANCHOR = /^- \[behavior:([A-Z][A-Z0-9-]*)\] .+$/;

export function validateAcceptanceManifestCoverage(
  contract: string,
  manifest: AcceptanceManifest,
  source = "contract.md",
): void {
  if (manifest.version !== 2) {
    throw new Error(
      `${source} behavior lock requires acceptance-manifest.json version 2`,
    );
  }

  const anchorCounts = new Map<string, number>();
  let inControlledSection = false;
  for (const line of contract.split(/\r?\n/)) {
    if (CONTROLLED_BEHAVIOR_SECTIONS.has(line)) {
      inControlledSection = true;
      continue;
    }
    if (/^#{1,6}(?:\s|$)/.test(line)) {
      inControlledSection = false;
      continue;
    }
    if (!inControlledSection) continue;

    const match = BEHAVIOR_ANCHOR.exec(line);
    if (match) {
      const id = match[1]!;
      anchorCounts.set(id, (anchorCounts.get(id) ?? 0) + 1);
    }
  }

  const manifestIds = new Set(manifest.behaviors.map((behavior) => behavior.id));
  const missing = [...anchorCounts.keys()]
    .filter((id) => !manifestIds.has(id))
    .sort();
  const duplicates = [...anchorCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  if (missing.length === 0 && duplicates.length === 0) return;

  throw new Error(
    `${source} behavior coverage refused: ` +
      `missing behavior anchors: ${missing.join(", ") || "none"}; ` +
      `duplicate behavior anchors: ${duplicates.join(", ") || "none"}`,
  );
}

export function validateAcceptanceManifestBindings(
  manifest: AcceptanceManifest,
  catalog: readonly { id: string; command?: string }[],
  source = ACCEPTANCE_MANIFEST_FILENAME,
): void {
  if (manifest.version !== 2) {
    throw new Error(`${source} behavior bindings require version 2`);
  }

  const catalogById = new Map(catalog.map((gate) => [gate.id, gate]));
  const unknown = new Set<string>();
  const nonExecutable = new Set<string>();
  for (const behavior of manifest.behaviors) {
    for (const gateId of behavior.gateIds) {
      const gate = catalogById.get(gateId);
      if (!gate) {
        unknown.add(gateId);
      } else if (
        typeof gate.command !== "string" ||
        gate.command.trim() === ""
      ) {
        nonExecutable.add(gateId);
      }
    }
  }
  if (unknown.size === 0 && nonExecutable.size === 0) return;

  throw new Error(
    `${source} behavior binding refused: ` +
      `unknown gate IDs: ${[...unknown].sort().join(", ") || "none"}; ` +
      `non-executable gate IDs: ${[...nonExecutable].sort().join(", ") || "none"}`,
  );
}

function behaviorEvidenceKey(behavior: AcceptanceBehavior): string {
  return JSON.stringify([
    behavior.source,
    behavior.given,
    behavior.when,
    behavior.then,
    behavior.observableResult,
    behavior.preservation,
  ]);
}

export function validateAcceptanceManifestStability(
  previous: AcceptanceManifest,
  current: AcceptanceManifest,
  source = ACCEPTANCE_MANIFEST_FILENAME,
): void {
  if (previous.version !== 2 || current.version !== 2) return;

  const idsByEvidence = (
    behaviors: readonly AcceptanceBehavior[],
  ): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const behavior of behaviors) {
      const key = behaviorEvidenceKey(behavior);
      groups.set(key, [...(groups.get(key) ?? []), behavior.id]);
    }
    return groups;
  };
  const previousGroups = idsByEvidence(previous.behaviors);
  const currentGroups = idsByEvidence(current.behaviors);
  const transitions: string[] = [];

  for (const [key, previousIds] of previousGroups) {
    const currentIds = currentGroups.get(key);
    if (!currentIds) continue;
    const previousOnly = previousIds
      .filter((id) => !currentIds.includes(id))
      .sort();
    const currentOnly = currentIds
      .filter((id) => !previousIds.includes(id))
      .sort();
    const pairCount = Math.min(previousOnly.length, currentOnly.length);
    for (let index = 0; index < pairCount; index++) {
      transitions.push(`${previousOnly[index]} -> ${currentOnly[index]}`);
    }
  }
  if (transitions.length === 0) return;

  throw new Error(
    `${source} behavior ID stability refused: unchanged behavior renumbered ` +
      transitions.join(", "),
  );
}
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ACCEPTANCE_MANIFEST_FILENAME = "acceptance-manifest.json";
