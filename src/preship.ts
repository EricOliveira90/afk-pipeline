import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateFailureKind } from "./gate-runner.js";

/**
 * One command the sanity gate runs. `name` is the operator-facing step name
 * that lands in `failures` and in the run summary.
 */
export interface SanityCommand {
  name: string;
  command: string;
  args: readonly string[];
}

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

/**
 * The install that makes the sanity steps runnable at all. A review or slice
 * worktree is a fresh `git worktree add` with no `node_modules`, so every
 * `pnpm run` there fails instantly and the gate reads the environment gap as
 * a red suite (#101). Run unconditionally rather than guarded on
 * `existsSync("node_modules")`: a partial or stale tree (an aborted earlier
 * install, `.pnpm` stragglers — a documented Windows condition, see
 * `git.ts`) passes an existence check and reproduces the bug. `pnpm install
 * --frozen-lockfile` is itself the lockfile-state check, and is near-free
 * when the store is already satisfied.
 */
const SANITY_PREPARE_STEP: SanityCommand = {
  name: "install",
  command: "pnpm",
  args: ["install", "--frozen-lockfile"],
};

function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const pkgRaw = readFileSync(join(cwd, "package.json"), "utf-8");
    return (JSON.parse(pkgRaw).scripts ?? {}) as Record<string, string>;
  } catch {
    return null;
  }
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
 * Everything the sanity gate executes against a checkout, in order: the
 * dependency install that makes the steps runnable, then the steps
 * themselves.
 *
 * This is the single source ADR 0012 requires. `resolveSanityCommands`
 * (evaluator QA's `{{SANITY_COMMANDS}}`), `resolveBaseGateDeclarations`, and
 * `runPreShipSanity` all read this one plan, so QA cannot be told a
 * different command set than the gate runs.
 */
export interface SanityPlan {
  /**
   * Dependency install, present only for a pnpm project (a checked-in
   * `pnpm-lock.yaml`) that has at least one sanity step to run. A consumer
   * on another package manager is left alone rather than handed a `pnpm
   * install` that would misinstall or fail.
   */
  prepare?: SanityCommand;
  steps: SanityCommand[];
}

export function resolveSanityPlan(cwd: string): SanityPlan {
  const scripts = readPackageScripts(cwd);
  if (!scripts) return { steps: [] };
  const steps: SanityCommand[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = step.scripts.find((s) => scripts[s] != null);
    if (scriptName) {
      steps.push({ name: step.name, command: "pnpm", args: ["run", scriptName] });
    }
  }
  // Nothing to run means nothing to prepare — a project without sanity
  // scripts must not pay (or fail) an install.
  if (steps.length === 0) return { steps: [] };
  if (!existsSync(join(cwd, "pnpm-lock.yaml"))) return { steps };
  return { prepare: SANITY_PREPARE_STEP, steps };
}

/** Renders one plan entry the way an operator (or agent) would type it. */
function formatSanityCommand(entry: SanityCommand): string {
  return [entry.command, ...entry.args].join(" ");
}

/**
 * Returns the exact commands the pre-ship sanity gate executes. Evaluator QA
 * consumes this same list so the two checks cannot drift (ADR 0012).
 */
export function resolveSanityCommands(cwd: string): string[] {
  const plan = resolveSanityPlan(cwd);
  const entries = plan.prepare ? [plan.prepare, ...plan.steps] : plan.steps;
  return entries.map(formatSanityCommand);
}

/**
 * How one sanity command ended. Mirrors the gate-runner's execution
 * classification: a command that ran and exited non-zero is a failure of the
 * reviewed tree; a command that could never be spawned (`pnpm` absent from
 * PATH) is a failure of the environment.
 */
export interface SanityCommandOutcome {
  outcome: "EXITED" | "SPAWN_ERROR";
  exitCode: number | null;
  /** Command output, captured when the caller asked for it. */
  output?: string;
}

/**
 * Subprocess seam for the sanity commands. Production uses `execFileSync`;
 * direct tests inject a deterministic runner so no suite pays a real
 * registry install (ADR 0033).
 */
export type SanityCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; capture: boolean },
) => SanityCommandOutcome;

