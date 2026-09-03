export const DEFAULT_MAX_CONTRACT_ROUNDS = 2;

export function parseMaxContractRounds(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error("--max-contract-rounds must be a positive integer");
  }
  const rounds = Number(value);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error("--max-contract-rounds must be a positive integer");
  }
  if (rounds > DEFAULT_MAX_CONTRACT_ROUNDS) {
    throw new Error(
      `--max-contract-rounds supports 1-${DEFAULT_MAX_CONTRACT_ROUNDS}; ` +
        "the evidence-qualified final response is controlled by AFK",
    );
  }
  return rounds;
}

export function parseSliceSelection(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    throw new Error("--slices requires a comma-separated list of slice numbers");
  }
  const values = value.split(",").map((part) => part.trim());
  if (values.some((part) => !/^\d+$/.test(part))) {
    throw new Error("--slices must contain only comma-separated slice numbers");
  }
  return values;
}

export interface PipelineRuntimeOptions {
  commandTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  infrastructureRetries?: number;
  /**
   * Total elapsed-time window for retrying transient model
   * unavailability per invocation, with exponential backoff.
   * Default: 15 min. 0 disables. See ADR 0022.
   */
  transientRetryWindowMs?: number;
  /**
   * Per-invocation wall-clock ceiling override, applied uniformly to
   * every agent role. When absent, role-aware defaults apply: 120 min
   * for generator and evaluator-qa, the 60 min provider default for
   * everything else. See ADR 0019.
   */
  maxAgentDurationMs?: number;
  /**
   * The command the generator verifies with while it iterates, replacing
   * the `package.json` script AFK would otherwise pick. Point it at a
   * fast subset (`pnpm test:fast`) to keep whole-suite runs out of every
   * generator round; the gate and QA still run the full set. See
   * ADR 0038.
   */
  testCommand?: string;
  /** Execute otherwise independent slice lanes one at a time. */
  serialLanes?: boolean;
  /**
   * Open the draft PR despite an unfavorable PM verdict, recording the
   * human override and both guardian verdicts in the PR body (ADR 0015).
   * Requires a favorable architect verdict; only a real FIX-BEFORE-SHIP
   * PM verdict can be overridden — infrastructure failures cannot.
   */
  openPrOnOverride?: boolean;
  /**
   * Slices the operator forces to restart from base regardless of
   * resume eligibility (#37) — for worktrees a human has judged bad.
   * Values are slice numbers or GH issue ids; repeatable and
   * comma-separated on the CLI.
   */
  forceRestart?: string[];
  /**
   * Slices granted one more implementation/QA attempt on their preserved
   * STUCK tree instead of the default restart from base (#49) — for
   * worktrees a human has read the stuck.md of and judged worth
   * finishing. Values are slice numbers or GH issue ids; repeatable and
   * comma-separated on the CLI. Opt-in per run: nothing is remembered,
   * so a stuck.md stays terminal unless the flag is supplied again.
   */
  resumeStuck?: string[];
  /**
   * Free-space floor the launch preflight refuses below, in GB. 0
   * disables the floor. Absent leaves the default from
   * `DEFAULT_MIN_FREE_DISK_GB`. See ADR 0042.
   */
  minFreeDiskGb?: number;
  /**
   * Run the launch preflight's checks and print the report, but launch
   * even when a hard condition is present. The escape hatch for a false
   * "leftover" reading — recorded in `run.log` so the record shows the
   * checks were bypassed.
   */
  preflightReportOnly?: boolean;
  sharedPreview?: {
    verifyMigrationCommand: string;
    applyMigrationCommand: string;
    lockPath?: string;
  };
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/**
 * Read a flag whose value is a shell command. A whitespace-only value
 * would reach a prompt or a spawn as an empty instruction, so reject it
 * here rather than let an agent improvise a command AFK never chose.
 */
function parseCommandOption(
  args: readonly string[],
  flag: string,
): string | undefined {
  const value = optionValue(args, flag);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(`${flag} requires a non-empty command`);
  }
  return trimmed;
}

