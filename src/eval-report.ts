/**
 * The `afk eval` report and the two stdout shapes (`prd.md` D20, D22–D24).
 *
 * `afk eval` is not a pipeline run: no `RunJournal`, no run directory, no
 * `events.jsonl`, no new `run-events` type. It writes one standalone
 * `report.json` under `<out>/eval-<timestamp>/`, and the report carries **no
 * aggregate other than the four counts** — no pass rate, no ratio, no
 * percentage, here or on stdout. Counts carry the same information without a
 * quotable headline, and a headline is what turns a measurement into a gate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalExpected, EvalRole } from "./eval-pack.js";

/**
 * Bump when a version-1 report could be read differently than it is today.
 * The per-case key list in {@link EvalCaseResult} is exhaustive and its
 * presence rules are part of what this constant locks: a reader that finds an
 * unexpected key is reading a report this version does not describe.
 */
export const EVAL_REPORT_VERSION = 1;

const REPORT_FILENAME = "report.json";

/** The four outcome words, exactly (D23). There is no `STALE`. */
export type EvalOutcome = "MATCH" | "MISMATCH" | "NOT-RUN" | "ERROR";

export interface EvalCaseResult {
  id: string;
  role: EvalRole;
  source: string;
  outcome: EvalOutcome;
  expected: EvalExpected;
  /** `MATCH` and `MISMATCH` only — the projection that was compared. */
  actual?: EvalExpected;
  /** `ERROR` only. */
  error?: string;
  /** One case is exactly one call, so this is 0 or 1 (D14). */
  callsUsed: 0 | 1;
  /** Only when the provider reported it; absent, never 0 (B-20). */
  costUsd?: number;
  /** Only when the provider reported it; absent, never 0 (B-20). */
  toolCallCount?: number;
  /** Only when the case was dispatched. */
  durationMs?: number;
  /** Kept directories only: `MISMATCH` and `ERROR` (D34). */
  scratchDir?: string;
}

export interface EvalReport {
  version: 1;
  /** `INCOMPLETE` if and only if any case is `NOT-RUN`. */
  status: "COMPLETE" | "INCOMPLETE";
  provider: string;
  /** Absolute pack path. */
  pack: string;
  packVersion: 1;
  startedAt: string;
  finishedAt: string;
  maxCalls: number;
  /** Invocations dispatched, failed ones included. */
  callsUsed: number;
  /** Sum; present only when every dispatched case reported one (B-20). */
  costUsd?: number;
  counts: Record<EvalOutcome, number>;
  /** Declared order (D8, D19). */
  cases: EvalCaseResult[];
}

/**
 * Serialized key-by-key rather than by handing the object to `JSON.stringify`,
 * so B-19's exhaustive per-case key list and its presence rules live in one
 * readable place — this is what `EVAL_REPORT_VERSION = 1` locks.
 */
function serializeCase(result: EvalCaseResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: result.id,
    role: result.role,
    source: result.source,
    outcome: result.outcome,
    expected: result.expected,
  };
  if (result.actual !== undefined) out.actual = result.actual;
  if (result.error !== undefined) out.error = result.error;
  out.callsUsed = result.callsUsed;
  if (result.costUsd !== undefined) out.costUsd = result.costUsd;
  if (result.toolCallCount !== undefined) {
    out.toolCallCount = result.toolCallCount;
  }
  if (result.durationMs !== undefined) out.durationMs = result.durationMs;
  if (result.scratchDir !== undefined) out.scratchDir = result.scratchDir;
  return out;
}

/** Write `report.json` into a run directory and return its path. */
export function writeEvalReport(dir: string, report: EvalReport): string {
  const document: Record<string, unknown> = {
    version: EVAL_REPORT_VERSION,
    status: report.status,
    provider: report.provider,
    pack: report.pack,
    packVersion: report.packVersion,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    maxCalls: report.maxCalls,
    callsUsed: report.callsUsed,
  };
  if (report.costUsd !== undefined) document.costUsd = report.costUsd;
  document.counts = {
    MATCH: report.counts.MATCH,
    MISMATCH: report.counts.MISMATCH,
    "NOT-RUN": report.counts["NOT-RUN"],
    ERROR: report.counts.ERROR,
  };
  document.cases = report.cases.map(serializeCase);
  const path = join(dir, REPORT_FILENAME);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  return path;
}

/**
 * Read a report back, or throw naming the path. The persisted-fact rule wants
 * a reader for every written schema, and this runner's own tests are its first
 * consumer — which is the point: a report no reader accepts is not evidence.
 */
export function readEvalReport(path: string): EvalReport {
  let parsed: unknown;
  const text = readFileSync(path, "utf-8");
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== EVAL_REPORT_VERSION) {
    throw new Error(
      `${path} version ${JSON.stringify(document.version)} is not a supported eval report version (${EVAL_REPORT_VERSION})`,
    );
  }
  if (document.status !== "COMPLETE" && document.status !== "INCOMPLETE") {
    throw new Error(
      `${path} status ${JSON.stringify(document.status)} must be COMPLETE or INCOMPLETE`,
    );
  }
  if (!Array.isArray(document.cases)) {
    throw new Error(`${path} cases must be an array`);
  }
  return document as unknown as EvalReport;
}

/**
 * The one summary line (D20). Carried in `runEvalCli`'s returned `output` and
 * never streamed, so the CLI printing `output` cannot repeat a streamed line.
 */
export function formatEvalSummary(
  report: EvalReport,
  reportPath: string,
): string {
  const counts = report.counts;
  return (
    `afk eval ${report.status}: ` +
    `MATCH ${counts.MATCH} / MISMATCH ${counts.MISMATCH} / ` +
    `NOT-RUN ${counts["NOT-RUN"]} / ERROR ${counts.ERROR} — ` +
    `calls ${report.callsUsed}/${report.maxCalls} — ${reportPath}`
  );
}

/** The one streamed line per case, emitted as that case completes (D20). */
export function formatCaseLine(
  k: number,
  n: number,
  result: EvalCaseResult,
): string {
  return `[${k}/${n}] ${result.id} (${result.role}) ${result.outcome}`;
}
