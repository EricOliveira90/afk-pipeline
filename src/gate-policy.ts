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
 * member is malformed, not forward compatibility. `cost` joined the known set
 * in #86 and `clean` in #87; every other member is still refused.
 */

/**
 * The one file {@link loadGatePolicy} reads, relative to the root it is given.
 * Exported because a gate whose rulebook is run-scoped has to be able to *name*
 * the candidate's own copy when the two disagree (#251), and naming it by
 * literal in a second module would be two spellings of one fact.
 */
export const GATE_POLICY_CONFIG_FILENAME = "afk.config.json";

const CONFIG_FILENAME = GATE_POLICY_CONFIG_FILENAME;

const POLICY_KEYS = [
  "version",
  "protectedPaths",
  "riskClasses",
  "acceptance",
  "cost",
  "clean",
] as const;
const PROTECTED_PATHS_KEYS = ["gatePolicyPaths", "testGlobs"] as const;
const ACCEPTANCE_KEYS = ["command", "args", "matcher"] as const;
const COST_KEYS = [
  "cheapThresholdMs",
  "environmentSensitive",
  "cacheEnabled",
  "relatedTests",
  "skipDetectors",
] as const;
const RELATED_TESTS_KEYS = ["command", "args"] as const;
const SKIP_DETECTOR_KEYS = ["id", "testGlobs", "patterns"] as const;
const CLEAN_KEYS = [
  "gates",
  "additionalWriteScope",
  "suppressionDetectors",
] as const;
const CLEAN_GATE_KEYS = [
  "id",
  "command",
  "args",
  "required",
  "expectedCostMs",
] as const;
/** `expectedCostMs` defaults, so it is the one member a gate may omit. */
const CLEAN_GATE_REQUIRED_KEYS = CLEAN_GATE_KEYS.filter(
  (key) => key !== "expectedCostMs",
);
const SUPPRESSION_DETECTOR_KEYS = ["id", "globs", "patterns"] as const;

/**
 * Gate ids the catalog owns, which a project's `clean.gates` may therefore not
 * claim. Spelled here rather than imported for the reason
 * {@link BEHAVIOR_ID_TOKEN} is spelled twice: this module is the config reader
 * every gate module imports, so it must not import one of them back. A
 * collision would have one id name two different commands, and the gate runner
 * keys evidence, caching and prerequisites by id.
 */
const RESERVED_GATE_IDS: readonly string[] = [
  // src/base-gates.ts BASE_GATE_IDS
  "typecheck",
  "lint",
  "tests",
  // The content-derived and acceptance gates
  "scope",
  "feedback-integrity",
  "tests:skipped",
  "acceptance:behaviors",
  "test:budgets",
  "suppressions",
];

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
 * The literal token a clean gate's `args` entry may carry, expanded to one
 * repo-relative path per changed file when that round's declarations are built
 * (`src/cleaner-stage.ts`). Exported because the expander lives in another
 * module and one spelling of the token is the whole point.
 *
 * Like {@link BEHAVIOR_ID_TOKEN} this is literal string substitution and has
 * nothing to do with {@link REJECTED_GLOB_CHARACTERS}: `{` and `}` are refused
 * in a glob, never in an `args` entry.
 */
export const CHANGED_FILES_TOKEN = "{changedFiles}";

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

/**
 * Default `cost.cheapThresholdMs`: D18's own figure. A required gate whose
 * `expectedCostMs` is at or below it is cheap enough to sit in the generator's
 * own edit cycle.
 */
export const DEFAULT_CHEAP_THRESHOLD_MS = 120_000;

/** Default `cost.cacheEnabled` (D17). */
export const DEFAULT_CACHE_ENABLED = true;

/**
 * One project-declared way of spotting a disabled test. Records, not a
 * name-only list, because D7 requires a project on another runner to be able
 * to declare its own detector — a name could not carry the patterns.
 *
 * `patterns` are regular-expression sources, compiled with the `g` flag and
 * counted. `testGlobs` is the D6 dialect {@link matchesGlob} implements.
 */
export interface GatePolicySkipDetector {
  id: string;
  testGlobs: string[];
  patterns: string[];
}

/**
 * The detector AFK ships when a project declares none: TypeScript/Vitest, the
 * runner this repo and its consumers use. `.only` is in the list because it
 * disables every sibling test, which is a skip by another name.
 */