const defaultRunCommand: SanityCommandRunner = (command, args, options) => {
  try {
    // Steps stream to the launcher's stdout as they always have; only the
    // install is captured, so its diagnostic can reach the run log (#101).
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf-8",
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    return { outcome: "EXITED", exitCode: 0, output: stdout ?? undefined };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      stdout?: unknown;
      stderr?: unknown;
    };
    const output = [failure?.stdout, failure?.stderr]
      .map((stream) => (typeof stream === "string" ? stream : ""))
      .join("");
    // `status` is set when the child ran and exited. When it is absent the
    // child never started (ENOENT — `pnpm` is not installed), which the
    // gate-runner classifies as CONFIGURATION rather than COMMAND.
    if (typeof failure?.status === "number") {
      return { outcome: "EXITED", exitCode: failure.status, output };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "SPAWN_ERROR", exitCode: null, output: output || message };
  }
};

/**
 * Verdict from the pre-ship sanity gate (dependency install, then typecheck +
 * lint + test suite run against the merged feature branch, before opening the
 * PR). `failures` lists which steps tripped (e.g. `["lint"]`); empty when `ok`
 * is true.
 */
export interface SanityGateResult {
  ok: boolean;
  failures: string[];
  /**
   * Why the gate failed, in the gate-runner vocabulary shared with the
   * per-slice base gates (#101): `"COMMAND"` — the reviewed tree is red;
   * `"CONFIGURATION"` — the commands never really ran, because the
   * environment could not be prepared. `null` when the gate passed.
   */
  failureKind: GateFailureKind;
  /**
   * Operator-facing diagnostic for a CONFIGURATION failure: the command that
   * could not run plus a tail of its own output. Single line, so it is safe
   * in both `run.log` and `run-summary.md`.
   */
  detail?: string;
}

/** Last few non-empty output lines, flattened onto one line. */
function outputTail(output: string, maxLines = 5, maxChars = 500): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-maxLines).join(" | ");
  return tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
}

function configurationFailure(
  entry: SanityCommand,
  result: SanityCommandOutcome,
): SanityGateResult {
  const cause =
    result.outcome === "SPAWN_ERROR"
      ? "could not be spawned"
      : `failed (exit ${result.exitCode})`;
  const tail = outputTail(result.output ?? "");
  return {
    ok: false,
    failures: [entry.name],
    failureKind: "CONFIGURATION",
    detail: `${formatSanityCommand(entry)} ${cause}${tail ? `: ${tail}` : ""}`,
  };
}

/**
 * Installs dependencies, then runs typecheck, lint, and tests against the
 * merged feature branch. Missing scripts are skipped; step failures are
 * collected so the summary names every failed step. A failure that means the
 * commands never really ran — the install failed, or `pnpm` itself is absent
 * — is reported as CONFIGURATION so an operator can tell a broken environment
 * from a red suite (#101).
 */
export function runPreShipSanity(
  cwd: string,
  runCommand: SanityCommandRunner = defaultRunCommand,
): SanityGateResult {
  const plan = resolveSanityPlan(cwd);
  if (plan.steps.length === 0) {
    return { ok: true, failures: [], failureKind: null };
  }

  if (plan.prepare) {
    const prepared = runCommand(plan.prepare.command, plan.prepare.args, {
      cwd,
      capture: true,
    });
    if (prepared.outcome === "SPAWN_ERROR" || prepared.exitCode !== 0) {
      return configurationFailure(plan.prepare, prepared);
    }
  }

  const failures: string[] = [];
  for (const step of plan.steps) {
    const result = runCommand(step.command, step.args, {
      cwd,
      capture: false,
    });
    // `pnpm` missing from PATH fails every step for the same environmental
    // reason; report it once, as configuration, instead of blaming the tree.
    if (result.outcome === "SPAWN_ERROR") {
      return configurationFailure(step, result);
    }
    if (result.exitCode !== 0) failures.push(step.name);
  }
  return failures.length === 0
    ? { ok: true, failures: [], failureKind: null }
    : { ok: false, failures, failureKind: "COMMAND" };
}
