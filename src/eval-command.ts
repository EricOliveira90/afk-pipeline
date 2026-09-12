/**
 * `afk eval` — a report-only runner (`prd.md` D14–D17, D19, D21, D31, D34).
 *
 * Each case is dispatched sequentially in declared order into a **fresh
 * scratch directory** seeded only from its `files`, so the role's tool use
 * finds what the case declares and nothing of the AFK checkout. One case is
 * exactly one `AgentProvider.invoke`, never retried, and the whole-run
 * `--max-calls` budget is checked before each dispatch.
 *
 * **The exit code is non-zero if and only if no `report.json` exists for the
 * run.** That is the non-gating boundary in mechanical form: a run whose every
 * case is `MISMATCH` exits 0, because a non-zero exit is how a shell script
 * turns a measurement into a gate.
 *
 * No git, no worktree, no `RunState`, no `RunJournal`, no run directory.
 */
import { once } from "node:events";
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentProvider, InvokeResult } from "./agent-provider.js";
import { compareProjection, projectOutput, roleDispatch } from "./eval-compare.js";
import {
  type EvalCase,
  type EvalExpected,
  type EvalPack,
  readEvalPack,
} from "./eval-pack.js";
import {
  EVAL_REPORT_VERSION,
  type EvalCaseResult,
  type EvalOutcome,
  type EvalReport,
  formatCaseLine,
  formatEvalSummary,
  writeEvalReport,
} from "./eval-report.js";

/** The seams a test injects: a clock, a temp root, and the stdout sink. */
export interface EvalCliDeps {
  now(): Date;
  /** A fresh directory for one case; the default is `mkdtempSync` (D34). */
  mkScratchDir(id: string): string;
  stdout(line: string): void;
}

export const DEFAULT_EVAL_DEPS: EvalCliDeps = {
  now: () => new Date(),
  mkScratchDir: (id) => mkdtempSync(join(tmpdir(), `afk-eval-${id}-`)),
  stdout: (line) => {
    console.log(line);
  },
};

/** Integer ≥ 1; no `afk.config.json` key and no pack member can change it. */
const DEFAULT_MAX_CALLS = 50;

const USAGE =
  "Usage: afk eval --pack <dir> [--max-calls <n>] [--out <dir>] [--dry-run]";

interface EvalCliOptions {
  pack: string;
  maxCalls: number;
  out: string;
  dryRun: boolean;
}

/** Thrown for a usage error: the caller turns it into exit 2 plus the usage. */
class UsageError extends Error {}

function parseArgs(args: readonly string[], repoRoot: string): EvalCliOptions {
  let pack: string | undefined;
  let maxCalls = DEFAULT_MAX_CALLS;
  let out: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--pack" || arg === "--out" || arg === "--max-calls") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--pack") pack = value;
      else if (arg === "--out") out = value;
      else {
        // Integer ≥ 1. A float or a zero is a mistake about the budget, and a
        // budget silently rounded is a budget nobody set.
        if (!/^\d+$/.test(value) || Number(value) < 1) {
          throw new UsageError(
            `--max-calls must be an integer of at least 1, not "${value}"`,
          );
        }
        maxCalls = Number(value);
      }
      continue;
    }
    throw new UsageError(`unknown argument "${arg}"`);
  }

  if (pack === undefined) throw new UsageError("--pack <dir> is required");
  return {
    pack: resolve(pack),
    maxCalls,
    out: out === undefined ? join(repoRoot, ".afk", "eval") : resolve(out),
    dryRun,
  };
}

/** `eval-<YYYYMMDD-HHmmss>`, UTC, zero-padded — one directory per run. */
function runDirName(now: Date): string {
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  const stamp =
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `eval-${stamp}`;
}

/**
 * Seed the scratch directory from `files` and nothing else: inline values as
 * UTF-8 bytes unchanged, `fromFile` values copied byte-for-byte (D34).
 */
