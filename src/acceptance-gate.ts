/**
 * The behavior coverage gate: every behavior id the locked manifest binds to
 * `acceptance:behaviors` proved by a real test run, before the candidate
 * reaches behavioral evaluation (#85).
 *
 * The verdict is content-derived, so this gate cannot be a `command`
 * declaration. Vitest exits 0 when a name filter matched nothing at all, and
 * the gate runner classifies a command gate from its exit code
 * (`classifyExecution`, `src/gate-runner.ts`) — an untested behavior would
 * report PASS. It reports its own status through D22's in-process `run` seam
 * instead, deciding from one runner JSON document and never from prose.
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
 * How one behavior's assertions in the shared run turned out.
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
  /** Qualified assertions that provide evidence: passed + failed. */
  matched: number;
  passed: number;
  failed: number;
}

/**
 * The issue-qualified tag is the proof identity. A bare legacy tag such as
 * `[behavior:B-01]` is deliberately not evidence: unrelated PRDs reuse those
 * local IDs. Coverage requires at least one qualified pass and rejects any
 * qualified failure. Skipped/todo qualified assertions and bare legacy tags
 * provide no evidence, but neither invalidates separate qualified passing
 * evidence. The matcher records legacy-only sightings so an untested failure
 * can tell the generator how to migrate the tag.
 */
export interface VitestBehaviorCoverage {
  records: BehaviorCoverageRecord[];
  ambiguousLegacyIds: string[];
}

export function matchVitestJson(
  document: unknown,
  issueNumber: string | number,
  behaviorIds: readonly string[],
): VitestBehaviorCoverage | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return null;
  }
  const testResults = (document as Record<string, unknown>).testResults;
  if (!Array.isArray(testResults)) {
    return null;
  }

  const assertions: { fullName: string; status: string }[] = [];
  for (const testResult of testResults) {
    if (
      !testResult ||
      typeof testResult !== "object" ||
      Array.isArray(testResult)
    ) {
      return null;
    }
    const assertionResults = (testResult as Record<string, unknown>)
      .assertionResults;
    if (!Array.isArray(assertionResults)) return null;
    for (const assertion of assertionResults) {
      if (
        !assertion ||
        typeof assertion !== "object" ||
        Array.isArray(assertion)
      ) {
        return null;
      }
      const { fullName, status } = assertion as Record<string, unknown>;
      if (typeof fullName !== "string" || typeof status !== "string") {
        return null;
      }
      assertions.push({ fullName, status });
    }
  }

  const ambiguousLegacyIds: string[] = [];
  const records = behaviorIds.map((behaviorId): BehaviorCoverageRecord => {
    const qualifiedTag = behaviorTag(issueNumber, behaviorId);
    const legacyTag = `[behavior:${behaviorId}]`;
    const qualified = assertions.filter((assertion) =>
      assertion.fullName.includes(qualifiedTag),
    );
    const passed = qualified.filter(
      (assertion) => assertion.status === "passed",
    ).length;
    const failed = qualified.filter(
      (assertion) => assertion.status === "failed",
    ).length;
    const matched = passed + failed;
    if (
      matched === 0 &&
      assertions.some((assertion) => assertion.fullName.includes(legacyTag))
    ) {
      ambiguousLegacyIds.push(behaviorId);
    }
    return {
      behaviorId,
      status: matched === 0 ? "untested" : failed > 0 ? "failed" : "covered",
      matched,
      passed,
      failed,
    };
  });
  return { records, ambiguousLegacyIds };
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
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Array.isArray((parsed as Record<string, unknown>).testResults)
        ) {
          return parsed;
        }
      } catch {
        // Not JSON, or not the document — keep scanning upwards.
      }
    }
  }
  return undefined;
}

/** What the shared acceptance run produced. Only the output matters. */
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
  /** GitHub issue owning this slice; behavior tags are qualified by it. */
  issueNumber?: string | number;
  /** From `resolveAcceptancePlan`; `null` when the project resolved none. */
  plan: AcceptancePlan | null;
  runner?: AcceptanceRunner;
  bounds?: AcceptanceRunBounds;
  /**
   * Called once per behavior after the shared run is classified, so the orchestrator can
   * journal per-behavior coverage without `src/candidate-gate-phase.ts`
   * learning about this gate (D22 keeps that file unedited).
   */
  onBehaviorResult?: (record: BehaviorCoverageRecord) => void;
}

/** The exact tag a test must carry to prove one slice behavior. */
export function behaviorTag(
  issueNumber: string | number,
  behaviorId: string,
): string {
  return `[behavior:#${issueNumber}:${behaviorId}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One filter selects every required qualified tag plus its legacy spelling.
 * Legacy tests are included only so the report can diagnose them; the matcher
 * never counts them as coverage.
 */
function behaviorSelector(
  issueNumber: string,
  behaviorIds: readonly string[],
): string {
  return `(?:${behaviorIds
    .flatMap((behaviorId) => [
      behaviorTag(issueNumber, behaviorId),
      `[behavior:${behaviorId}]`,
    ])
    .map(escapeRegExp)
    .join("|")})`;
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
 * Run one report for every bound behavior and fold its assertions into one
 * outcome.
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
  const issueNumber =
    input.issueNumber === undefined ? "" : String(input.issueNumber);
  if (!/^[1-9]\d*$/.test(issueNumber)) {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `The coverage of ${behaviorIds.join(", ")} could not be qualified: ` +
        `the acceptance gate received no positive GitHub issue number.`,
    };
  }

  const runner =
    input.runner ?? boundedAcceptanceRunner(input.bounds ?? DEFAULT_RUN_BOUNDS);
  if (ctx.signal?.aborted) {
    return {
      status: "INFRASTRUCTURE",
      failureKind: null,
      detail:
        `Cancelled before the shared acceptance run; coverage of ` +
        `${behaviorIds.join(", ")} is unknown rather than green.`,
    };
  }
  const selector = behaviorSelector(issueNumber, behaviorIds);
  const { output } = await runner({
    command: plan.command,
    args: plan.args.map((arg) => arg.split(BEHAVIOR_ID_TOKEN).join(selector)),
    cwd: ctx.cwd,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (ctx.signal?.aborted) {
    return {
      status: "INFRASTRUCTURE",
      failureKind: null,
      detail:
        `Cancelled during the shared acceptance run; coverage of ` +
        `${behaviorIds.join(", ")} is unknown rather than green.`,
    };
  }
  const verdict = matchVitestJson(
    readReporterDocument(output),
    issueNumber,
    behaviorIds,
  );
  const records =
    verdict?.records ??
    behaviorIds.map((behaviorId) => ({
      behaviorId,
      status: "unparsable" as const,
      matched: 0,
      passed: 0,
      failed: 0,
    }));
  for (const record of records) input.onBehaviorResult?.(record);

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
        `output of the shared run, so coverage of ` +
        `${unparsable.map((r) => r.behaviorId).join(", ")} could not be ` +
        `decided. Command: ` +
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
  const ambiguousLegacy = verdict?.ambiguousLegacyIds ?? [];
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
      (ambiguousLegacy.length > 0
        ? `Legacy-only tags are ambiguous across PRDs for ` +
          `${ambiguousLegacy.join(", ")}. `
        : "") +
      `Name each behavior with its issue-qualified tag, for example ` +
      `${behaviorTag(issueNumber, behaviorIds[0]!)}, in at least one passing test.`,
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
