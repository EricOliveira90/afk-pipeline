import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
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
 * One `package.json` script as a runnable step, for a gate that is declared
 * outside the sanity plan (#86 B-02). Deliberately **not** a `SanityPlan`
 * member and deliberately not reachable from {@link resolveSanityCommands} or
 * {@link resolveCandidateQACommands}: `test:budgets` is a wall-clock budget,
 * and ADR 0063 requires that a red budget cannot fail the pre-ship gate or
 * candidate QA. `SANITY_STEPS` stays as it is, so the three readers that know
 * nothing about `GateDeclaration` never see this command; that absence, not a
 * declaration field, is what honours the ADR.
 *
 * `null` when the project declares no such script — an absent script yields no
 * declaration at all rather than a commandless one.
 */
export function resolveScriptStep(
  cwd: string,
  scriptName: string,
): SanityCommand | null {
  const scripts = readPackageScripts(cwd);
  if (!scripts || scripts[scriptName] == null) return null;
  return { name: scriptName, command: "pnpm", args: ["run", scriptName] };
}

/**
 * One entry of the cheap-gate catalog `src/base-gates.ts` resolves: a gate
 * whose `expectedCostMs` is at or below the policy's `cheapThresholdMs`.
 * Structural, and passed in as a parameter rather than imported, because
 * `src/base-gates.ts` imports this module and the dependency may not reverse
 * (#86 B-05).
 */
export interface CheapGate {
  id: string;
  required: boolean;
  command?: string;
  args?: readonly string[];
}

/** Renders one cheap-gate entry the way an operator would type it. */
function formatCheapGate(gate: CheapGate): string {
  return [gate.command, ...(gate.args ?? [])].join(" ");
}

/**
 * `pnpm <script>` and `pnpm run <script>` are the same instruction, so they
 * must compare equal: an override written the short way is not an omission.
 * Whitespace is collapsed for the same reason.
 */
function normalizeCommandSegment(segment: string): string {
  const collapsed = segment.trim().replace(/\s+/g, " ");
  return collapsed.replace(/^(\S+) run (\S.*)$/, "$1 $2");
}

/** Required cheap gates that carry a resolved command, in gate order. */
function requiredCheapCommands(
  catalog: readonly CheapGate[],
): { id: string; command: string }[] {
  return catalog
    .filter((gate) => gate.required && gate.command != null)
    .map((gate) => ({ id: gate.id, command: formatCheapGate(gate) }));
}

/**
 * The gate ids an override fails to cover: a required cheap gate whose own
 * resolved command is absent from the override's `&&`-separated segments.
 * Empty means the override is accepted.
 *
 * The check is over **gate ids, not over the derived command string** (#86
 * B-05). Segments naming no cheap gate are permitted and unvalidated, because
 * which extra fast subset the generator iterates on is ADR 0038's decision —
 * so `--test-command "pnpm run typecheck && pnpm test:fast"` is accepted while
 * `--test-command "pnpm test:fast"` alone is refused naming `typecheck`.
 */
export function uncoveredCheapGateIds(
  catalog: readonly CheapGate[],
  override: string,
): string[] {
  const segments = new Set(
    override.split("&&").map(normalizeCommandSegment).filter(Boolean),
  );
  return requiredCheapCommands(catalog)
    .filter(({ command }) => !segments.has(normalizeCommandSegment(command)))
    .map(({ id }) => id);
}

/**
 * The command the generator is told to verify with while it iterates —
 * deliberately a separate decision from `resolveSanityPlan` below, which
 * owns what the gate executes and what QA is told to run. ADR 0038 has
 * the reasoning; ADR 0012 has why the gate's answer stays put.
 *
 * With no override the command is **derived from the cheap-gate catalog**
 * (#86 B-05, D18): the required cheap gates' own commands joined with ` && ` in
 * gate order. The full-suite `tests` gate is not in that catalog, so a ~7
 * minute suite never enters an edit cycle. For this repo, which declares no
 * `lint` script, that is exactly `pnpm run typecheck`.
 *
 * An override is validated rather than passed through, and refused naming the
 * required cheap gates it omits (see {@link uncoveredCheapGateIds}). `cwd`
 * stays the first parameter for the one case the catalog cannot answer: a
 * project with no cheap gate at all keeps today's forgiving fallback to its own
 * test script, then `pnpm test`.
 */
export function resolveGeneratorTestCommand(
  cwd: string,
  catalog: readonly CheapGate[],
  override?: string,
): string {
  if (override !== undefined) {
    const uncovered = uncoveredCheapGateIds(catalog, override);
    if (uncovered.length > 0) {
      throw new Error(
        `--test-command "${override}" does not cover required cheap ` +
          `${uncovered.length === 1 ? "gate" : "gates"} ` +
          `${uncovered.join(", ")}. The generator's verification command may ` +
          `add a faster subset, but it may not drop a gate the candidate must ` +
          `pass; the derived command is ` +
          `"${requiredCheapCommands(catalog)
            .map(({ command }) => command)
            .join(" && ")}".`,
      );
    }
    return override;
  }
  const derived = requiredCheapCommands(catalog)
    .map(({ command }) => command)
    .join(" && ");
  return derived || resolveTestCommand(cwd) || "pnpm test";
}

/**
 * Everything the sanity gate executes against a checkout, in order: the
 * dependency install that makes the steps runnable, then the steps
 * themselves.
 *
 * This is the single source ADR 0012 requires. `resolveSanityCommands`
 * (evaluator QA's `{{SANITY_COMMANDS}}`), the base-gate catalog, and
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
  /**
   * Steps this project declares no script for, so the gate will not run them
   * (#238). Skipping stays the intended behaviour — what was missing is the
   * record. Without it a check that did not run is indistinguishable from one
   * that passed, and this repo is the live example: it has no `lint` script, so
   * its `lint` step has never run and every green pre-ship gate in its history
   * reads as three steps passing when it was two.
   *
   * Deliberately beside `steps` rather than inside it: every reader of `steps`
   * treats a member as something to execute, and a skipped entry carries no
   * command. The vocabulary is `GateStatus`'s `"SKIPPED"` plus
   * `gateStatusCell`'s prerequisite annotation — "it cost nothing, and here is
   * why" — and *not* `skip-gate.ts`'s `tests:skipped`, which despite the name is
   * a gate that FAILS when a candidate disables tests, not a record of a check
   * that declined to run.
   */
  skipped: readonly SkippedSanityStep[];
}

