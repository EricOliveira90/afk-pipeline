import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAbnormalTerminationExit,
  resolveSanityCommands,
  resolveSanityPlan,
  runPreShipSanity,
  type SanityCommand,
  type SanityCommandOutcome,
  type SanityCommandRunner,
  type SanityGateResult,
} from "./preship.js";

/**
 * Direct unit tests for the pre-ship sanity gate's classification and its
 * operator-facing detail. Deliberately its own file rather than more cases in
 * the heavy orchestrator suite (which owns `runPreShipSanity`'s older
 * scenarios): this is what one function returns, so it belongs in `test:fast`
 * where a new assertion costs milliseconds instead of joining an 800-second
 * suite (AGENTS.md assertion ladder).
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

function makeProject(
  scripts: Record<string, string>,
  options: { lockfile?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-preship-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, scripts }, null, 2)}\n`,
    "utf-8",
  );
  // The gate's install is gated on a checked-in lockfile (#101), so only
  // fixtures that opt in pay it.
  if (options.lockfile !== false) {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
  }
  return dir;
}

/**
 * The subprocess seam, injected so no test pays a real install (ADR 0033).
 * Copied rather than imported from the orchestrator suite: a shared test helper
 * would couple this file to that one's fixture lifecycle.
 */
function record(
  dir: string,
  outcomes: Record<string, SanityCommandOutcome> = {},
  options?: Parameters<typeof runPreShipSanity>[2],
): {
  ran: string[];
  logPaths: (string | undefined)[];
  announced: { step: string; logPath?: string }[];
  result: SanityGateResult;
} {
  const ran: string[] = [];
  const logPaths: (string | undefined)[] = [];
  const announced: { step: string; logPath?: string }[] = [];
  const runner: SanityCommandRunner = (command, args, runOptions) => {
    const line = [command, ...args].join(" ");
    ran.push(line);
    logPaths.push(runOptions.logPath);
    return outcomes[line] ?? { outcome: "EXITED", exitCode: 0 };
  };
  const result = runPreShipSanity(dir, runner, {
    ...options,
    onStepStart: (step: SanityCommand, logPath?: string) =>
      announced.push({ step: step.name, ...(logPath ? { logPath } : {}) }),
  });
  return { ran, logPaths, announced, result };
}

/** The exact exit code #272 was filed for: 0xC0000374, heap corruption. */
const HEAP_CORRUPTION = 3221226356;

/**
 * The warning box the reported incident attached as the *cause*. This project
 * prints it on every install, including the 1.8s green one minutes later, so
 * quoting it back is worse than saying nothing.
 */
const NON_DISCRIMINATING_TAIL =
  "╭ Warning ─────╮\n" +
  "│   Ignored build scripts: unrs-resolver@1.11.1.  │\n" +
  '│   Run "pnpm approve-builds" to pick which dependencies should be allowed │\n' +
  "╰──────────────╯\n";

describe("isAbnormalTerminationExit", () => {
  it("recognises the Windows crash range on any platform", () => {
    expect(isAbnormalTerminationExit(HEAP_CORRUPTION, "win32")).toBe(true);
    // 0xC0000005 access violation, 0xC000013A Ctrl-C.
    expect(isAbnormalTerminationExit(0xc0000005, "win32")).toBe(true);
    expect(isAbnormalTerminationExit(0xc000013a, "linux")).toBe(true);
    // Reported signed by some spawn paths; the same status word.
    expect(isAbnormalTerminationExit(-1073740940, "win32")).toBe(true);
  });

  it("leaves an ordinary non-zero verdict alone", () => {
    // pnpm's lockfile mismatch — a real configuration fault to fix, not a crash.
    expect(isAbnormalTerminationExit(1, "win32")).toBe(false);
    expect(isAbnormalTerminationExit(2, "linux")).toBe(false);
    expect(isAbnormalTerminationExit(0, "win32")).toBe(false);
    expect(isAbnormalTerminationExit(null, "win32")).toBe(false);
  });

  it("reads 128 + signo as a killed child on POSIX only", () => {
    // 139 = 128 + SIGSEGV, 137 = 128 + SIGKILL.
    expect(isAbnormalTerminationExit(139, "linux")).toBe(true);
    expect(isAbnormalTerminationExit(137, "darwin")).toBe(true);
    // A Windows tool may legitimately exit 130, and 255 is a generic error.
    expect(isAbnormalTerminationExit(130, "win32")).toBe(false);
    expect(isAbnormalTerminationExit(255, "linux")).toBe(false);
  });
});

