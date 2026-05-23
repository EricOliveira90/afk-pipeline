import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";

/** Sum of invocation stats across all agent invocations for a slice. */
export interface SliceTotals {
  costUsd: number;
  toolCallCount: number;
}

export interface SliceStatus {
  ghIssue: string;
  title: string;
  status:
    | "PASS"
    | "FAIL"
    | "STUCK"
    | "SKIPPED"
    | "CONFLICT"
    | "RUNNING"
    | "PENDING"
    | "CANCELLED"
    | "LANE-CANCELLED";
  genRounds: number;
  evalRounds: number;
  branch: string;
  error?: string;
}

/**
 * Verdict from the pre-ship sanity gate (typecheck + lint + test suite run
 * against the merged feature branch, before opening the PR). `failures`
 * lists which steps tripped (e.g. `["lint"]`); empty when `ok` is true.
 */
export interface SanityGateResult {
  ok: boolean;
  failures: string[];
}

export interface RunLog {
  prdSlug: string;
  startedAt: Date;
  finishedAt?: Date;
  slices: Map<string, SliceStatus>;
  totals: Map<string, SliceTotals>;
  architectVerdict?: string;
  pmVerdict?: string;
  sanityGate?: SanityGateResult;
  prUrl?: string;
}

export class Logger {
  private logDir: string;
  private runLog: RunLog;

  constructor(repoRoot: string, prdSlug: string) {
    this.logDir = join(repoRoot, ".afk", "logs", prdSlug);
    mkdirSync(this.logDir, { recursive: true });
    this.runLog = {
      prdSlug,
      startedAt: new Date(),
      slices: new Map(),
      totals: new Map(),
    };
  }

  /** Add invocation stats to the running slice totals. */
  addInvocationStats(ghIssue: string, stats: InvocationStats) {
    const t = this.runLog.totals.get(ghIssue) ?? {
      costUsd: 0,
      toolCallCount: 0,
    };
    if (typeof stats.costUsd === "number") t.costUsd += stats.costUsd;
    if (typeof stats.toolCallCount === "number") {
      t.toolCallCount += stats.toolCallCount;
    }
    this.runLog.totals.set(ghIssue, t);
  }

  /** Append an idle-warning line to a slice's agent log. */
  writeIdleWarning(stream: WriteStream, agent: string, minutes: number) {
    stream.write(
      `\n[afk] ${agent} idle for ${minutes} minute${minutes === 1 ? "" : "s"}…\n`,
    );
  }

  /** Create a write stream for a specific agent invocation log. */
  agentLog(sliceId: string, agent: string, round?: number): WriteStream {
    const suffix = round != null ? `-r${round}` : "";
    const filename = `slice-${sliceId}-${agent}${suffix}.log`;
    return createWriteStream(join(this.logDir, filename), { flags: "a" });
  }

  setSliceStatus(ghIssue: string, status: Partial<SliceStatus>) {
    const existing = this.runLog.slices.get(ghIssue) ?? {
      ghIssue,
      title: "",
      status: "PENDING" as const,
      genRounds: 0,
      evalRounds: 0,
      branch: "",
    };
    this.runLog.slices.set(ghIssue, { ...existing, ...status });
  }

  setReviewVerdicts(architect?: string, pm?: string) {
    if (architect) this.runLog.architectVerdict = architect;
    if (pm) this.runLog.pmVerdict = pm;
  }

  setSanityGate(result: SanityGateResult) {
    this.runLog.sanityGate = result;
  }

  setPrUrl(url: string) {
    this.runLog.prUrl = url;
  }

  writeSummary() {
    this.runLog.finishedAt = new Date();
    const {
      prdSlug,
      startedAt,
      finishedAt,
      slices,
      architectVerdict,
      pmVerdict,
      sanityGate,
      prUrl,
    } = this.runLog;

    const statusIcon: Record<string, string> = {
      PASS: "✅",
      FAIL: "❌",
      STUCK: "🔴",
      SKIPPED: "⏭️",
      CONFLICT: "⚠️",
      RUNNING: "🔄",
      PENDING: "⏳",
      CANCELLED: "🚫",
      "LANE-CANCELLED": "⛔",
    };

    const totals = this.runLog.totals;
    let runCost = 0;
    let runToolCalls = 0;
    const rows = [...slices.values()]
      .map((s) => {
        const icon = statusIcon[s.status] ?? "❓";
        const rounds =
          s.status === "SKIPPED"
            ? "—"
            : `gen:${s.genRounds} eval:${s.evalRounds}`;
        const branchInfo =
          s.status === "PASS"
            ? "merged"
            : s.status === "STUCK" || s.status === "CONFLICT"
              ? "preserved"
              : s.status === "SKIPPED"
                ? "—"
                : s.branch;
        const t = totals.get(s.ghIssue);
        const cost = t && t.costUsd > 0 ? `$${t.costUsd.toFixed(4)}` : "—";
        const tools = t ? String(t.toolCallCount) : "—";
        if (t) {
          runCost += t.costUsd;
          runToolCalls += t.toolCallCount;
        }
        return `| ${s.ghIssue} ${s.title} | ${icon} ${s.status} | ${rounds} | ${branchInfo} | ${cost} | ${tools} |`;
      })
      .join("\n");

    const totalsRow = `| **Run totals** | | | | **${runCost > 0 ? `$${runCost.toFixed(4)}` : "—"}** | **${runToolCalls}** |`;

    const summary = `# Run Summary — ${prdSlug}

Started: ${startedAt.toISOString()}
Finished: ${finishedAt!.toISOString()}

| Slice | Status | Rounds | Branch | Cost | Tool calls |
|-------|--------|--------|--------|------|------------|
${rows}
${totalsRow}

Pre-ship sanity gate: ${
      sanityGate
        ? sanityGate.ok
          ? "PASS"
          : `FAIL (${sanityGate.failures.join(", ")})`
        : "N/A"
    }
Architect review: ${architectVerdict ?? "N/A"}
PM review: ${pmVerdict ?? "N/A"}
${prUrl ? `PR: ${prUrl}` : ""}
`;

    writeFileSync(join(this.logDir, "run-summary.md"), summary);
    return summary;
  }
}