/**
 * One sanity step the project declares no script for, with the script names the
 * plan looked for — so the record can say what was absent, not merely that
 * something was.
 */
export interface SkippedSanityStep {
  name: string;
  scripts: readonly string[];
}

export function resolveSanityPlan(cwd: string): SanityPlan {
  const scripts = readPackageScripts(cwd);
  const steps: SanityCommand[] = [];
  const skipped: SkippedSanityStep[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = scripts
      ? step.scripts.find((s) => scripts[s] != null)
      : undefined;
    if (scriptName) {
      steps.push({ name: step.name, command: "pnpm", args: ["run", scriptName] });
    } else {
      // An absent or unreadable `package.json` declares no script either, so its
      // steps are skipped for the same reason and recorded the same way.
      skipped.push({ name: step.name, scripts: step.scripts });
    }
  }
  // Nothing to run means nothing to prepare — a project without sanity
  // scripts must not pay (or fail) an install.
  if (steps.length === 0) return { steps: [], skipped };
  if (!existsSync(join(cwd, "pnpm-lock.yaml"))) return { steps, skipped };
  return { prepare: SANITY_PREPARE_STEP, steps, skipped };
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
 * Commands candidate QA may need before it judges behavior.
 *
 * The full test suite is deliberately absent: the orchestrator runs it only
 * after candidate QA accepts the exact candidate tree. This is the narrow
 * early delivery of M6's test:related/test:full sequencing; the policy-owned
 * gate catalog and automatic related-test selection remain PRD 4 work.
 */
export function resolveCandidateQACommands(cwd: string): string[] {
  const plan = resolveSanityPlan(cwd);
  const cheapSteps = plan.steps.filter((step) => step.name !== "tests");
  const entries =
    plan.prepare && cheapSteps.length > 0
      ? [plan.prepare, ...cheapSteps]
      : cheapSteps;
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
  /**
   * The signal that killed the child, on a platform that reports one. POSIX's
   * analogue of a Windows crash-range exit code: `execFileSync` leaves `status`
   * null and sets `signal` when a child dies by SIGSEGV or SIGKILL, so without
   * this field a signal death is indistinguishable from a child that never
   * started (#272).
   */
  signal?: string | null;
}

/**
 * Subprocess seam for the sanity commands. Production uses `execFileSync`;
 * direct tests inject a deterministic runner so no suite pays a real
 * registry install (ADR 0033).
 *
 * `logPath`, when set, is where the child's stdout and stderr go instead of the
 * launcher's console — see {@link RunPreShipSanityOptions.stepLogDir}. An
 * injected runner may ignore it.
 */
export type SanityCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; capture: boolean; logPath?: string },
) => SanityCommandOutcome;