export const DEFAULT_SKIP_DETECTORS: readonly GatePolicySkipDetector[] = [
  {
    id: "vitest-ts",
    testGlobs: ["**/*.test.ts"],
    patterns: [
      "describe\\.skip",
      "it\\.skip",
      "test\\.skip",
      "it\\.todo",
      "test\\.todo",
      "describe\\.only",
      "it\\.only",
      "test\\.only",
    ],
  },
];

/** One declared command that receives changed paths (project-specific, D18). */
export interface GatePolicyRelatedTests {
  command: string;
  args: string[];
}

/**
 * The test-cost half of the policy (#86). Every member is resolved here — the
 * declared value or the documented default — so the one production reader
 * (`resolveTestCostPlan` in `src/base-gates.ts`) hands each consumer a settled
 * answer rather than a maybe.
 *
 * `expectedCostMs` and gate prerequisites are deliberately absent: those are
 * AFK's own gate metadata and live in `src/base-gates.ts` as code, because a
 * consuming project does not author AFK's gate catalog (D1's rule that the
 * association between a class and what it covers is code).
 */
export interface GatePolicyCost {
  cheapThresholdMs: number;
  /** Gate ids that run but may not block (D16), e.g. `test:budgets`. */
  environmentSensitive: string[];
  cacheEnabled: boolean;
  relatedTests?: GatePolicyRelatedTests;
  skipDetectors: GatePolicySkipDetector[];
}

/**
 * One project-declared quality gate the cleaner stage runs (PRD D1). The shape
 * is the declarable half of a `GateDeclaration`: AFK's own gate metadata —
 * stage, prerequisites, wall-clock timeouts — stays in code, because a
 * consuming project does not author AFK's gate catalog.
 *
 * `expectedCostMs` is budgeting and reporting only, never a pass/fail
 * condition: ADR 0063 rules that a wall-clock budget cannot fail a gate.
 */
export interface GatePolicyCleanGate {
  id: string;
  command: string;
  /** An entry may be exactly {@link CHANGED_FILES_TOKEN} and nothing else. */
  args: string[];
  required: boolean;
  expectedCostMs: number;
}

/**
 * One project-declared way of spotting a suppression: a comment or pragma that
 * removes a file, line or rule from a gate's sight rather than satisfying it.
 *
 * `globs` rather than `testGlobs` because a suppression is a *source* fact —
 * the files this looks at are the files the slice changed, not its test files.
 * `patterns` are regular-expression sources, compiled with `g` and counted, and
 * they are counted over raw file content: unlike a disabled test, a suppression
 * *is* a comment, so stripping comments would read every file as clean.
 */
export interface GatePolicySuppressionDetector {
  id: string;
  globs: string[];
  patterns: string[];
}

/**
 * The detector AFK ships when a project declares none: the TypeScript and
 * ESLint pragmas, which are the suppressions available in the toolchain this
 * repo and its consumers use.
 */
export const DEFAULT_SUPPRESSION_DETECTORS: readonly GatePolicySuppressionDetector[] =
  [
    {
      id: "ts-eslint",
      globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      patterns: [
        "@ts-ignore",
        "@ts-expect-error",
        "@ts-nocheck",
        "eslint-disable",
        "istanbul ignore",
        "c8 ignore",
      ],
    },
  ];

/**
 * The clean-stage half of the policy (PRD D1). Its presence is the only switch
 * the cleaner stage has: no `clean` member means the stage does not exist, so
 * this member is optional and — unlike its own sub-members — has no default.
 */
