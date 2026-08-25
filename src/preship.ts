import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

interface PackageManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageManifest(cwd: string): PackageManifest | null {
  try {
    const pkgRaw = readFileSync(join(cwd, "package.json"), "utf-8");
    return JSON.parse(pkgRaw) as PackageManifest;
  } catch {
    return null;
  }
}

function readPackageScripts(cwd: string): Record<string, string> | null {
  const pkg = readPackageManifest(cwd);
  return pkg ? (pkg.scripts ?? {}) : null;
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
  const scripts = readPackageScripts(cwd);
  if (!scripts) return [];
  const commands: string[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = step.scripts.find((s) => scripts[s] != null);
    if (scriptName) commands.push(`pnpm run ${scriptName}`);
  }
  return commands;
}

export interface PreShipSanityResult {
  ok: boolean;
  failures: string[];
  /**
   * Set when the sanity environment could not be prepared (the dependency
   * install failed). `failures` then names the install step, and the
   * blocker is a configuration failure of the environment — not a code
   * failure of the reviewed tree (#101).
   */
  configurationFailure?: string;
}

/**
 * Prepare the checkout so the sanity commands can actually run. The ship
 * gate's scratch review worktree is a fresh `git worktree add` with no
 * `node_modules`, so `pnpm run typecheck` there fails instantly and the
 * gate misreports the environment gap as a code failure (#101). Install
 * dependencies when the project declares any and the checkout has none;
 * checkouts that already carry `node_modules` (an existing feature-branch
 * checkout, a slice worktree a generator worked in) are left untouched.
 */
function ensureSanityDependencies(
  cwd: string,
): { ok: true } | { ok: false; detail: string } {
  if (existsSync(join(cwd, "node_modules"))) return { ok: true };
  const pkg = readPackageManifest(cwd);
  const declaresDependencies =
    Object.keys(pkg?.dependencies ?? {}).length > 0 ||
    Object.keys(pkg?.devDependencies ?? {}).length > 0;
  if (!declaresDependencies) return { ok: true };

  // Prefer a reproducible install when the lockfile is checked in; a
  // project without one still gets a plain install rather than a
  // guaranteed --frozen-lockfile failure.
  const installArgs = existsSync(join(cwd, "pnpm-lock.yaml"))
    ? ["install", "--frozen-lockfile"]
    : ["install"];
  try {
    execFileSync("pnpm", installArgs, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "inherit", "inherit"],
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `pnpm ${installArgs.join(" ")} failed: ${message}` };
  }
}

/**
 * Runs typecheck, lint, and tests against the merged feature branch. Missing
 * scripts are skipped; failures are collected so the summary names every
 * failed step.
 */
export function runPreShipSanity(cwd: string): PreShipSanityResult {
  const scripts = readPackageScripts(cwd);
  if (!scripts) return { ok: true, failures: [] };

  const install = ensureSanityDependencies(cwd);
  if (!install.ok) {
    return {
      ok: false,
      failures: ["install"],
      configurationFailure: install.detail,
    };
  }

  const failures: string[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = step.scripts.find((s) => scripts[s] != null);
    if (!scriptName) continue;
    try {
      execFileSync("pnpm", ["run", scriptName], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      failures.push(step.name);
    }
  }
  return { ok: failures.length === 0, failures };
}