describe("runPreShipSanity — abnormal termination (#272)", () => {
  it("does not report a crashed install as CONFIGURATION", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });

    const { ran, result } = record(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: HEAP_CORRUPTION,
        output: NON_DISCRIMINATING_TAIL,
      },
    });

    expect(ran).toEqual(["pnpm install --frozen-lockfile"]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["install"]);
    // The whole point: the environment was fine, and CONFIGURATION is the one
    // class that asserts the operator's setup is at fault.
    expect(result.failureKind).toBeNull();
    expect(result.terminationKind).toBe("ABNORMAL_EXIT");
  });

  it("names the crash code, its NTSTATUS meaning and the relaunch", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });

    const { result } = record(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: HEAP_CORRUPTION,
        output: NON_DISCRIMINATING_TAIL,
      },
    });

    expect(result.detail).toContain("pnpm install --frozen-lockfile");
    expect(result.detail).toContain("terminated abnormally");
    expect(result.detail).toContain(`exit ${HEAP_CORRUPTION}`);
    expect(result.detail).toContain("0xC0000374 STATUS_HEAP_CORRUPTION");
    expect(result.detail).toContain("relaunch the run");
  });

  it("drops the output tail that appears in green runs too", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });

    const { result } = record(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: HEAP_CORRUPTION,
        output: NON_DISCRIMINATING_TAIL,
      },
    });

    expect(result.detail).not.toContain("approve-builds");
    expect(result.detail).not.toContain("unrs-resolver");
  });

  it("still classifies a real lockfile fault as CONFIGURATION, with its diagnostic", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });

    const { result } = record(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: 1,
        output: "  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n",
      },
    });

    expect(result.failureKind).toBe("CONFIGURATION");
    expect(result.terminationKind).toBeUndefined();
    expect(result.detail).toContain("failed (exit 1)");
    expect(result.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  });

  it("leaves a spawn failure classified as CONFIGURATION", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" }, { lockfile: false });

    const { result } = record(dir, {
      "pnpm run typecheck": {
        outcome: "SPAWN_ERROR",
        exitCode: null,
        output: "spawnSync pnpm ENOENT",
      },
    });

    expect(result.failureKind).toBe("CONFIGURATION");
    expect(result.terminationKind).toBeUndefined();
    expect(result.detail).toContain("could not be spawned");
    expect(result.detail).toContain("ENOENT");
  });

  it("stops at a killed step instead of listing it beside red steps", () => {
    const dir = makeProject(
      { typecheck: "tsc --noEmit", "test:run": "vitest run" },
      { lockfile: false },
    );

    const { ran, result } = record(dir, {
      "pnpm run typecheck": { outcome: "EXITED", exitCode: HEAP_CORRUPTION },
    });

    expect(ran).toEqual(["pnpm run typecheck"]);
    expect(result.failures).toEqual(["typecheck"]);
    expect(result.terminationKind).toBe("ABNORMAL_EXIT");
    expect(result.failureKind).toBeNull();
  });

  it("reads a POSIX signal death as the same class", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" }, { lockfile: false });

    const { result } = record(dir, {
      "pnpm run typecheck": {
        outcome: "EXITED",
        exitCode: null,
        signal: "SIGKILL",
      },
    });

    expect(result.terminationKind).toBe("ABNORMAL_EXIT");
    expect(result.detail).toContain("was killed by SIGKILL");
    expect(result.detail).toContain("relaunch the run");
  });
});

describe("runPreShipSanity — naming a red step's output (#272)", () => {
  it("cites the step's log path and its tail, not just the step name", () => {
    const dir = makeProject(
      { typecheck: "tsc --noEmit", "test:run": "vitest run" },
      { lockfile: false },
    );
    const logDir = mkdtempSync(join(tmpdir(), "afk-preship-logs-"));
    tempDirs.push(logDir);

    const { result, logPaths, announced } = record(
      dir,
      {
        "pnpm run test:run": {
          outcome: "EXITED",
          exitCode: 1,
          output:
            "FAIL src/thing.test.ts > thing > holds\n" +
            "Test Files  1 failed | 359 passed (360)\n",
        },
      },
      { stepLogDir: logDir },
    );

    expect(result.failures).toEqual(["tests"]);
    expect(result.failureKind).toBe("COMMAND");
    expect(result.detail).toContain("tests failed (exit 1)");
    expect(result.detail).toContain(join(logDir, "sanity-tests.log"));
    expect(result.detail).toContain("1 failed | 359 passed");
    // The path is announced before the step runs, so an operator watching a
    // 17-30 minute suite knows where to tail it.
    expect(announced).toEqual([
      { step: "typecheck", logPath: join(logDir, "sanity-typecheck.log") },
      { step: "tests", logPath: join(logDir, "sanity-tests.log") },
    ]);
    expect(logPaths).toEqual([
      join(logDir, "sanity-typecheck.log"),
      join(logDir, "sanity-tests.log"),
    ]);
  });

  it("keeps streaming, and names no path, when no log directory is given", () => {
    const dir = makeProject({ "test:run": "vitest run" }, { lockfile: false });

    const { result, logPaths, announced } = record(dir, {
      "pnpm run test:run": { outcome: "EXITED", exitCode: 1 },
    });

    expect(logPaths).toEqual([undefined]);
    expect(announced).toEqual([{ step: "tests" }]);
    expect(result.detail).toBe("tests failed (exit 1)");
  });

  // The one case that must spawn: the file-descriptor plumbing in the default
  // runner is what writes the log an operator is told to read, and an injected
  // runner cannot prove it. One `node -e` through pnpm, no install.
  it("captures a real step's output into the cited file", () => {
    const dir = makeProject(
      { typecheck: `node -e "console.log('boom-marker');process.exit(1)"` },
      { lockfile: false },
    );
    const logDir = mkdtempSync(join(tmpdir(), "afk-preship-real-"));
    tempDirs.push(logDir);

    const result = runPreShipSanity(dir, undefined, { stepLogDir: logDir });

    const logPath = join(logDir, "sanity-typecheck.log");
    expect(result.failures).toEqual(["typecheck"]);
    expect(result.detail).toContain(logPath);
    expect(readFileSync(logPath, "utf-8")).toContain("boom-marker");
    expect(result.detail).toContain("boom-marker");
  }, 60_000);
});