function parseIntegerOption(
  value: string | undefined,
  flag: string,
  allowZero: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

/**
 * Read a free-space floor in GB. Decimals are allowed — a floor is a
 * judgement about headroom, and whole gigabytes are too coarse to express
 * "half a gig is enough on this box". 0 disables the check, matching
 * `--transient-retry-window-ms`.
 */
export function parseMinFreeDiskGb(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("--min-free-disk-gb must be a non-negative number of GB (0 disables the check)");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--min-free-disk-gb must be a non-negative number of GB (0 disables the check)");
  }
  return parsed;
}

/**
 * Collect every occurrence of a repeatable slice-selector flag,
 * splitting each value on commas. `--force-restart 05 --force-restart
 * 07,4001` yields `["05", "07", "4001"]`. Values must be slice numbers
 * or GH issue ids (digits only — zero padding preserved).
 */
function parseSliceIdList(
  args: readonly string[],
  flag: string,
): string[] | undefined {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a slice number or GH issue id`);
    }
    for (const part of value.split(",").map((p) => p.trim())) {
      if (!/^\d+$/.test(part)) {
        throw new Error(
          `${flag} must be a comma-separated list of slice numbers or GH issue ids`,
        );
      }
      values.push(part);
    }
    i++;
  }
  return values.length > 0 ? values : undefined;
}

/** Parse runtime controls shared by all AFK provider CLIs. */
export function parsePipelineRuntimeOptions(
  args: readonly string[],
): PipelineRuntimeOptions {
  const commandTimeoutMs = parseIntegerOption(
    optionValue(args, "--command-timeout-ms"),
    "--command-timeout-ms",
    false,
  );
  const heartbeatIntervalMs = parseIntegerOption(
    optionValue(args, "--heartbeat-interval-ms"),
    "--heartbeat-interval-ms",
    false,
  );
  const infrastructureRetries = parseIntegerOption(
    optionValue(args, "--infrastructure-retries"),
    "--infrastructure-retries",
    true,
  );
  const transientRetryWindowMs = parseIntegerOption(
    optionValue(args, "--transient-retry-window-ms"),
    "--transient-retry-window-ms",
    true,
  );
  const maxAgentDurationMs = parseIntegerOption(
    optionValue(args, "--max-agent-duration-ms"),
    "--max-agent-duration-ms",
    false,
  );
  const testCommand = parseCommandOption(args, "--test-command");
  const minFreeDiskGb = parseMinFreeDiskGb(
    optionValue(args, "--min-free-disk-gb"),
  );
  const preflightReportOnly = args.includes("--preflight-report-only");
  const serialLanes = args.includes("--serial-lanes");
  const openPrOnOverride = args.includes("--open-pr-on-override");
  const forceRestart = parseSliceIdList(args, "--force-restart");
  const resumeStuck = parseSliceIdList(args, "--resume-stuck");
  // "Throw this tree away" and "finish this tree" are contradictory
  // instructions; fail fast rather than silently applying the
  // documented precedence. Only literal overlap is detectable here —
  // naming the same slice by number in one flag and by GH issue id in
  // the other needs the manifest, so `decideResume` resolves that case
  // deterministically in favour of `--force-restart`.
  const contested = (forceRestart ?? []).filter((id) =>
    (resumeStuck ?? []).some((other) => Number(other) === Number(id)),
  );
  if (contested.length > 0) {
    throw new Error(
      `--force-restart and --resume-stuck both name ${contested.join(", ")}; pick one per slice`,
    );
  }
  const verifyMigrationCommand = parseCommandOption(args, "--preview-verify-command");
  const applyMigrationCommand = parseCommandOption(args, "--preview-apply-command");
  if ((verifyMigrationCommand === undefined) !== (applyMigrationCommand === undefined)) {
    throw new Error("--preview-verify-command and --preview-apply-command must be provided together");
  }

  return {
    commandTimeoutMs,
    heartbeatIntervalMs,
    infrastructureRetries,
    transientRetryWindowMs,
    maxAgentDurationMs,
    testCommand,
    minFreeDiskGb,
    preflightReportOnly,
    serialLanes,
    openPrOnOverride,
    forceRestart,
    resumeStuck,
    sharedPreview: verifyMigrationCommand && applyMigrationCommand
      ? {
          verifyMigrationCommand,
          applyMigrationCommand,
          lockPath: optionValue(args, "--preview-lock-path"),
        }
      : undefined,
  };
}
