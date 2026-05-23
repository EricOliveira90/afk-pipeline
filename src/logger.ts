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
  /** Feature branch the slices merge into. Set by the orchestrator. */
  featureBranch?: string;
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

  setFeatureBranch(name: string) {
    this.runLog.featureBranch = name;
  }

  /** Snapshot of a slice's current status, or undefined if not tracked. */
  getSliceStatus(ghIssue: string): SliceStatus | undefined {
    return this.runLog.slices.get(ghIssue);
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

  /**
   * Grouped, human-scan-friendly summary block for stdout. Unlike
   * `writeSummary`, this returns immediately without writing to disk —
   * safe to call from a `finally` block on any pipeline exit path
   * (success, slice failures, or thrown error mid-run).
   */
  formatConsoleSummary(): string {
    const {
      prdSlug,
      startedAt,
      finishedAt,
      featureBranch,
      slices,
      architectVerdict,
      pmVerdict,
      sanityGate,
      prUrl,
    } = this.runLog;

    const endTime = finishedAt ?? new Date();
    const durationMs = endTime.getTime() - startedAt.getTime();
    const totalSec = Math.floor(durationMs / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    const duration = `${mm}m${ss.toString().padStart(2, "0")}s`;

    const all = [...slices.values()];
    const succeeded = all.filter((s) => s.status === "PASS");
    const failed = all.filter(
      (s) =>
        s.status === "STUCK" ||
        s.status === "FAIL" ||
        s.status === "CONFLICT",
    );
    const cancelled = all.filter(
      (s) => s.status === "CANCELLED" || s.status === "LANE-CANCELLED",
    );
    const skipped = all.filter((s) => s.status === "SKIPPED");
    const inFlight = all.filter(
      (s) => s.status === "RUNNING" || s.status === "PENDING",
    );

    const lines: string[] = [];
    lines.push(`=== AFK Pipeline Summary — ${prdSlug} ===`);
    lines.push(`Duration: ${duration}`);
    lines.push("");

    const featLabel = featureBranch ?? "(unknown)";

    lines.push(`Succeeded (${succeeded.length}):`);
    if (succeeded.length === 0) {
      lines.push("  (none)");
    } else {
      for (const s of succeeded) {
        lines.push(
          `  ✅ #${s.ghIssue} ${s.title} — merged into ${featLabel}`,
        );
      }
    }
    lines.push("");

    lines.push(`Failed / Stuck (${failed.length}):`);
    if (failed.length === 0) {
      lines.push("  (none)");
    } else {
      for (const s of failed) {
        const icon =
          s.status === "STUCK"
            ? "🔴"
            : s.status === "CONFLICT"
              ? "⚠️"
              : "❌";
        lines.push(
          `  ${icon} #${s.ghIssue} ${s.title} [${s.status}] — branch preserved: ${s.branch || "(unknown)"}`,
        );
        if (s.error) lines.push(`       reason: ${s.error}`);
      }
    }
    lines.push("");

    if (cancelled.length > 0) {
      lines.push(`Cancelled (${cancelled.length}):`);
      for (const s of cancelled) {
        const icon = s.status === "LANE-CANCELLED" ? "⛔" : "🚫";
        lines.push(`  ${icon} #${s.ghIssue} ${s.title} [${s.status}]`);
      }
      lines.push("");
    }

    if (skipped.length > 0) {
      lines.push(`Skipped — HITL (${skipped.length}):`);
      for (const s of skipped) {
        lines.push(`  ⏭️ #${s.ghIssue} ${s.title}`);
      }
      lines.push("");
    }

    if (inFlight.length > 0) {
      lines.push(`In flight when summary was emitted (${inFlight.length}):`);
      for (const s of inFlight) {
        lines.push(`  🔄 #${s.ghIssue} ${s.title} [${s.status}]`);
      }
      lines.push("");
    }

    lines.push("Branches:");
    lines.push(`  feature: ${featLabel}`);
    const preservedBranches = [...failed, ...cancelled]
      .map((s) => s.branch)
      .filter((b): b is string => !!b && b !== "—");
    if (preservedBranches.length > 0) {
      lines.push(`  preserved per-slice: ${preservedBranches.join(", ")}`);
    }
    lines.push("");

    lines.push("Ready to merge:");
    const sanityLine = sanityGate
      ? sanityGate.ok
        ? "PASS"
        : `FAIL (${sanityGate.failures.join(", ")})`
      : "N/A";
    lines.push(`  Pre-ship sanity gate: ${sanityLine}`);
    lines.push(`  Architect review: ${architectVerdict ?? "N/A"}`);
    lines.push(`  PM review: ${pmVerdict ?? "N/A"}`);

    const shipVerdicts = ["SHIP", "ACCEPT-WITH-NOTES"];
    const sanityOk = !!sanityGate?.ok;
    const archOk = !!architectVerdict && shipVerdicts.includes(architectVerdict);
    const pmOk = !!pmVerdict && shipVerdicts.includes(pmVerdict);

    if (prUrl && sanityOk && archOk && pmOk) {
      lines.push(`  PR: ${prUrl}`);
    } else {
      const reasons: string[] = [];
      if (failed.length > 0) reasons.push(`${failed.length} slice(s) failed`);
      if (cancelled.length > 0) reasons.push(`${cancelled.length} cancelled`);
      if (sanityGate && !sanityGate.ok) reasons.push("sanity gate failed");
      if (!sanityGate) reasons.push("sanity gate not run");
      if (sanityGate?.ok) {
        if (!architectVerdict) reasons.push("architect review not run");
        else if (!archOk) reasons.push(`architect verdict ${architectVerdict}`);
        if (!pmVerdict) reasons.push("PM review not run");
        else if (!pmOk) reasons.push(`PM verdict ${pmVerdict}`);
      }
      const reasonText =
        reasons.length > 0 ? reasons.join("; ") : "reviews incomplete";
      lines.push(`  Not ready: ${reasonText}`);
    }

    return lines.join("\n");
  }
}
