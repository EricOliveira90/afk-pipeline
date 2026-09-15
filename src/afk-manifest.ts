import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_RISK_CLASSES, type GateRiskClass } from "./gate-policy.js";

export interface ProtectedIssue {
  number: number;
  state: "OPEN" | "CLOSED";
}

/**
 * One human authorization for one protected change (#193, PRD 4 D1).
 *
 * The launch manifest is the only place a waiver can live, because it is the
 * one file a slice agent cannot write: `afk.json` sits in the PRD directory of
 * the host checkout, outside every slice's file scope, and the orchestrator
 * reads it before any wave dispatches. A waiver a candidate could author would
 * be a gate the candidate can turn off.
 *
 * Every field is load-bearing and none has a default: `riskClass` and `path`
 * are what the waiver matches, and `author` plus `reason` are the audit record
 * the gate copies into its evidence. A waiver with an empty reason is a waiver
 * nobody can review later.
 */
export interface ProtectedChangeWaiver {
  /** Which detection this waiver answers; one of `GATE_RISK_CLASSES`. */
  riskClass: GateRiskClass;
  /**
   * One exact repo-relative path, never a glob. A waiver is a decision about
   * a file somebody looked at; a pattern silently covers files nobody has
   * seen yet, including files that do not exist when it is written.
   */
  path: string;
  /** Who authorized it. */
  author: string;
  /** Why — the sentence a later reader needs. */
  reason: string;
}

/**
 * The declared report-only mutation step (#303, ADR 0071): what to run, and
 * where the run writes its mutation-testing-elements report.
 *
 * It lives in the launch manifest for the reason a waiver does — `afk.json`
 * sits in the host checkout's PRD directory, outside every slice's file scope,
 * so a candidate cannot declare its own mutation command. Unlike a waiver,
 * nothing here authorizes anything: the step is reported, never a gate.
 *
 * `--mutation-report` decides whether the step runs this run; this member
 * decides what the step *is*. Neither is enough alone, which is why the flag
 * without a declaration refuses the launch instead of quietly running nothing.
 */
export interface MutationReportDeclaration {
  /** The command line to run, verbatim; the changed files are appended. */
  command: string;
  /**
   * Repo-relative path of the JSON report the command writes, normalized the
   * way a waiver path is. One exact path, never a glob: a pattern names files
   * nobody has read, and a report AFK guessed at is a survivor list nobody can
   * check.
   */
  reportPath: string;
  /**
   * Repo-relative path of the operator's incremental baseline artifact, read to
   * say whether each survivor is new in this run or was already surviving
   * (#304 B-01). Optional and *absent* when undeclared, the same discipline
   * `mutationReport` itself is under: absence is the normal case, never an
   * error, and it means every survivor is reported `unattributed`.
   *
   * Declared here rather than behind a CLI flag or a script convention because
   * it is a durable per-project fact, and `afk.json` is the strictly-validated
   * cross-repository contract for those (ADR 0034).
   */
  baselinePath?: string;
  /**
   * Repo-relative path of the committed triage decisions file (ADR 0071's
   * "Decisions file schema"), read to mark a survivor a human already
   * adjudicated as `accepted` rather than re-raising it. Optional and absent
   * when undeclared, for the reason `baselinePath` is.
   *
   * Marking, never suppressing: an `accepted` survivor stays in the report at
   * full detail, so nothing here can shorten a survivor list.
   */
  decisionsPath?: string;
}

