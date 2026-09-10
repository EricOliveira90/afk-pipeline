/**
 * The behavior coverage gate: every behavior id the locked manifest binds to
 * `acceptance:behaviors` proved by a real test run, before the candidate
 * reaches behavioral evaluation (#85).
 *
 * The verdict is content-derived, so this gate cannot be a `command`
 * declaration. `pnpm exec vitest run --testNamePattern B-04` exits 0 when it
 * matched nothing at all, and the gate runner classifies a command gate from
 * its exit code (`classifyExecution`, `src/gate-runner.ts`) — an untested
 * behavior would report PASS. It reports its own status through D22's
 * in-process `run` seam instead, deciding from the runner's JSON alone and
 * never from prose.
 *
 * One aggregate declaration, not one per behavior: the failing ids are named in
 * one `detail` so a single repair round sees the whole red set (#85 AC5).
 */
import {
  loadAcceptanceManifest,
  type AcceptanceManifest,
} from "./acceptance-manifest.js";
import { BEHAVIOR_ID_TOKEN, type AcceptancePlan } from "./base-gates.js";
import { runBoundedCommand } from "./command-runtime.js";
import {
  ACCEPTANCE_GATE_ID,
  ACCEPTANCE_GATE_STAGE,
  type GateDeclaration,
  type GateRunOutcome,
} from "./gate-runner.js";

/**
 * How one behavior's filtered run turned out.
 *
 * `unparsable` is not a spelling of "no tests": it means the run produced no
 * reporter document at all, which is a configuration failure about the runner
 * rather than a verdict about the behavior (#85 AC4).
 */
export type BehaviorCoverageStatus =
  | "covered"
  | "untested"
  | "failed"
  | "unparsable";

/** One behavior's verdict with the counts it was derived from. */
export interface BehaviorCoverageRecord {
  behaviorId: string;
  status: BehaviorCoverageStatus;
  /** Tests the filter actually selected: passed + failed. */
  matched: number;
  passed: number;
  failed: number;
}

/**
 * The `vitest-json` matcher, over an already-parsed reporter document. Pure, so
 * the suite proves the rule against transcribed real documents rather than
 * spawning vitest (`contract.md` test plan).
 *
 * The match count is `numPassedTests + numFailedTests`, *not* `numTotalTests`.
 * D8 named the latter, and it cannot work: in this tree's vitest 3.2.4 a
 * `--testNamePattern` run still collects every non-matching test and counts it
 * there as skipped (`@vitest/runner`'s `interpretTaskModes`), so a filter that
 * matched nothing reports `numTotalTests: 18, numPendingTests: 18` and never
 * reaches 0 — both of D8's verdicts would be unreachable. The reporter counts
 * only genuinely run tests into `numPassedTests`/`numFailedTests`, so their sum
 * is the match count D8 meant. Consequence, intended: a behavior whose only
 * matching test is skipped or `todo` is untested, not covered.
 *
 * `null` means "this is not a reporter document" — the caller turns that into
 * the CONFIGURATION failure, and must not read it as zero matches.
 */
export function matchVitestJson(
  document: unknown,
): Omit<BehaviorCoverageRecord, "behaviorId"> | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return null;
  }
  const record = document as Record<string, unknown>;
  const passed = record.numPassedTests;
  const failed = record.numFailedTests;
  if (
    typeof passed !== "number" ||
    typeof failed !== "number" ||
    !Number.isFinite(passed) ||
    !Number.isFinite(failed)
  ) {
    return null;
  }
  const matched = passed + failed;
  return {
    status: matched === 0 ? "untested" : failed > 0 ? "failed" : "covered",
    matched,
    passed,
    failed,
  };
}

/**
 * Find the reporter document in a run's captured output.
 *
 * Absent an output file the JSON reporter logs the document as one
 * `JSON.stringify` line, so the scan is last-line-first: anything vitest or the
 * package manager printed earlier loses to the real document. Lines are also
 * retried from their first `{`, because the capture merges stdout and stderr and
 * an unterminated stderr write can prefix the JSON line.
 */
function readReporterDocument(output: string): unknown | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const text = line.trim();
    const brace = text.indexOf("{");
    if (brace < 0) continue;
    for (const candidate of brace === 0 ? [text] : [text, text.slice(brace)]) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (matchVitestJson(parsed)) return parsed;
      } catch {
        // Not JSON, or not the document — keep scanning upwards.
      }
    }
  }
  return undefined;
}

