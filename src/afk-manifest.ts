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

  return {
    version: 1,
    selectedSlices,
    migrationPrefixes,
    protectedIssues,
    protectedChangeWaivers,
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

  const next = { ...manifest, migrationPrefixes };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { changed: true, manifest: next };
}
