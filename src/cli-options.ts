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
   * Write every provider invocation's exact prompt to a `.prompt.md` file
   * beside that invocation's `.log` in the run directory, so a past
   * incident can become an eval case from a recording rather than a hand
   * reconstruction. Default off; the `run-started` event records whether it
   * was on. See CONTEXT.md **Prompt record** (#264).
   */
  recordPrompts?: boolean;
  /**
   * Open the draft PR despite an unfavorable PM verdict, recording the
   * human override and both guardian verdicts in the PR body (ADR 0015).
   * Requires a favorable architect verdict; only a real FIX-BEFORE-SHIP
   * PM verdict can be overridden — infrastructure failures cannot.
   */
  openPrOnOverride?: boolean;
  /**
   * Unfavorable guardian review rounds the ship gate spends before it stops
   * fixing: it files the unresolved blocking findings as issues, opens the
   * draft PR with them recorded, and reports success (ADR 0057 decision 4).
   * Absent leaves the default of 3, matching ADR 0014's implementation cap.
   * 0 disables the cap and restores the unbounded pre-ADR-0057 loop.
   */
  guardianRoundCap?: number;
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
  /**
   * The single slice number or GH issue id whose accepted contract/manifest pair
   * the operator judged stale and wants renegotiated on its preserved worktree
   * (#277). Absent on every run that did not ask for one.
   */
  renegotiateStale?: string;
  /** Why the pair named by `renegotiateStale` is stale; trimmed, else verbatim. */
  recoveryReason?: string;
  /**
   * Slice numbers or GH issue ids the renegotiation named by `renegotiateStale`
   * should additionally admit into the run's scope of record (`--extend-scope`,
   * #278 B-01). Selectors as typed and in the order typed — resolving one to a
   * `{number, ghIssue}` identity needs the run's persisted scope and `issues.md`,
   * which `src/preserve-work-recovery.ts` owns. Absent on every run that asked
   * for no additions.
   */
  extendScope?: string[];
}

/**
 * A well-formed `--renegotiate-stale` / `--recovery-reason` pair (#277 B-01).
 *
 * The *selector* rather than a resolved identity: resolving `12` to a
 * `{number, ghIssue}` pair needs the run's persisted scope, which the argument
 * parser has never read and must not start reading. `src/preserve-work-recovery.ts`
 * owns that corroboration.
 */
export interface StaleRenegotiationRequest {
  /** Exactly one slice number or GH issue id, as typed. */
  selector: string;
  /** The reason after `String.prototype.trim()` and nothing else. */
  reason: string;
}

const RENEGOTIATE_STALE_FLAG = "--renegotiate-stale";
const RECOVERY_REASON_FLAG = "--recovery-reason";
const EXTEND_SCOPE_FLAG = "--extend-scope";

/** How many times a flag token appears in the whole argument list. */
function countFlagOccurrences(args: readonly string[], flag: string): number {
  return args.reduce((total, arg) => (arg === flag ? total + 1 : total), 0);
}

/**
 * Read the preserved-work recovery request, or `undefined` when the run asked
 * for none (#277 B-01/B-02).
 *
 * Exported so the accepted case has an observable return value: the shared
 * parser throws the #335 refusal for every well-formed pair (B-12), so asserting
 * "this input is accepted" on the parser is impossible until #335 lands. Keeping
 * the accepted return here means #335's change is deleting one guard in
 * `parsePipelineRuntimeOptions` while this function is untouched.
 *
 * A selector is validated with `optionValue`'s single-token discipline rather
 * than `parseSliceIdList`'s comma splitting, because a list of recovery targets
 * is a refusal here, not an input. Only the whole-args duplicate scan is reused,
 * and only to notice a second occurrence of either flag.
 */
