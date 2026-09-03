import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateDeclaration } from "./gate-runner.js";

interface RelatedGateConfig {
  command: string;
  args: string[];
  expectedCostMs: number;
  timeoutMs: number;
}

interface RelatedGateMapping {
  patterns: string[];
  gates: string[];
}

interface RelatedGateCoverage {
  pattern: string;
  fallbackGates: string[];
}

export interface RelatedGatePolicy {
  gates: ReadonlyMap<string, RelatedGateConfig>;
  mappings: readonly RelatedGateMapping[];
  coverage: readonly RelatedGateCoverage[];
}

type JsonRecord = Record<string, unknown>;

export function loadRelatedGatePolicy(
  repoRoot: string,
): RelatedGatePolicy | null {
  const path = join(repoRoot, "afk.config.json");
  if (!existsSync(path)) return null;
  const root = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const related = record(root, path).relatedGates;
  return related === undefined ? null : parseRelatedGatePolicy(related, path);
}

export function parseRelatedGatePolicy(
  value: unknown,
  source = "relatedGates",
): RelatedGatePolicy {
  const input = record(value, source);
  const gateInput = record(input.gates, `${source}.gates`);
  const gates = new Map<string, RelatedGateConfig>();
  for (const [id, raw] of Object.entries(gateInput)) {
    if (id.trim() === "") throw new Error(`${source}.gates has a blank gate id`);
    const gate = record(raw, `${source}.gates.${id}`);
    const command = nonBlank(gate.command, `${source}.gates.${id}.command`);
    const args = stringArray(gate.args, `${source}.gates.${id}.args`);
    const expectedCostMs = positiveInteger(
      gate.expectedCostMs,
      `${source}.gates.${id}.expectedCostMs`,
    );
    const timeoutMs = positiveInteger(
      gate.timeoutMs,
      `${source}.gates.${id}.timeoutMs`,
    );
    gates.set(id, { command, args, expectedCostMs, timeoutMs });
  }

  const mappings = array(input.mappings, `${source}.mappings`).map(
    (raw, index): RelatedGateMapping => {
      const mapping = record(raw, `${source}.mappings[${index}]`);
      const patterns = nonBlankArray(
        mapping.patterns,
        `${source}.mappings[${index}].patterns`,
      );
      const gateIds = nonBlankArray(
        mapping.gates,
        `${source}.mappings[${index}].gates`,
      );
      for (const id of gateIds) {
        if (!gates.has(id)) {
          throw new Error(
            `${source}.mappings[${index}] names unknown gate "${id}"`,
          );
        }
      }
      return { patterns, gates: gateIds };
    },
  );

  const coverage = array(input.coverage, `${source}.coverage`).map(
    (raw, index): RelatedGateCoverage => {
      const entry = record(raw, `${source}.coverage[${index}]`);
      const pattern = nonBlank(
        entry.pattern,
        `${source}.coverage[${index}].pattern`,
      );
      const fallbackGates =
        entry.fallbackGates === undefined
          ? []
          : nonBlankArray(
              entry.fallbackGates,
              `${source}.coverage[${index}].fallbackGates`,
            );
      for (const id of fallbackGates) {
        if (!gates.has(id)) {
          throw new Error(
            `${source}.coverage[${index}] names unknown fallback gate "${id}"`,
          );
        }
      }
      return { pattern, fallbackGates };
    },
  );

  return { gates, mappings, coverage };
}

export function selectRelatedGateDeclarations(
  policy: RelatedGatePolicy | null,
  paths: {
    lockedPaths: readonly string[];
    changedPaths: readonly string[];
  },
): GateDeclaration[] {
  if (!policy) return [];
  const selected = new Set<string>();
  const inputs = new Set(
    [...paths.lockedPaths, ...paths.changedPaths].map(normalizePath),
  );

  for (const path of inputs) {
    let matched = false;
    for (const mapping of policy.mappings) {
      if (!mapping.patterns.some((pattern) => matches(pattern, path))) continue;
      matched = true;
      for (const id of mapping.gates) selected.add(id);
    }
    if (matched) continue;
    const coverage = policy.coverage.find((entry) =>
      matches(entry.pattern, path),
    );
    if (!coverage) continue;
    if (coverage.fallbackGates.length === 0) {
      throw new Error(
        `Path "${path}" is under related-gate coverage but has no ` +
          `related-gate mapping or fallback`,
      );
    }
    for (const id of coverage.fallbackGates) selected.add(id);
  }

  return [...selected].map((id) => {
    const gate = policy.gates.get(id)!;
    return {
      id,
      stage: "related",
      required: true,
      command: gate.command,
      args: [...gate.args],
      expectedCostMs: gate.expectedCostMs,
      wallClockTimeoutMs: gate.timeoutMs,
    };
  });
}

function normalizePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path.toLowerCase();
}

function matches(pattern: string, normalizedPath: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index++) {
    const char = normalizedPattern[index]!;
    if (char === "*" && normalizedPattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(normalizedPath);
}

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-blank string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return [...value];
}

function nonBlankArray(value: unknown, field: string): string[] {
  const values = stringArray(value, field);
  if (values.length === 0 || values.some((item) => item.trim() === "")) {
    throw new Error(`${field} must contain non-blank strings`);
  }
  return values;
}

function positiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
