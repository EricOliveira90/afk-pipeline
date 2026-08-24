import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pre-ship sanity gate steps, in order. Each step maps to a `package.json`
 * script name and a fallback. Steps whose primary AND fallback are absent
 * are skipped.
 */
const SANITY_STEPS: ReadonlyArray<{
  name: string;
  scripts: ReadonlyArray<string>;
}> = [
  { name: "typecheck", scripts: ["typecheck"] },
  { name: "lint", scripts: ["lint"] },
  { name: "tests", scripts: ["test:run", "test"] },
];

function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const pkgRaw = readFileSync(join(cwd, "package.json"), "utf-8");
    return (JSON.parse(pkgRaw).scripts ?? {}) as Record<string, string>;
  } catch {
    return null;
  }
}

export interface SanityStepScript {
  name: string;
  scriptName: string | undefined;
}

/** Resolve the ordered baseline script set shared by slice and aggregate gates. */
export function resolveSanityStepScripts(cwd: string): SanityStepScript[] {
  const scripts = readPackageScripts(cwd) ?? {};
  return SANITY_STEPS.map((step) => ({
    name: step.name,
    scriptName: step.scripts.find((script) => scripts[script] != null),
  }));
}

/**
 * Resolves the consumer project's test command from its `package.json`.
 * Prefers `test:run` over `test`.
 */
export function resolveTestCommand(cwd: string): string | undefined {
  const scripts = readPackageScripts(cwd);
  if (!scripts) return undefined;
  const scriptName = ["test:run", "test"].find((s) => scripts[s] != null);
  return scriptName ? `pnpm ${scriptName}` : undefined;
}

/**
 * Returns the exact commands the pre-ship sanity gate executes. Evaluator QA
 * consumes this same list so the two checks cannot drift (ADR 0012).
 */
export function resolveSanityCommands(cwd: string): string[] {
  const commands: string[] = [];
  for (const { scriptName } of resolveSanityStepScripts(cwd)) {
    if (scriptName) commands.push(`pnpm run ${scriptName}`);
  }
  return commands;
}

export interface PreShipSanityResult {
  ok: boolean;
  failures: string[];
}

/**
 * Runs typecheck, lint, and tests against the merged feature branch. Missing
 * scripts are skipped; failures are collected so the summary names every
 * failed step.
 */
export function runPreShipSanity(cwd: string): PreShipSanityResult {
  const failures: string[] = [];
  for (const { name, scriptName } of resolveSanityStepScripts(cwd)) {
    if (!scriptName) continue;
    try {
      execFileSync("pnpm", ["run", scriptName], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      failures.push(name);
    }
  }
  return { ok: failures.length === 0, failures };
}