const defaultRunCommand: SanityCommandRunner = (command, args, options) => {
  // A step's output goes to its own log file when the caller named one, so a
  // red step can cite a path instead of sending an operator to grep the
  // launcher's stdout (#272). The child appends as it runs, so the file is
  // tailable live — but if it cannot be opened, streaming is the better
  // failure: the gate must still run.
  let logFd: number | undefined;
  if (options.logPath) {
    try {
      logFd = openSync(options.logPath, "w");
    } catch {
      logFd = undefined;
    }
  }
  try {
    // Steps stream to the launcher's stdout as they always have unless a log
    // file was named; only the install is captured, so its diagnostic can
    // reach the run log (#101).
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf-8",
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : logFd !== undefined
          ? ["ignore", logFd, logFd]
          : ["ignore", "inherit", "inherit"],
    });
    return { outcome: "EXITED", exitCode: 0, output: stdout ?? undefined };
  } catch (error) {
    const failure = error as {
      status?: number | null;
      signal?: string | null;
      stdout?: unknown;
      stderr?: unknown;
    };
    const output = [failure?.stdout, failure?.stderr]
      .map((stream) => (typeof stream === "string" ? stream : ""))
      .join("");
    // `status` is set when the child ran and exited. When it is absent the
    // child never started (ENOENT — `pnpm` is not installed), which the
    // gate-runner classifies as CONFIGURATION rather than COMMAND — unless a
    // signal is reported, which means the child ran and was killed.
    if (typeof failure?.status === "number") {
      // `undefined`, not `""`: with the child's streams pointed at a log file
      // (or inherited) there is no captured output at all, and a caller must be
      // able to tell that from a command that printed nothing.
      return { outcome: "EXITED", exitCode: failure.status, output: output || undefined };
    }
    if (typeof failure?.signal === "string" && failure.signal) {
      return {
        outcome: "EXITED",
        exitCode: null,
        output,
        signal: failure.signal,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: "SPAWN_ERROR", exitCode: null, output: output || message };
  } finally {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // Best effort — the child's output is already on disk.
      }
    }
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
   * environment could not be prepared. `null` when the gate passed, and also
   * when {@link SanityGateResult.terminationKind} is set: a process the OS
   * killed is neither of the two, exactly as `classifyExecution` pairs its
   * `INFRASTRUCTURE` status with `failureKind: null`.
   */
  failureKind: GateFailureKind;
  /**
   * Set when a command was terminated abnormally instead of deciding to fail
   * (#272): a Windows crash-range exit code, or a POSIX signal death. Local to
   * this gate on purpose — widening the shared `GateFailureKind` union would
   * ripple into the gate-evidence validator, the run-event type and every gate
   * reader for one gate's benefit.
   *
   * The operator action it recommends is a relaunch, and the gate still blocks:
   * it never retries itself.
   */
  terminationKind?: "ABNORMAL_EXIT";
  /**
   * Operator-facing diagnostic for a failure: the command that could not run
   * plus a tail of its own output, or — for a red step whose output was
   * captured to a file — the failing step, its exit code and that file's path.
   * Single line, so it is safe in both `run.log` and `run-summary.md`.
   */
  detail?: string;
  /**
   * The plan's skipped steps, so a gate that ran two checks cannot read as a
   * gate that ran three (#238). Always present — empty when the project
   * declares every script — because an absent field would reintroduce exactly
   * the ambiguity it exists to remove.
   */
  skipped: readonly SkippedSanityStep[];
}

/**
 * The base of the Windows NTSTATUS *error* range: a process whose exit code has
 * this bit pattern was terminated by the operating system, not by its own
 * `exit()`. `0xC0000374` (3221226356) is `STATUS_HEAP_CORRUPTION`, the exit that
 * #272 was filed for.
 */
const NTSTATUS_ERROR_BASE = 0xc0000000;