export interface GatePolicyClean {
  /** At least one gate: a stage with no gate could never release a tree. */
  gates: GatePolicyCleanGate[];
  /**
   * Globs the cleaner may write beyond the locked `fileScope` (PRD D3) — the
   * only widening of a slice's write scope this stage gets.
   */
  additionalWriteScope: string[];
  suppressionDetectors: GatePolicySuppressionDetector[];
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
  /**
   * Absent means every documented default applies. Optional for the same
   * reason `acceptance` is: the absence is itself what `src/base-gates.ts`
   * reads, and only it knows the project's gate catalog.
   */
  cost?: GatePolicyCost;
  /**
   * Absent means the cleaner stage does not exist for this project (#87 AC1).
   * Not defaulted, for a stronger reason than the two members above: a default
   * here would turn a post-approval writing stage on for every consumer that
   * never asked for one.
   */
  clean?: GatePolicyClean;
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
function assertGlobDialect(
  glob: string,
  source: string,
  // Named so a refusal points at the member that carried the glob; every
  // pre-existing caller passes a `testGlobs` member, hence the default.
  field = "testGlobs",
): string {
  for (const character of REJECTED_GLOB_CHARACTERS) {
    if (glob.includes(character)) {
      throw new Error(
        `${source} ${field} glob "${glob}" contains the metacharacter ` +
          `"${character}", which AFK's glob dialect — literal segments, "*" ` +
          `within one segment, "**" across segments — does not support`,
      );
    }
  }
  for (const segment of glob.split("/")) {
    if (segment.includes("**") && segment !== "**") {
      throw new Error(
        `${source} ${field} glob "${glob}" has the segment "${segment}", ` +
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

function parsePositiveInteger(
  value: unknown,
  field: string,
  source: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `${source} ${field} must be a non-negative whole number of ` +
        `milliseconds; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseRelatedTests(
  value: unknown,
  source: string,
): GatePolicyRelatedTests {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} gatePolicy.cost.relatedTests must be a JSON object holding ` +
        `command and args`,
    );
  }
  const input = value as Record<string, unknown>;
  requireExactKeys(
    input,
    RELATED_TESTS_KEYS,
    "gatePolicy.cost.relatedTests",
    source,
  );
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error(
      `${source} gatePolicy.cost.relatedTests.command must be a non-blank ` +
        `string; got ${JSON.stringify(input.command)}`,
    );
  }
  return {
    command: input.command,
    args: parseStringArray(
      input.args,
      "gatePolicy.cost.relatedTests.args",
      source,
    ),
  };
}

/**
 * One detector, refused naming its own index so an operator can find it in a
 * list. `patterns` may not be empty: a detector that matches nothing is a
 * detector that reports every candidate clean, which is the silent-pass defect
 * this reader exists to refuse. Each pattern must compile, because a regular
 * expression that throws at gate time is a configuration defect discovered at
 * the worst moment.
 */
function parseSkipDetector(
  value: unknown,
  field: string,
  source: string,
): GatePolicySkipDetector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} ${field} must be a JSON object holding id, testGlobs and ` +
        `patterns`,
    );
  }
  const input = value as Record<string, unknown>;
  requireExactKeys(input, SKIP_DETECTOR_KEYS, field, source);
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error(
      `${source} ${field}.id must be a non-blank string; got ` +
        `${JSON.stringify(input.id)}`,
    );
  }
  const testGlobs = parseStringArray(
    input.testGlobs,
    `${field}.testGlobs`,
    source,
  ).map((glob) => assertGlobDialect(glob, source));
  if (testGlobs.length === 0) {
    throw new Error(
      `${source} ${field}.testGlobs must name at least one glob, or the ` +
        `detector can never read a file`,
    );
  }
  const patterns = parseStringArray(
    input.patterns,
    `${field}.patterns`,
    source,
  );
  if (patterns.length === 0) {
    throw new Error(
      `${source} ${field}.patterns must be a non-empty array of regular ` +
        `expressions; a detector with no pattern reports every candidate clean`,
    );
  }
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "g");
    } catch (error) {
      throw new Error(
        `${source} ${field}.patterns entry ${JSON.stringify(pattern)} is not ` +
          `a valid regular expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { id: input.id, testGlobs, patterns };
}

/**
 * The test-cost member (#86 B-01), modelled on {@link parseProtectedPaths}:
 * every sub-key optional with a documented default, every unknown sub-key and
 * every wrong type fatal and named. `cost: {}` is therefore legal and means
 * exactly the defaults.
 */