/** What one filtered run produced. Only the output matters; see the matcher. */
export interface AcceptanceRunResult {
  output: string;
}

/**
 * Subprocess seam. Production spawns through `runBoundedCommand`, so an
 * acceptance run inherits the same inactivity, wall-clock and cancellation
 * bounds as every other gate command and is registered against the worktree
 * (ADR 0035). Unit tests inject a runner and pay no vitest.
 */
export type AcceptanceRunner = (input: {
  command: string;
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
}) => Promise<AcceptanceRunResult>;

/** Bounds the default runner applies, mirroring the phase's gate bounds. */
export interface AcceptanceRunBounds {
  inactivityTimeoutMs: number;
  heartbeatIntervalMs: number;
  wallClockTimeoutMs: number;
}

const DEFAULT_RUN_BOUNDS: AcceptanceRunBounds = {
  inactivityTimeoutMs: 300_000,
  heartbeatIntervalMs: 30_000,
  wallClockTimeoutMs: 1_800_000,
};

function boundedAcceptanceRunner(
  bounds: AcceptanceRunBounds,
): AcceptanceRunner {
  return async (input) => {
    let output = "";
    await runBoundedCommand(input.command, input.args, {
      cwd: input.cwd,
      inactivityTimeoutMs: bounds.inactivityTimeoutMs,
      heartbeatIntervalMs: bounds.heartbeatIntervalMs,
      wallClockTimeoutMs: bounds.wallClockTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onOutput: (text) => {
        output += text;
      },
    });
    // A non-zero exit is not consulted: vitest exits 1 on a failing matched
    // test, which the document already says, and 0 on no match at all, which
    // it also says. The document is the verdict.
    return { output };
  };
}

export interface AcceptanceGateInput {
  /**
   * Absolute slice directory. The manifest is read from it *when the gate
   * runs*, so an ADR 0048 amendment landing between declaration and run is
   * honoured — the same rule `src/scope-gate.ts` states.
   */
  absSliceDir: string;
  /** From `resolveAcceptancePlan`; `null` when the project resolved none. */
  plan: AcceptancePlan | null;
  runner?: AcceptanceRunner;
  bounds?: AcceptanceRunBounds;
  /**
   * Called once per behavior as its run settles, so the orchestrator can
   * journal per-behavior coverage without `src/candidate-gate-phase.ts`
   * learning about this gate (D22 keeps that file unedited).
   */
  onBehaviorResult?: (record: BehaviorCoverageRecord) => void;
}

/** Behavior ids this manifest binds to the acceptance gate, in manifest order. */
function boundBehaviorIds(manifest: AcceptanceManifest): string[] {
  if (manifest.version !== 2) return [];
  return manifest.behaviors
    .filter((behavior) => behavior.gateIds.includes(ACCEPTANCE_GATE_ID))
    .map((behavior) => behavior.id);
}

/** `<id> (matched N, passed N, failed N)`, the shape every failure names. */
function describeRecord(record: BehaviorCoverageRecord): string {
  return (
    `${record.behaviorId} (matched ${record.matched}, passed ` +
    `${record.passed}, failed ${record.failed})`
  );
}

/**
 * Run every bound behavior and fold the records into one outcome.
 *
 * Exported for direct unit coverage; the pipeline reaches it through
 * {@link acceptanceGateDeclaration}.
 */