/** The crash codes worth naming, so a summary line does not need a lookup. */
const NTSTATUS_NAMES: ReadonlyMap<number, string> = new Map([
  [0xc0000005, "STATUS_ACCESS_VIOLATION"],
  [0xc00000fd, "STATUS_STACK_OVERFLOW"],
  [0xc000013a, "STATUS_CONTROL_C_EXIT"],
  [0xc0000374, "STATUS_HEAP_CORRUPTION"],
  [0xc0000409, "STATUS_STACK_BUFFER_OVERRUN"],
]);

/**
 * Whether an exit code means the process was *killed* rather than that the check
 * it ran decided to fail (#272).
 *
 * Two shapes, one per platform family:
 * - Windows: an exit code at or above `0xC0000000` as unsigned is an NTSTATUS
 *   error — `0xC0000374` heap corruption, `0xC0000005` access violation,
 *   `0xC000013A` Ctrl-C. No tool chooses to exit with one, and the codes are
 *   far outside the 0-255 range a real verdict uses, so the test is safe to run
 *   on every platform.
 * - POSIX: a shell reports a signal death as `128 + signo`, so 129-192 (signal
 *   numbers run to `SIGRTMAX`) is a killed child. Bounded at 192 so a plain
 *   255 — a common generic error code — stays a verdict, and gated on the
 *   platform because a Windows tool may legitimately exit 130.
 *
 * `pnpm` exit 1 (a lockfile mismatch) stays false: that is a real, reproducible
 * configuration fault an operator must fix, and the whole point of the split is
 * that the two need opposite responses.
 */
export function isAbnormalTerminationExit(
  code: number | null,
  platform: string = process.platform,
): boolean {
  if (code == null || !Number.isInteger(code)) return false;
  if ((code >>> 0) >= NTSTATUS_ERROR_BASE) return true;
  return platform !== "win32" && code > 128 && code <= 192;
}

/** Whether one outcome is a killed process rather than a reported verdict. */
function isAbnormalTermination(result: SanityCommandOutcome): boolean {
  if (result.signal) return true;
  return result.outcome === "EXITED" && isAbnormalTerminationExit(result.exitCode);
}

/** `exit 3221226356 = 0xC0000374 STATUS_HEAP_CORRUPTION` */
function formatAbnormalExit(code: number): string {
  const unsigned = code >>> 0;
  const name = NTSTATUS_NAMES.get(unsigned);
  const hex =
    unsigned >= NTSTATUS_ERROR_BASE
      ? ` = 0x${unsigned.toString(16).toUpperCase()}${name ? ` ${name}` : ""}`
      : "";
  return `exit ${code}${hex}`;
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

/**
 * The end of a step's log file, bounded: a suite log can be megabytes and only
 * its last lines carry the verdict.
 */
function readLogTail(path: string, maxBytes = 8192): string {
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf-8");
  } catch {
    return "";
  }
}

function configurationFailure(
  entry: SanityCommand,
  result: SanityCommandOutcome,
  skipped: readonly SkippedSanityStep[],
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
    skipped,
  };
}

/**
 * A command the operating system killed. Not CONFIGURATION: that class asserts
 * the operator's environment is at fault and sends them to fix their tree,
 * which is exactly the wrong instruction for a heap corruption under memory
 * pressure that a plain relaunch clears (#272).
 *
 * The output tail is deliberately dropped. The reported incident attached
 * pnpm's `Ignored build scripts … pnpm approve-builds` warning box as the
 * cause — text that project prints on every *successful* install too — and an
 * operator spent the time it invited. When the exit code is the diagnosis,
 * trailing output that also appears in green runs is worse than nothing.
 */
function abnormalTerminationFailure(
  entry: SanityCommand,
  result: SanityCommandOutcome,
  skipped: readonly SkippedSanityStep[],
): SanityGateResult {
  const how = result.signal
    ? `was killed by ${result.signal}`
    : `terminated abnormally (${formatAbnormalExit(result.exitCode ?? 0)})`;
  return {
    ok: false,
    failures: [entry.name],
    failureKind: null,
    terminationKind: "ABNORMAL_EXIT",
    detail:
      `${formatSanityCommand(entry)} ${how} — the process was killed rather ` +
      `than reporting a verdict, so this is the machine and not the tree; ` +
      `relaunch the run`,
    skipped,
  };
}

/** Where one step's captured output lands, inside `stepLogDir`. */
function stepLogPath(
  stepLogDir: string | undefined,
  step: SanityCommand,
): string | undefined {
  if (!stepLogDir) return undefined;
  const safeName = step.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 24);
  return join(stepLogDir, `sanity-${safeName || "step"}.log`);
}

