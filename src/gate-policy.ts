import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWithUniqueKeys } from "./json-scan.js";

/**
 * The first reader of `afk.config.json`'s optional top-level `gatePolicy`
 * object (PRD `afk-v2-acceptance-scope-gates` D1).
 *
 * Nothing consumes a policy yet: the gate runner, the file-scope gate and the
 * feedback channel are other slices' work, so with `gatePolicy` absent every
 * consumer still falls back to the derived baseline catalog in
 * `src/base-gates.ts`. What ships here is the schema and its refusals.
 *
 * Every rejection throws an `Error` naming the offending key, member, value or
 * character. A validator that passes over what it does not understand
 * reproduces the defect this PRD exists to remove — `parseAfkManifest`
 * accepted and silently discarded `protectedChangeWaivers` — so an unknown
 * member is malformed, not forward compatibility. `acceptance` and `cost` are
 * unknown here until the slices that own them widen the known set.
 */

const CONFIG_FILENAME = "afk.config.json";

const POLICY_KEYS = ["version", "protectedPaths", "riskClasses"] as const;
const PROTECTED_PATHS_KEYS = ["gatePolicyPaths", "testGlobs"] as const;

/**
 * Characters the D6 dialect refuses, in the order they are reported. The
 * dialect is literal segments, `*` and `**` and nothing else — so a glob
 * carrying anything from an extended dialect is refused rather than matched
 * under semantics AFK does not implement. A backslash is on this list because
 * a glob is authored in one syntax; the *path* a glob is matched against is
 * normalized to forward slashes instead.
 */
const REJECTED_GLOB_CHARACTERS = [
  "?",
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  "!",
  "+",
  "@",
  "\\",
] as const;

export type GateRiskClass = "gate-policy" | "deleted-test" | "skipped-test";

/** The escalation risk classes the catalog declares (D1, D5). */
export const GATE_RISK_CLASSES: readonly GateRiskClass[] = [
  "gate-policy",
  "deleted-test",
  "skipped-test",
];

/** Baseline `protectedPaths.gatePolicyPaths` when the member is omitted. */
export const DEFAULT_GATE_POLICY_PATHS: readonly string[] = [
  "afk.config.json",
  "suite-budgets.json",
];

/** Baseline `protectedPaths.testGlobs`: AFK's TypeScript/Vitest default. */
export const DEFAULT_TEST_GLOBS: readonly string[] = ["**/*.test.ts"];

export interface GatePolicyProtectedPaths {
  gatePolicyPaths: string[];
  testGlobs: string[];
}

export interface GatePolicy {
  version: 1;
  protectedPaths: GatePolicyProtectedPaths;
  riskClasses: GateRiskClass[];
}

/**
 * Refuse a member no version of this schema knows, naming it. The repo's other
 * exact-key helper is module-private to its own parser, and both of
 * `gatePolicy`'s members are optional anyway, so the check is local here:
 * unknown keys are fatal, missing ones default.
 */
function requireKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  field: string,
  source: string,
): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${source} ${field} has unknown ${
        unknown.length === 1 ? "member" : "members"
      } ${unknown.map((key) => `"${key}"`).join(", ")}; this version of AFK ` +
        `knows only ${known.join(", ")}`,
    );
  }
}

function parseStringArray(
  value: unknown,
  field: string,
  source: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} ${field} must be an array of strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `${source} ${field} must contain only non-blank strings; got ${JSON.stringify(
          entry,
        )}`,
      );
    }
    return entry;
  });
}

/**
 * The one gate on the D6 dialect, shared by `matchesGlob` and
 * `parseGatePolicy` so a glob the matcher could not honour can never reach the
 * config in the first place, and both entry points refuse it for the same
 * stated reason.
 */
function assertGlobDialect(glob: string, source: string): string {
  for (const character of REJECTED_GLOB_CHARACTERS) {
    if (glob.includes(character)) {
      throw new Error(
        `${source} testGlobs glob "${glob}" contains the metacharacter ` +
          `"${character}", which AFK's glob dialect — literal segments, "*" ` +
          `within one segment, "**" across segments — does not support`,
      );
    }
  }
  for (const segment of glob.split("/")) {
    if (segment.includes("**") && segment !== "**") {
      throw new Error(
        `${source} testGlobs glob "${glob}" has the segment "${segment}", ` +
          `where "**" is not the whole segment; "**" spans whole segments and ` +
          `must stand alone between slashes`,
      );
    }
  }
  return glob;
}

/** `*` matches within one segment, so it never sees a slash. */
function matchesSegment(globSegment: string, pathSegment: string): boolean {
  const parts = globSegment.split("*");
  if (parts.length === 1) return globSegment === pathSegment;

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!pathSegment.startsWith(first)) return false;
  if (!pathSegment.endsWith(last)) return false;

  let cursor = first.length;
  for (let index = 1; index < parts.length - 1; index++) {
    const part = parts[index]!;
    if (part === "") continue;
    const found = pathSegment.indexOf(part, cursor);
    if (found === -1) return false;
    cursor = found + part.length;
  }
  // The head and the tail may not overlap, or `*` would have matched a
  // negative number of characters.
  return pathSegment.length - last.length >= cursor;
}