export function parseStaleRenegotiationRequest(
  args: readonly string[],
): StaleRenegotiationRequest | undefined {
  if (countFlagOccurrences(args, RENEGOTIATE_STALE_FLAG) > 1) {
    throw new Error(
      `${RENEGOTIATE_STALE_FLAG} was supplied more than once; a recovery attempt has exactly one target`,
    );
  }
  if (countFlagOccurrences(args, RECOVERY_REASON_FLAG) > 1) {
    throw new Error(
      `${RECOVERY_REASON_FLAG} was supplied more than once; a recovery attempt has exactly one reason`,
    );
  }

  const selector = optionValue(args, RENEGOTIATE_STALE_FLAG);
  const reasonRaw = optionValue(args, RECOVERY_REASON_FLAG);
  if (selector === undefined && reasonRaw === undefined) return undefined;

  // One paired-presence check in each direction, following the
  // --preview-verify-command / --preview-apply-command precedent below. Two
  // messages rather than one, because "you named a target but no reason" and
  // "you gave a reason but named no target" are different mistakes.
  if (selector === undefined) {
    throw new Error(
      `${RECOVERY_REASON_FLAG} requires ${RENEGOTIATE_STALE_FLAG} <slice|ghIssue> naming the target to renegotiate`,
    );
  }
  if (reasonRaw === undefined) {
    throw new Error(
      `${RENEGOTIATE_STALE_FLAG} requires ${RECOVERY_REASON_FLAG} <text> recording why the accepted pair is stale`,
    );
  }

  if (selector.includes(",")) {
    const parts = selector.split(",").map((part) => part.trim());
    // A repeated selector is a typo about one target; two different selectors
    // is a request for two recoveries. Distinct mistakes, distinct messages.
    if (new Set(parts).size === 1) {
      throw new Error(
        `${RENEGOTIATE_STALE_FLAG} names ${parts[0]} more than once; supply the target exactly once`,
      );
    }
    throw new Error(
      `${RENEGOTIATE_STALE_FLAG} takes one slice number or GH issue id, not a comma-separated list`,
    );
  }
  if (!/^\d+$/.test(selector)) {
    throw new Error(
      `${RENEGOTIATE_STALE_FLAG} must be a slice number or GH issue id`,
    );
  }

  const reason = reasonRaw.trim();
  if (reason === "") {
    throw new Error(
      `${RECOVERY_REASON_FLAG} requires non-blank text recording why the accepted pair is stale`,
    );
  }

  return { selector, reason };
}

/**
 * Read the scope additions a recovery attempt should admit, or `undefined` when
 * the run asked for none (#278 B-01).
 *
 * Exported for the reason {@link parseStaleRenegotiationRequest} is: the shared
 * parser still throws #277's #335 guard for every well-formed recovery request,
 * so the accepted case has no observable return there. Here it does.
 *
 * Digits-only is the whole selector language, exactly as `--force-restart` and
 * `--renegotiate-stale` have it: a part is either a canonical slice number (zero
 * padding preserved as typed) or a bare GH issue id, because `issues-parser.ts`
 * stores `ghIssue` with the `#` already stripped. `#278` and every other
 * non-digit spelling is refused rather than normalized — a parser that quietly
 * accepted two spellings of one identity would make the duplicate check below a
 * lie. Which of the two an accepted part names is not decidable here and is not
 * decided here; `src/preserve-work-recovery.ts` corroborates it against
 * `issues.md` and the persisted scope.
 *
 * One occurrence only, following {@link parseStaleRenegotiationRequest}'s
 * discipline rather than `parseSliceIdList`'s repeatable form: the additions are
 * one set belonging to one recovery attempt, so a second occurrence is a
 * mistake about that set rather than more of it.
 */