function parseCost(value: unknown, source: string): GatePolicyCost {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} gatePolicy.cost must be a JSON object holding ` +
        `${COST_KEYS.join(", ")}`,
    );
  }
  const input = value as Record<string, unknown>;
  requireKnownKeys(input, COST_KEYS, "gatePolicy.cost", source);

  if (
    input.cacheEnabled !== undefined &&
    typeof input.cacheEnabled !== "boolean"
  ) {
    throw new Error(
      `${source} gatePolicy.cost.cacheEnabled must be a boolean; got ` +
        `${JSON.stringify(input.cacheEnabled)}`,
    );
  }
  const skipDetectors =
    input.skipDetectors === undefined
      ? DEFAULT_SKIP_DETECTORS.map((detector) => ({
          id: detector.id,
          testGlobs: [...detector.testGlobs],
          patterns: [...detector.patterns],
        }))
      : (() => {
          if (!Array.isArray(input.skipDetectors)) {
            throw new Error(
              `${source} gatePolicy.cost.skipDetectors must be an array of ` +
                `{ id, testGlobs, patterns } objects`,
            );
          }
          return input.skipDetectors.map((entry, index) =>
            parseSkipDetector(
              entry,
              `gatePolicy.cost.skipDetectors[${index}]`,
              source,
            ),
          );
        })();
  const ids = skipDetectors.map((detector) => detector.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `${source} gatePolicy.cost.skipDetectors declares the id ` +
        `"${duplicate}" twice; a detector id names one rule`,
    );
  }

  return {
    cheapThresholdMs:
      input.cheapThresholdMs === undefined
        ? DEFAULT_CHEAP_THRESHOLD_MS
        : parsePositiveInteger(
            input.cheapThresholdMs,
            "gatePolicy.cost.cheapThresholdMs",
            source,
          ),
    environmentSensitive:
      input.environmentSensitive === undefined
        ? []
        : parseStringArray(
            input.environmentSensitive,
            "gatePolicy.cost.environmentSensitive",
            source,
          ),
    cacheEnabled:
      input.cacheEnabled === undefined
        ? DEFAULT_CACHE_ENABLED
        : input.cacheEnabled,
    ...(input.relatedTests === undefined
      ? {}
      : { relatedTests: parseRelatedTests(input.relatedTests, source) }),
    skipDetectors,
  };
}

/**
 * One clean gate, refused naming its own index so an operator can find it in a
 * list. Every member is mandatory except `expectedCostMs`: a gate with no
 * `required` flag has no answer to "may this block the merge", and a gate with
 * no command is a name.
 */
function parseCleanGate(
  value: unknown,
  field: string,
  source: string,
): GatePolicyCleanGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} ${field} must be a JSON object holding ` +
        `${CLEAN_GATE_KEYS.join(", ")}`,
    );
  }
  const input = value as Record<string, unknown>;
  requireExactKeys(
    input,
    "expectedCostMs" in input ? CLEAN_GATE_KEYS : CLEAN_GATE_REQUIRED_KEYS,
    field,
    source,
  );
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error(
      `${source} ${field}.id must be a non-blank string; got ` +
        `${JSON.stringify(input.id)}`,
    );
  }
  if (RESERVED_GATE_IDS.includes(input.id)) {
    throw new Error(
      `${source} ${field}.id "${input.id}" is a gate AFK declares itself; a ` +
        `clean gate must carry its own id, because gate evidence, caching and ` +
        `prerequisites are keyed by it. AFK's ids are ` +
        `${RESERVED_GATE_IDS.join(", ")}`,
    );
  }
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new Error(
      `${source} ${field}.command must be a non-blank string; got ` +
        `${JSON.stringify(input.command)}`,
    );
  }
  if (typeof input.required !== "boolean") {
    throw new Error(
      `${source} ${field}.required must be a boolean; got ` +
        `${JSON.stringify(input.required)}`,
    );
  }
  return {
    id: input.id,
    command: input.command,
    args: parseStringArray(input.args, `${field}.args`, source),
    required: input.required,
    expectedCostMs:
      input.expectedCostMs === undefined
        ? DEFAULT_CHEAP_THRESHOLD_MS
        : parsePositiveInteger(
            input.expectedCostMs,
            `${field}.expectedCostMs`,
            source,
          ),
  };
}