describe("resolveSanityPlan — recording a skipped step (#238)", () => {
  it("records the step it dropped and the script name it looked for", () => {
    const plan = resolveSanityPlan(
      makeProject({ typecheck: "tsc --noEmit", "test:run": "vitest run" }),
    );

    expect(plan.skipped).toEqual([{ name: "lint", scripts: ["lint"] }]);
    // `steps` keeps its shape exactly: every reader of it executes its members.
    expect(plan.steps).toEqual([
      { name: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
      { name: "tests", command: "pnpm", args: ["run", "test:run"] },
    ]);
  });

  it("records nothing when the project declares every script", () => {
    const plan = resolveSanityPlan(
      makeProject({
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        "test:run": "vitest run",
      }),
    );

    expect(plan.skipped).toEqual([]);
    expect(plan.steps).toHaveLength(3);
  });

  it("names both script names a step accepts", () => {
    const plan = resolveSanityPlan(makeProject({ typecheck: "tsc --noEmit" }));

    expect(plan.skipped).toEqual([
      { name: "lint", scripts: ["lint"] },
      { name: "tests", scripts: ["test:run", "test"] },
    ]);
  });

  it("records all three steps when there is no package.json to read", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-preship-empty-"));
    tempDirs.push(dir);

    expect(resolveSanityPlan(dir).skipped).toEqual([
      { name: "typecheck", scripts: ["typecheck"] },
      { name: "lint", scripts: ["lint"] },
      { name: "tests", scripts: ["test:run", "test"] },
    ]);
  });

  it("leaves the command set the gate and QA share untouched", () => {
    // ADR 0012: `resolveSanityCommands` is the one list QA is told to run, so
    // adding the skip record must not add a command to it.
    expect(
      resolveSanityCommands(makeProject({ typecheck: "tsc --noEmit" })),
    ).toEqual(["pnpm install --frozen-lockfile", "pnpm run typecheck"]);
  });
});

describe("runPreShipSanity — carrying the skip record (#238)", () => {
  it("passes green while naming the step it never ran", () => {
    const dir = makeProject({
      typecheck: "tsc --noEmit",
      "test:run": "vitest run",
    });

    const { result } = record(dir);

    // A skipped step never fails the gate — that behaviour is documented in
    // CONTEXT.md and is not what #238 changes.
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([{ name: "lint", scripts: ["lint"] }]);
  });

  it("reports an empty record when every script is declared", () => {
    const dir = makeProject({
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      "test:run": "vitest run",
    });

    expect(record(dir).result.skipped).toEqual([]);
  });

  it("carries the record on the early return for a project with no sanity scripts", () => {
    const dir = makeProject({ build: "tsc" });

    const { ran, result } = record(dir);

    expect(ran).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([
      { name: "typecheck", scripts: ["typecheck"] },
      { name: "lint", scripts: ["lint"] },
      { name: "tests", scripts: ["test:run", "test"] },
    ]);
  });

  it("carries the record on every failure path too", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });
    const expected = [
      { name: "lint", scripts: ["lint"] },
      { name: "tests", scripts: ["test:run", "test"] },
    ];

    const configuration = record(dir, {
      "pnpm install --frozen-lockfile": { outcome: "EXITED", exitCode: 1 },
    }).result;
    const crashed = record(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: HEAP_CORRUPTION,
      },
    }).result;
    const red = record(dir, {
      "pnpm run typecheck": { outcome: "EXITED", exitCode: 1 },
    }).result;

    expect(configuration.skipped).toEqual(expected);
    expect(crashed.skipped).toEqual(expected);
    expect(red.skipped).toEqual(expected);
  });
});