export function parseScopeExtensionSelectors(
  args: readonly string[],
): string[] | undefined {
  if (countFlagOccurrences(args, EXTEND_SCOPE_FLAG) > 1) {
    throw new Error(
      `${EXTEND_SCOPE_FLAG} was supplied more than once; a recovery attempt admits one set of additions`,
    );
  }

  // `optionValue` before the paired-presence checks, matching
  // `parseStaleRenegotiationRequest`: a flag with nothing after it is a mistake
  // about this flag, whatever else the argument list is missing.
  const raw = optionValue(args, EXTEND_SCOPE_FLAG);
  if (raw === undefined) return undefined;

  // Additions are a rider on a recovery request, never a request of their own:
  // there is no attempt to attach them to and no reason on record without both
  // flags. Two messages rather than one, because a missing target and a missing
  // reason are different mistakes — the same split #277 B-02 draws.
  if (!args.includes(RENEGOTIATE_STALE_FLAG)) {
    throw new Error(
      `${EXTEND_SCOPE_FLAG} requires ${RENEGOTIATE_STALE_FLAG} <slice|ghIssue> naming the renegotiation to extend`,
    );
  }
  if (!args.includes(RECOVERY_REASON_FLAG)) {
    throw new Error(
      `${EXTEND_SCOPE_FLAG} requires ${RECOVERY_REASON_FLAG} <text> recording why the accepted pair is stale`,
    );
  }

  const selectors: string[] = [];
  for (const part of raw.split(",").map((value) => value.trim())) {
    if (!/^\d+$/.test(part)) {
      throw new Error(
        `${EXTEND_SCOPE_FLAG} must be a comma-separated list of slice numbers or GH issue ids`,
      );
    }
    // Literal repetition only. Naming one identity by number in one part and by
    // GH issue id in another is undetectable without `issues.md`, and the
    // resolver refuses that case with `extension-identity-conflict`.
    if (selectors.includes(part)) {
      throw new Error(
        `${EXTEND_SCOPE_FLAG} names ${part} more than once; list each addition exactly once`,
      );
    }
    selectors.push(part);
  }
  return selectors;
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
  const guardianRoundCap = parseIntegerOption(
    optionValue(args, "--guardian-round-cap"),
    "--guardian-round-cap",
    true,
  );
  const testCommand = parseCommandOption(args, "--test-command");
  const minFreeDiskGb = parseMinFreeDiskGb(
    optionValue(args, "--min-free-disk-gb"),
  );
  const preflightReportOnly = args.includes("--preflight-report-only");
  const serialLanes = args.includes("--serial-lanes");
  const openPrOnOverride = args.includes("--open-pr-on-override");
  // Exact-token membership like the booleans above, but left unset rather
  // than `false` when absent, so the field is only present on a run that
  // asked for it. A near miss (`--record-prompt`,
  // `--record-prompts=false`) is silently not the flag: it has no value
  // form, and no boolean flag here rejects anything either.
  const recordPrompts = args.includes("--record-prompts") ? true : undefined;
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
  // The flags' own validation first, so B-01/B-02's messages are already the
  // behavior that survives #335 and the completion slice's change is deleting
  // exactly one guard here (#277 B-12).
  const staleRenegotiation = parseStaleRenegotiationRequest(args);
  // Read out before the guard: after the `throw` below, the request narrows to
  // `undefined`, and the members must survive as the shape a run carries.
  const renegotiateStale: string | undefined = staleRenegotiation?.selector;
  const recoveryReason: string | undefined = staleRenegotiation?.reason;
  // Also before the guard, and for the same reason (#278 B-01): the additions
  // ride on the request the guard refuses, so validating them after it would
  // make every `--extend-scope` mistake unreportable until #277's guard goes.
  const extendScope = parseScopeExtensionSelectors(args);
  if (staleRenegotiation !== undefined) {
    throw new Error(
      `${RENEGOTIATE_STALE_FLAG} is refused until #335 lands: verified rollback (#333) and ` +
        "launch-time reconciliation (#334) are unshipped, so an admitted recovery attempt " +
        "could not be completed or undone. No eligibility check, snapshot or run-state " +
        "lock is attempted.",
    );
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
    recordPrompts,
    guardianRoundCap,
    forceRestart,
    resumeStuck,
    // Unreachable while the #335 guard above throws for every well-formed pair;
    // present so the shape a run carries does not change when that guard goes.
    renegotiateStale,
    recoveryReason,
    extendScope,
    sharedPreview: verifyMigrationCommand && applyMigrationCommand
      ? {
          verifyMigrationCommand,
          applyMigrationCommand,
          lockPath: optionValue(args, "--preview-lock-path"),
        }
      : undefined,
  };
}