function seedScratchDir(
  scratchDir: string,
  evalCase: EvalCase,
  packDir: string,
): void {
  for (const [key, content] of Object.entries(evalCase.files)) {
    const target = join(scratchDir, ...key.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (typeof content === "string") {
      writeFileSync(target, content, "utf-8");
    } else {
      copyFileSync(join(packDir, ...content.fromFile.split("/")), target);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best-effort removal of a MATCH's scratch directory; Windows may still hold
 * a handle on a file the provider's child process just wrote. */
function removeScratchDir(scratchDir: string): void {
  rmSync(scratchDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

/** One dispatched case: invoke, project, compare. Never retries (D14, D31). */
async function runCase(
  evalCase: EvalCase,
  pack: EvalPack,
  runDir: string,
  provider: AgentProvider,
  deps: EvalCliDeps,
): Promise<EvalCaseResult> {
  const dispatch = roleDispatch(evalCase.role);
  const scratchDir = deps.mkScratchDir(evalCase.id);
  seedScratchDir(scratchDir, evalCase, pack.dir);

  // The provider's raw stdout, the same convention as the pipeline's agent
  // logs. Awaiting `open` means the file exists even for a case whose
  // invocation rejects immediately.
  const logStream = createWriteStream(join(runDir, `${evalCase.id}.log`));
  await once(logStream, "open");

  const startedAt = deps.now().getTime();
  let invoked: InvokeResult | undefined;
  let rejection: string | undefined;
  try {
    invoked = await provider.invoke({
      ...dispatch.invokeOptions,
      prompt: evalCase.prompt,
      cwd: scratchDir,
      logStream,
    });
  } catch (error) {
    // Including a `TransientProviderError`: the harness measures what the
    // role did on one call, and a retry would measure something else.
    rejection = message(error);
  } finally {
    await new Promise<void>((settle) => logStream.end(settle));
  }

  const base = {
    id: evalCase.id,
    role: evalCase.role,
    source: evalCase.source,
    expected: evalCase.expected,
    callsUsed: 1 as const,
    durationMs: deps.now().getTime() - startedAt,
    costUsd: invoked?.stats.costUsd,
    toolCallCount: invoked?.stats.toolCallCount,
  };

  const failed = (error: string): EvalCaseResult => ({
    ...base,
    outcome: "ERROR",
    error,
    scratchDir,
  });

  if (rejection !== undefined) return failed(rejection);
  if (invoked === undefined) return failed("invoke returned no result");
  if (invoked.exitCode !== 0) {
    // The artifact is not consulted: a role that exited non-zero may have
    // written a plausible-looking file on its way out.
    return failed(`role exited ${invoked.exitCode}`);
  }

  let actual: EvalExpected;
  try {
    actual = projectOutput(evalCase.role, scratchDir);
  } catch (error) {
    return failed(message(error));
  }

  const outcome = compareProjection(evalCase.expected, actual);
  if (outcome === "MATCH") {
    removeScratchDir(scratchDir);
    return { ...base, outcome, actual };
  }
  // Kept, and its path recorded, so a maintainer can read what the role wrote.
  return { ...base, outcome, actual, scratchDir };
}

function countOutcomes(
  results: readonly EvalCaseResult[],
): Record<EvalOutcome, number> {
  const counts: Record<EvalOutcome, number> = {
    MATCH: 0,
    MISMATCH: 0,
    "NOT-RUN": 0,
    ERROR: 0,
  };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

export async function runEvalCli(
  args: readonly string[],
  repoRoot: string,
  provider: AgentProvider,
  deps: EvalCliDeps = DEFAULT_EVAL_DEPS,
): Promise<{ output: string; exitCode: 0 | 1 | 2 }> {
  let options: EvalCliOptions;
  try {
    options = parseArgs(args, repoRoot);
  } catch (error) {
    return { output: `${message(error)}\n${USAGE}`, exitCode: 2 };
  }

  let pack: EvalPack;
  try {
    pack = readEvalPack(options.pack);
  } catch (error) {
    // A refused pack dispatched nothing, so there is no report to write.
    return { output: message(error), exitCode: 2 };
  }

  if (options.dryRun) {
    return {
      output: pack.cases
        .map((entry) => `${entry.id} (${entry.role}) — ${entry.source}`)
        .join("\n"),
      exitCode: 0,
    };
  }

  // Set the moment the first invocation is attempted: it is what separates a
  // throw from the runner's own seams (exit 1) from a failure that dispatched
  // nothing (exit 2).
  let dispatchBegan = false;
  try {
    const startedAt = deps.now();
    const runDir = join(options.out, runDirName(startedAt));
    mkdirSync(runDir, { recursive: true });

    const results: EvalCaseResult[] = [];
    let callsUsed = 0;
    for (const [index, evalCase] of pack.cases.entries()) {
      let result: EvalCaseResult;
      if (callsUsed >= options.maxCalls) {
        // The budget is the whole run's, checked before each dispatch, so two
        // runs of the same pack with the same cap report the same NOT-RUN set.
        result = {
          id: evalCase.id,
          role: evalCase.role,
          source: evalCase.source,
          outcome: "NOT-RUN",
          expected: evalCase.expected,
          callsUsed: 0,
        };
      } else {
        dispatchBegan = true;
        callsUsed += 1;
        result = await runCase(evalCase, pack, runDir, provider, deps);
      }
      results.push(result);
      deps.stdout(formatCaseLine(index + 1, pack.cases.length, result));
    }

    const dispatched = results.filter((result) => result.callsUsed === 1);
    // Absent, never 0, unless every dispatched case reported one: a partial
    // sum reads as a total and would be quoted as one.
    const costUsd =
      dispatched.length > 0 &&
      dispatched.every((result) => result.costUsd !== undefined)
        ? dispatched.reduce((sum, result) => sum + (result.costUsd ?? 0), 0)
        : undefined;

    const report: EvalReport = {
      version: EVAL_REPORT_VERSION as 1,
      status: results.some((result) => result.outcome === "NOT-RUN")
        ? "INCOMPLETE"
        : "COMPLETE",
      provider: provider.name,
      pack: pack.dir,
      packVersion: pack.version,
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      maxCalls: options.maxCalls,
      callsUsed,
      costUsd,
      counts: countOutcomes(results),
      cases: results,
    };
    const reportPath = writeEvalReport(runDir, report);
    return { output: formatEvalSummary(report, reportPath), exitCode: 0 };
  } catch (error) {
    // No report was written, so the exit code is non-zero either way; which
    // one says whether a model call was already spent.
    return { output: message(error), exitCode: dispatchBegan ? 1 : 2 };
  }
}