function matchesFrom(
  globSegments: readonly string[],
  pathSegments: readonly string[],
  globIndex: number,
  pathIndex: number,
): boolean {
  if (globIndex === globSegments.length) {
    return pathIndex === pathSegments.length;
  }
  const segment = globSegments[globIndex]!;
  if (segment === "**") {
    // Zero or more segments: try every remaining split point.
    for (let skip = pathIndex; skip <= pathSegments.length; skip++) {
      if (matchesFrom(globSegments, pathSegments, globIndex + 1, skip)) {
        return true;
      }
    }
    return false;
  }
  if (pathIndex >= pathSegments.length) return false;
  if (!matchesSegment(segment, pathSegments[pathIndex]!)) return false;
  return matchesFrom(globSegments, pathSegments, globIndex + 1, pathIndex + 1);
}

/**
 * Match one path against one glob in the D6 dialect: literal segments, `*`
 * within a single segment, `**` across zero or more segments.
 *
 * The comparison is **case-sensitive on every platform** — no case folding
 * anywhere below — so the gate decides identically on Windows and on CI.
 * Deliberately not the same rule as the acceptance manifest's `fileScope`
 * comparison, which folds case: two comparisons, two purposes. Globs decide
 * which paths are test files; the manifest comparison decides which paths a
 * contract declared.
 *
 * Only the *path* is normalized to forward slashes; a backslash in the glob
 * is a refused metacharacter.
 */
export function matchesGlob(glob: string, path: string): boolean {
  assertGlobDialect(glob, CONFIG_FILENAME);
  return matchesFrom(
    glob.split("/"),
    path.replace(/\\/g, "/").split("/"),
    0,
    0,
  );
}

function parseProtectedPaths(
  value: unknown,
  source: string,
): GatePolicyProtectedPaths {
  if (value === undefined) {
    return {
      gatePolicyPaths: [...DEFAULT_GATE_POLICY_PATHS],
      testGlobs: [...DEFAULT_TEST_GLOBS],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} gatePolicy.protectedPaths must be a JSON object holding ` +
        `gatePolicyPaths and testGlobs`,
    );
  }
  const input = value as Record<string, unknown>;
  requireKnownKeys(
    input,
    PROTECTED_PATHS_KEYS,
    "gatePolicy.protectedPaths",
    source,
  );

  const gatePolicyPaths =
    input.gatePolicyPaths === undefined
      ? [...DEFAULT_GATE_POLICY_PATHS]
      : parseStringArray(
          input.gatePolicyPaths,
          "gatePolicy.protectedPaths.gatePolicyPaths",
          source,
        );
  const testGlobs =
    input.testGlobs === undefined
      ? [...DEFAULT_TEST_GLOBS]
      : parseStringArray(
          input.testGlobs,
          "gatePolicy.protectedPaths.testGlobs",
          source,
        ).map((glob) => assertGlobDialect(glob, source));

  return { gatePolicyPaths, testGlobs };
}

function parseRiskClasses(value: unknown, source: string): GateRiskClass[] {
  return parseStringArray(value, "gatePolicy.riskClasses", source).map(
    (entry) => {
      if (!GATE_RISK_CLASSES.includes(entry as GateRiskClass)) {
        throw new Error(
          `${source} gatePolicy.riskClasses does not recognise "${entry}"; ` +
            `the declared risk classes are ${GATE_RISK_CLASSES.join(", ")}`,
        );
      }
      return entry as GateRiskClass;
    },
  );
}

/**
 * Validate an already-parsed `gatePolicy` value. Pure: no filesystem access,
 * and the returned arrays are copies, so a caller mutating one cannot reach
 * the baseline constants.
 *
 * `version` is this object's own schema version, checked independently of
 * `afk.config.json`'s top-level `version`.
 */
export function parseGatePolicy(
  value: unknown,
  source = CONFIG_FILENAME,
): GatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} gatePolicy must be a JSON object`);
  }
  const input = value as Record<string, unknown>;
  requireKnownKeys(input, POLICY_KEYS, "gatePolicy", source);

  if (input.version !== 1) {
    throw new Error(
      `${source} gatePolicy.version must be the number 1 — its own schema ` +
        `version, independent of the file's top-level version — but is ` +
        `${JSON.stringify(input.version)}`,
    );
  }

  return {
    version: 1,
    protectedPaths: parseProtectedPaths(input.protectedPaths, source),
    riskClasses:
      input.riskClasses === undefined
        ? [...GATE_RISK_CLASSES]
        : parseRiskClasses(input.riskClasses, source),
  };
}

/**
 * Read `<repoRoot>/afk.config.json` and validate its `gatePolicy`. `null`
 * means "no policy declared" — either the file is absent or it carries no
 * `gatePolicy` key — which is the documented fallback to the derived baseline
 * catalog. A malformed policy propagates the validator's `Error`.
 *
 * Parsed with `parseJsonWithUniqueKeys`, not bare `JSON.parse`: a key repeated
 * in a hand-edited config would otherwise silently drop whichever policy lost,
 * and which one loses is a JSON-runtime accident.
 */
export function loadGatePolicy(repoRoot: string): GatePolicy | null {
  const path = join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(path)) return null;

  const config = parseJsonWithUniqueKeys(readFileSync(path, "utf-8"), path);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  if (!("gatePolicy" in config)) return null;
  return parseGatePolicy((config as Record<string, unknown>).gatePolicy, path);
}
