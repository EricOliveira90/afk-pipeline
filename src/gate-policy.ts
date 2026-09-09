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
 * member is malformed, not forward compatibility. `cost` is unknown here until
 * the slice that owns it widens the known set (#86).
 */

const CONFIG_FILENAME = "afk.config.json";

const POLICY_KEYS = [
  "version",
  "protectedPaths",
  "riskClasses",
  "acceptance",
] as const;
const PROTECTED_PATHS_KEYS = ["gatePolicyPaths", "testGlobs"] as const;
const ACCEPTANCE_KEYS = ["command", "args", "matcher"] as const;

/** Every runner-output matcher this version of AFK implements (D8). */
const ACCEPTANCE_MATCHERS = ["vitest-json"] as const;

/**
 * The literal token an `args` entry must carry, substituted per behavior id by
 * `src/acceptance-gate.ts`. Spelled here as well as in `src/base-gates.ts`
 * (`BEHAVIOR_ID_TOKEN`) on purpose: this module is the config reader every gate
 * module imports, so it must not import one of them back. A test in
 * `src/gate-policy.test.ts` pins the two spellings together.
 *
 * Unrelated to {@link REJECTED_GLOB_CHARACTERS} below, which refuses `{` and
 * `}` in the D6 glob dialect — this is literal string substitution, never
 * matched as a glob.
 */
const BEHAVIOR_ID_TOKEN = "{behaviorId}";

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

export type GateAcceptanceMatcher = (typeof ACCEPTANCE_MATCHERS)[number];

/**
 * How a project proves one behavior id is covered: the command to run per id,
 * and the matcher that reads its output. Both halves are needed — a command
 * with no matcher is an exit code, and D8 exists because an exit code cannot
 * tell "zero tests matched" from "every matched test passed".
 */
export interface GatePolicyAcceptance {
  command: string;
  /** At least one entry carries the literal `{behaviorId}` token. */
  args: string[];
  matcher: GateAcceptanceMatcher;
}

export interface GatePolicy {
  version: 1;
  protectedPaths: GatePolicyProtectedPaths;
  riskClasses: GateRiskClass[];
  /**
   * Absent means the derived baseline in `src/base-gates.ts` decides, which is
   * why this member is optional rather than defaulted here: the baseline needs
   * a `package.json` probe, and this parser is pure.
   */
  acceptance?: GatePolicyAcceptance;
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

/**
 * {@link requireKnownKeys} plus the other half, for a member whose sub-members
 * are all mandatory. `gatePolicy`'s own members default when omitted, so this
 * is not the rule up there; inside `acceptance` there is nothing to default to
 * — a half-declared runner would launch the wrong command.
 */
function requireExactKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  field: string,
  source: string,
): void {
  requireKnownKeys(value, known, field, source);
  const missing = known.filter((key) => value[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${source} ${field} is missing required ${
        missing.length === 1 ? "member" : "members"
      } ${missing.map((key) => `"${key}"`).join(", ")}`,
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
 * The three refusals the acceptance member owns (#85 AC4), each naming the
 * offender: a shape that is not an exact `{ command, args, matcher }` object;
 * `args` that never mention {@link BEHAVIOR_ID_TOKEN}, which would run the same
 * unfiltered suite for every behavior and call all of them covered; and a
 * matcher this version cannot read, which would be a verdict from an exit code.
 */
function parseAcceptance(
  value: unknown,
  source: string,
): GatePolicyAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} gatePolicy.acceptance must be a JSON object holding ` +
        `command, args and matcher`,
    );
  }
  const input = value as Record<string, unknown>;
  requireExactKeys(input, ACCEPTANCE_KEYS, "gatePolicy.acceptance", source);

  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error(
      `${source} gatePolicy.acceptance.command must be a non-blank string; ` +
        `got ${JSON.stringify(input.command)}`,
    );
  }
  const args = parseStringArray(
    input.args,
    "gatePolicy.acceptance.args",
    source,
  );
  if (args.length === 0) {
    throw new Error(
      `${source} gatePolicy.acceptance.args must be a non-empty array of ` +
        `strings`,
    );
  }
  if (!args.some((entry) => entry.includes(BEHAVIOR_ID_TOKEN))) {
    throw new Error(
      `${source} gatePolicy.acceptance.args must carry the literal ` +
        `${BEHAVIOR_ID_TOKEN} token in at least one entry, so each behavior ` +
        `id selects its own tests; got ${JSON.stringify(args)}`,
    );
  }
  if (
    !ACCEPTANCE_MATCHERS.includes(input.matcher as GateAcceptanceMatcher)
  ) {
    throw new Error(
      `${source} gatePolicy.acceptance.matcher ` +
        `${JSON.stringify(input.matcher)} is not a matcher this version of ` +
        `AFK implements; the supported matcher is ` +
        `${ACCEPTANCE_MATCHERS.join(", ")}`,
    );
  }

  return {
    command: input.command,
    args,
    matcher: input.matcher as GateAcceptanceMatcher,
  };
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
    // Omitted stays omitted rather than becoming an explicit `undefined`: the
    // absence is what `src/base-gates.ts` reads as "derive the baseline".
    ...(input.acceptance === undefined
      ? {}
      : { acceptance: parseAcceptance(input.acceptance, source) }),
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