export async function runAcceptanceGate(
  input: AcceptanceGateInput,
  ctx: { cwd: string; signal?: AbortSignal },
): Promise<GateRunOutcome> {
  // Throws on an unreadable manifest, which `runGates` records as
  // INFRASTRUCTURE — the right answer, because a gate that cannot read the
  // contract has learned nothing about the candidate.
  const behaviorIds = boundBehaviorIds(
    loadAcceptanceManifest(input.absSliceDir),
  );
  if (behaviorIds.length === 0) {
    // PASS, not SKIPPED: a required SKIPPED blocks evaluation, and a slice
    // that binds nothing has nothing for this gate to hold up.
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `No behavior in the locked manifest is bound to ` +
        `${ACCEPTANCE_GATE_ID}, so there is no per-behavior coverage to ` +
        `prove.`,
    };
  }
  const plan = input.plan;
  if (!plan) {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `${behaviorIds.length} behavior(s) are bound to ` +
        `${ACCEPTANCE_GATE_ID} — ${behaviorIds.join(", ")} — but this ` +
        `project resolved no acceptance plan: it declares no ` +
        `gatePolicy.acceptance and has no tests script to derive one from. ` +
        `Declare the runner or unbind the behaviors.`,
    };
  }
  if (plan.matcher !== "vitest-json") {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `The acceptance plan names matcher "${plan.matcher}", which this ` +
        `version of AFK cannot read, so the coverage of ` +
        `${behaviorIds.join(", ")} could not be decided.`,
    };
  }

  const runner =
    input.runner ?? boundedAcceptanceRunner(input.bounds ?? DEFAULT_RUN_BOUNDS);
  const records: BehaviorCoverageRecord[] = [];
  for (const behaviorId of behaviorIds) {
    // Checked per behavior, and the partial set is never folded into a PASS
    // (ADR 0003): a cancelled loop has not proved the behaviors it skipped.
    if (ctx.signal?.aborted) {
      return {
        status: "INFRASTRUCTURE",
        failureKind: null,
        detail:
          `Cancelled after ${records.length} of ${behaviorIds.length} ` +
          `behavior(s); ${behaviorId} onwards never ran, so this candidate's ` +
          `coverage is unknown rather than green.`,
      };
    }
    const { output } = await runner({
      command: plan.command,
      args: plan.args.map((arg) => arg.split(BEHAVIOR_ID_TOKEN).join(behaviorId)),
      cwd: ctx.cwd,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const verdict = matchVitestJson(readReporterDocument(output));
    const record: BehaviorCoverageRecord = {
      behaviorId,
      ...(verdict ?? { status: "unparsable", matched: 0, passed: 0, failed: 0 }),
    };
    records.push(record);
    input.onBehaviorResult?.(record);
  }

  const unparsable = records.filter((r) => r.status === "unparsable");
  if (unparsable.length > 0) {
    // CONFIGURATION and not COMMAND: the runner told us nothing, so this is
    // not evidence about the tree (ADR 0041 — the retryable reading wins the
    // tie only where the branch cannot loop; here the operator must fix a
    // command, so it must not read as a red suite the generator can chase).
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `The ${plan.matcher} matcher found no reporter document in the ` +
        `output of ${unparsable.length} run(s) — ` +
        `${unparsable.map((r) => r.behaviorId).join(", ")} — so their ` +
        `coverage could not be decided. Command: ` +
        `${[plan.command, ...plan.args].join(" ")}`,
    };
  }
  const red = records.filter((r) => r.status !== "covered");
  if (red.length === 0) {
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `All ${records.length} bound behavior(s) are covered by passing ` +
        `tests: ${records.map(describeRecord).join("; ")}.`,
    };
  }
  const untested = red.filter((r) => r.status === "untested");
  const failed = red.filter((r) => r.status === "failed");
  return {
    status: "FAIL",
    failureKind: "COMMAND",
    // Every failing id with its counts and its reason, because this text is
    // what the next generator round reads out of the gate log.
    detail:
      `${red.length} of ${records.length} bound behavior(s) are not proved. ` +
      (untested.length > 0
        ? `No test names ${untested.map(describeRecord).join("; ")}. `
        : "") +
      (failed.length > 0
        ? `Matched tests fail for ${failed.map(describeRecord).join("; ")}. `
        : "") +
      `Name each behavior id in at least one passing test.`,
  };
}

/**
 * The declaration, or `undefined` when the locked manifest binds no behavior to
 * this gate — a project that never opted in pays nothing, and its checkpoint
 * and install decisions stay exactly today's.
 *
 * The bound-id probe here tolerates a missing or unreadable manifest (no
 * declaration), while `run`'s re-read does not (INFRASTRUCTURE). That is the
 * intended asymmetry: a slice with no manifest has nothing to prove, but a
 * manifest that broke between declaration and run is a real fault.
 */
export function acceptanceGateDeclaration(
  input: AcceptanceGateInput,
): GateDeclaration | undefined {
  let bound: string[];
  try {
    bound = boundBehaviorIds(loadAcceptanceManifest(input.absSliceDir));
  } catch {
    return undefined;
  }
  if (bound.length === 0) return undefined;
  return {
    id: ACCEPTANCE_GATE_ID,
    stage: ACCEPTANCE_GATE_STAGE,
    required: true,
    run: (ctx) => runAcceptanceGate(input, ctx),
  };
}
