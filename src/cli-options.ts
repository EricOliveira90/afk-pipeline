export const DEFAULT_MAX_CONTRACT_ROUNDS = 3;

export function parseMaxContractRounds(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error("--max-contract-rounds must be a positive integer");
  }
  const rounds = Number(value);
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new Error("--max-contract-rounds must be a positive integer");
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
  /** Execute otherwise independent slice lanes one at a time. */
  serialLanes?: boolean;
  /**
   * Open the draft PR despite an unfavorable PM verdict, recording the
   * human override and both guardian verdicts in the PR body (ADR 0015).
   * Requires a favorable architect verdict; only a real FIX-BEFORE-SHIP
   * PM verdict can be overridden — infrastructure failures cannot.
   */
  openPrOnOverride?: boolean;
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
  const serialLanes = args.includes("--serial-lanes");
  const openPrOnOverride = args.includes("--open-pr-on-override");
  const verifyMigrationCommand = optionValue(args, "--preview-verify-command");
  const applyMigrationCommand = optionValue(args, "--preview-apply-command");
  if ((verifyMigrationCommand === undefined) !== (applyMigrationCommand === undefined)) {
    throw new Error("--preview-verify-command and --preview-apply-command must be provided together");
  }

  return {
    commandTimeoutMs,
    heartbeatIntervalMs,
    infrastructureRetries,
    transientRetryWindowMs,
    maxAgentDurationMs,
    serialLanes,
    openPrOnOverride,
    sharedPreview: verifyMigrationCommand && applyMigrationCommand
      ? {
          verifyMigrationCommand,
          applyMigrationCommand,
          lockPath: optionValue(args, "--preview-lock-path"),
        }
      : undefined,
  };
}