export interface RunPreShipSanityOptions {
  /**
   * Directory the steps' stdout and stderr are captured into, one
   * `sanity-<step>.log` per step. Absent — every direct test, and any caller
   * that has no run directory — leaves today's behaviour exactly as it was:
   * output streams to the launcher's console and nothing is written.
   *
   * The trade #272 asks for. Streaming a 17-30 minute suite live to the
   * launcher is what an operator watches today, so the capture keeps the output
   * live *in a file the child appends to* (tailable) and the gate announces the
   * path through {@link RunPreShipSanityOptions.onStepStart} before the step
   * runs. What it buys is a red step that names its exit code and a path,
   * instead of a bare `FAIL (tests)` that costs an operator a grep through the
   * launcher log to find 1 failure in 4916.
   */
  stepLogDir?: string;
  /**
   * Called before each step runs, with the log path when one was resolved. The
   * gate's progress line: which step is running, and where to watch it.
   */
  onStepStart?: (step: SanityCommand, logPath?: string) => void;
}

/**
 * Installs dependencies, then runs typecheck, lint, and tests against the
 * merged feature branch. Missing scripts are skipped *and recorded as skipped*
 * (#238); step failures are collected so the summary names every failed step.
 *
 * Three failure classes, because they need three different operator responses:
 * - CONFIGURATION — the commands never really ran (the install failed on a real
 *   lockfile fault, or `pnpm` is absent from PATH). Fix the environment (#101).
 * - ABNORMAL_EXIT — a command was killed by the OS (a Windows crash-range exit,
 *   a POSIX signal). Relaunch; the tree is not implicated (#272).
 * - COMMAND — the reviewed tree is red. Fix the code.
 */
export function runPreShipSanity(
  cwd: string,
  runCommand: SanityCommandRunner = defaultRunCommand,
  options: RunPreShipSanityOptions = {},
): SanityGateResult {
  const plan = resolveSanityPlan(cwd);
  const skipped = plan.skipped;
  // Every return below carries `skipped`, including this one: a project with no
  // sanity script at all is the extreme case of the gate that says nothing
  // about what it did not run.
  if (plan.steps.length === 0) {
    return { ok: true, failures: [], failureKind: null, skipped };
  }

  if (plan.prepare) {
    const prepared = runCommand(plan.prepare.command, plan.prepare.args, {
      cwd,
      capture: true,
    });
    if (isAbnormalTermination(prepared)) {
      return abnormalTerminationFailure(plan.prepare, prepared, skipped);
    }
    if (prepared.outcome === "SPAWN_ERROR" || prepared.exitCode !== 0) {
      return configurationFailure(plan.prepare, prepared, skipped);
    }
  }

  const failures: string[] = [];
  const details: string[] = [];
  for (const step of plan.steps) {
    const logPath = stepLogPath(options.stepLogDir, step);
    options.onStepStart?.(step, logPath);
    const result = runCommand(step.command, step.args, {
      cwd,
      capture: false,
      ...(logPath ? { logPath } : {}),
    });
    // `pnpm` missing from PATH fails every step for the same environmental
    // reason; report it once, as configuration, instead of blaming the tree.
    if (result.outcome === "SPAWN_ERROR") {
      return configurationFailure(step, result, skipped);
    }
    // A killed step is not a red step: stop, and say so, rather than letting a
    // crash join the failing-step list as if the suite had reported it.
    if (isAbnormalTermination(result)) {
      return abnormalTerminationFailure(step, result, skipped);
    }
    if (result.exitCode !== 0) {
      failures.push(step.name);
      // `||`, not `??`: a step whose streams went to the log file reports no
      // captured output, and an empty string must fall through to the file.
      const tail = outputTail(
        result.output || (logPath ? readLogTail(logPath) : ""),
        3,
        300,
      );
      details.push(
        `${step.name} failed (exit ${result.exitCode})` +
          `${logPath ? ` — output: ${logPath}` : ""}` +
          `${tail ? `: ${tail}` : ""}`,
      );
    }
  }
  return failures.length === 0
    ? { ok: true, failures: [], failureKind: null, skipped }
    : {
        ok: false,
        failures,
        failureKind: "COMMAND",
        detail: details.join("; "),
        skipped,
      };
}