export interface AfkManifest {
  version: 1;
  selectedSlices: string[];
  migrationPrefixes: string[];
  protectedIssues: ProtectedIssue[];
  /**
   * Human authorizations for protected changes. Optional on the type and
   * always present on a parsed manifest: absence reads as "no waiver", so a
   * hand-built manifest that predates this member means the same thing as an
   * `afk.json` that omits it — and every reader spells that one way,
   * `protectedChangeWaivers ?? []`.
   */
  protectedChangeWaivers?: ProtectedChangeWaiver[];
  /**
   * The declared mutation step. Optional and *absent* when undeclared — unlike
   * `protectedChangeWaivers`, absence is not "an empty one": a manifest that
   * declares no command is a manifest `--mutation-report` refuses, and an empty
   * object would be a command nobody wrote. `version` stays `1`: an optional
   * member every existing reader ignores is not a schema break (GH #303 AC5).
   */
  mutationReport?: MutationReportDeclaration;
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

/**
 * One spelling for a waived path, so the manifest and the gate compare the
 * same bytes: forward slashes, no `./` prefix, trimmed. A waiver written
 * `./src\thing.ts` on Windows has to match the `src/thing.ts` git reports.
 */
export function normalizeWaiverPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function nonBlankField(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${source} protectedChangeWaivers entries require a non-blank ${field}`,
    );
  }
  return value.trim();
}

function normalizeProtectedChangeWaiver(
  entry: unknown,
  source: string,
): ProtectedChangeWaiver {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `${source} protectedChangeWaivers entries must be JSON objects holding ` +
        `riskClass, path, author and reason`,
    );
  }
  const value = entry as Record<string, unknown>;
  const riskClass = nonBlankField(value.riskClass, "riskClass", source);
  if (!GATE_RISK_CLASSES.includes(riskClass as GateRiskClass)) {
    throw new Error(
      `${source} protectedChangeWaivers does not recognise riskClass ` +
        `"${riskClass}"; the declared risk classes are ` +
        `${GATE_RISK_CLASSES.join(", ")}`,
    );
  }
  const path = normalizeWaiverPath(nonBlankField(value.path, "path", source));
  if (/[*?[]/.test(path)) {
    throw new Error(
      `${source} protectedChangeWaivers path "${path}" looks like a glob; a ` +
        `waiver names one exact path, because a pattern authorizes files ` +
        `nobody has read`,
    );
  }
  return {
    riskClass: riskClass as GateRiskClass,
    path,
    author: nonBlankField(value.author, "author", source),
    reason: nonBlankField(value.reason, "reason", source),
  };
}

/**
 * The one path rule set every `mutationReport` path member goes through
 * (#304 B-02): the waiver rules — one exact repo-relative path, never a glob —
 * plus a `..` refusal, because a file read from outside the worktree came from a
 * tree nobody reviewed.
 *
 * One helper rather than a copy per member: a third path arriving with its own
 * hand-copied block is how one of them ends up missing a rule. `noun` and
 * `nouns` keep each refusal reading as advice about the file at fault.
 */
function normalizeMutationReportPath(
  value: string,
  member: string,
  noun: string,
  nouns: string,
  source: string,
): string {
  const path = normalizeWaiverPath(value);
  if (/[*?[]/.test(path)) {
    throw new Error(
      `${source} mutationReport ${member} "${path}" looks like a glob; ` +
        `the step reads one exact ${noun}, because a pattern names ${nouns} ` +
        `nobody has read`,
    );
  }
  if (/^(?:[a-zA-Z]:)?\//.test(path)) {
    throw new Error(
      `${source} mutationReport ${member} "${path}" must be repo-relative, ` +
        `not absolute`,
    );
  }
  if (path.split("/").includes("..")) {
    throw new Error(
      `${source} mutationReport ${member} "${path}" must not traverse ` +
        `outside the worktree with ".."`,
    );
  }
  return path;
}

/**
 * Validate and normalize a declared `mutationReport`, naming the offending
 * member in every refusal so an operator can fix the manifest without reading
 * this function.
 *
 * Fail closed on a blank member rather than dropping it: a silently ignored
 * declaration is a run that reports nothing and says nothing about why.
 *
 * `baselinePath` and `decisionsPath` are optional, and an absent one stays
 * absent in the result rather than becoming an `undefined`-valued key: the ship
 * gate rewrites `afk.json` from this object, so a key this parser drops is a key
 * deleted from the reviewed branch (#304 B-01/B-03).
 */
function normalizeMutationReport(
  entry: unknown,
  source: string,
): MutationReportDeclaration {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `${source} mutationReport must be a JSON object holding command and reportPath`,
    );
  }
  const value = entry as Record<string, unknown>;
  if (typeof value.command !== "string" || value.command.trim() === "") {
    throw new Error(
      `${source} mutationReport requires a non-blank command`,
    );
  }
  if (typeof value.reportPath !== "string" || value.reportPath.trim() === "") {
    throw new Error(
      `${source} mutationReport requires a non-blank reportPath`,
    );
  }
  const reportPath = normalizeMutationReportPath(
    value.reportPath,
    "reportPath",
    "report file",
    "reports",
    source,
  );
  const optionalPath = (
    member: "baselinePath" | "decisionsPath",
    noun: string,
    nouns: string,
  ): string | undefined => {
    if (value[member] === undefined) return undefined;
    const declared = value[member];
    if (typeof declared !== "string" || declared.trim() === "") {
      throw new Error(
        `${source} mutationReport ${member} must be a non-blank string when ` +
          `declared; omit the member instead to declare no ${noun}`,
      );
    }
    return normalizeMutationReportPath(declared, member, noun, nouns, source);
  };
  const baselinePath = optionalPath(
    "baselinePath",
    "baseline file",
    "baselines",
  );
  const decisionsPath = optionalPath(
    "decisionsPath",
    "decisions file",
    "decisions files",
  );
  return {
    command: value.command.trim(),
    reportPath,
    ...(baselinePath !== undefined ? { baselinePath } : {}),
    ...(decisionsPath !== undefined ? { decisionsPath } : {}),
  };
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

  const rawWaivers = input.protectedChangeWaivers ?? [];
  if (!Array.isArray(rawWaivers)) {
    throw new Error(`${source} protectedChangeWaivers must be an array`);
  }
  const protectedChangeWaivers = rawWaivers.map((entry) =>
    normalizeProtectedChangeWaiver(entry, source),
  );
  // A risk class holds no space, so one space cannot make two distinct pairs
  // collide on a single key.
  const waiverKeys = protectedChangeWaivers.map(
    (waiver) => `${waiver.riskClass} ${waiver.path}`,
  );
  if (new Set(waiverKeys).size !== waiverKeys.length) {
    throw new Error(
      `${source} protectedChangeWaivers must not repeat a riskClass and path ` +
        `pair; two authorizations for one decision leave no single audit record`,
    );
  }

  // Absent stays absent: "no mutation step declared" and "this manifest
  // predates the member" are the same fact to every reader (#303 B-04).
  const mutationReport =
    input.mutationReport === undefined
      ? undefined
      : normalizeMutationReport(input.mutationReport, source);

  return {
    version: 1,
    selectedSlices,
    migrationPrefixes,
    protectedIssues,
    protectedChangeWaivers,
    ...(mutationReport !== undefined ? { mutationReport } : {}),
  };
}

/**
 * One equality rule for slice numbers: `"2"` and `"02"` are the same
 * slice. A non-numeric number is compared verbatim — `Number("1a")` is
 * `NaN`, which would make every non-numeric number equal to every
 * other and open a fail-closed gate.
 */
export function canonicalSliceNumber(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  return String(Number(value));
}

/**
 * Fail closed when a slice selection reaches outside the manifest's
 * `selectedSlices`. Every scope funnel — CLI flags and persisted run
 * scope (`cli-run-scope.ts`), `runPipeline` — shares this comparison,
 * with slice numbers normalised so `"2"` and `"02"` agree; only how the
 * conflict is named differs, so the caller supplies the message.
 */
export function assertWithinManifestScope<T>(args: {
  selectedSlices: readonly string[];
  candidates: readonly T[];
  sliceNumberOf: (candidate: T) => string;
  describeConflict: (conflicting: T[]) => string;
}): void {
  const allowed = new Set(args.selectedSlices.map(canonicalSliceNumber));
  const conflicting = args.candidates.filter(
    (candidate) =>
      !allowed.has(canonicalSliceNumber(args.sliceNumberOf(candidate))),
  );
  if (conflicting.length > 0) {
    throw new Error(args.describeConflict(conflicting));
  }
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

  // Spread, never rebuilt field by field: this rewrite is about migration
  // prefixes, so every other declared member — waivers, and the mutation step
  // (#303 B-05) — has to survive it byte for byte.
  const next = { ...manifest, migrationPrefixes };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { changed: true, manifest: next };
}