/** One suppression detector, on the same terms as {@link parseSkipDetector}. */
function parseSuppressionDetector(
  value: unknown,
  field: string,
  source: string,
): GatePolicySuppressionDetector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} ${field} must be a JSON object holding id, globs and patterns`,
    );
  }
  const input = value as Record<string, unknown>;
  requireExactKeys(input, SUPPRESSION_DETECTOR_KEYS, field, source);
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error(
      `${source} ${field}.id must be a non-blank string; got ` +
        `${JSON.stringify(input.id)}`,
    );
  }
  const globs = parseStringArray(input.globs, `${field}.globs`, source).map(
    (glob) => assertGlobDialect(glob, source, `${field}.globs`),
  );
  if (globs.length === 0) {
    throw new Error(
      `${source} ${field}.globs must name at least one glob, or the detector ` +
        `can never read a file`,
    );
  }
  const patterns = parseStringArray(
    input.patterns,
    `${field}.patterns`,
    source,
  );
  if (patterns.length === 0) {
    throw new Error(
      `${source} ${field}.patterns must be a non-empty array of regular ` +
        `expressions; a detector with no pattern reports every tree clean`,
    );
  }
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "g");
    } catch (error) {
      throw new Error(
        `${source} ${field}.patterns entry ${JSON.stringify(pattern)} is not ` +
          `a valid regular expression: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { id: input.id, globs, patterns };
}

/**
 * The clean-stage member (#87 B-01), modelled on {@link parseCost}: every
 * unknown sub-key and every wrong type fatal and named. Unlike `cost`, `gates`
 * has no default — `clean: {}` is refused, because the member's whole meaning
 * is "run these gates after approval" and an empty stage would dispatch a
 * cleaner that nothing could ever release.
 */
function parseClean(value: unknown, source: string): GatePolicyClean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${source} gatePolicy.clean must be a JSON object holding ` +
        `${CLEAN_KEYS.join(", ")}`,
    );
  }
  const input = value as Record<string, unknown>;
  requireKnownKeys(input, CLEAN_KEYS, "gatePolicy.clean", source);

  if (!Array.isArray(input.gates)) {
    throw new Error(
      `${source} gatePolicy.clean.gates must be an array of ` +
        `{ ${CLEAN_GATE_KEYS.join(", ")} } objects`,
    );
  }
  const gates = input.gates.map((entry, index) =>
    parseCleanGate(entry, `gatePolicy.clean.gates[${index}]`, source),
  );
  if (gates.length === 0) {
    throw new Error(
      `${source} gatePolicy.clean.gates must declare at least one gate; a ` +
        `clean stage with no gate can never release a tree`,
    );
  }
  const gateIds = gates.map((gate) => gate.id);
  const duplicateGate = gateIds.find((id, index) => gateIds.indexOf(id) !== index);
  if (duplicateGate !== undefined) {
    throw new Error(
      `${source} gatePolicy.clean.gates declares the id "${duplicateGate}" ` +
        `twice; a gate id names one command`,
    );
  }

  const suppressionDetectors =
    input.suppressionDetectors === undefined
      ? DEFAULT_SUPPRESSION_DETECTORS.map((detector) => ({
          id: detector.id,
          globs: [...detector.globs],
          patterns: [...detector.patterns],
        }))
      : (() => {
          if (!Array.isArray(input.suppressionDetectors)) {
            throw new Error(
              `${source} gatePolicy.clean.suppressionDetectors must be an ` +
                `array of { id, globs, patterns } objects`,
            );
          }
          return input.suppressionDetectors.map((entry, index) =>
            parseSuppressionDetector(
              entry,
              `gatePolicy.clean.suppressionDetectors[${index}]`,
              source,
            ),
          );
        })();
  const detectorIds = suppressionDetectors.map((detector) => detector.id);
  const duplicateDetector = detectorIds.find(
    (id, index) => detectorIds.indexOf(id) !== index,
  );
  if (duplicateDetector !== undefined) {
    throw new Error(
      `${source} gatePolicy.clean.suppressionDetectors declares the id ` +
        `"${duplicateDetector}" twice; a detector id names one rule`,
    );
  }

  return {
    gates,
    additionalWriteScope:
      input.additionalWriteScope === undefined
        ? []
        : parseStringArray(
            input.additionalWriteScope,
            "gatePolicy.clean.additionalWriteScope",
            source,
          ).map((glob) =>
            assertGlobDialect(
              glob,
              source,
              "gatePolicy.clean.additionalWriteScope",
            ),
          ),
    suppressionDetectors,
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
    // Same rule as `acceptance`: omitted stays omitted, because the absence is
    // what `resolveTestCostPlan` reads as "every default applies".
    ...(input.cost === undefined ? {} : { cost: parseCost(input.cost, source) }),
    // Same rule again, and here the absence is the whole switch: no `clean`
    // member means the cleaner stage does not exist (#87 AC1).
    ...(input.clean === undefined
      ? {}
      : { clean: parseClean(input.clean, source) }),
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
