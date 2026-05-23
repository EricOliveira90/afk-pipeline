import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";
import {
  assertNever,
  bucketFor,
  lifecycle,
  statusIconFor,
  summaryStatusLabel,
  type SliceIdentity,
  type SliceLifecycle,
  type SliceProgress,
} from "./slice-lifecycle.js";

/** Sum of invocation stats across all agent invocations for a slice. */
export interface SliceTotals {
  costUsd: number;
  toolCallCount: number;
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
  slices: Map<string, SliceLifecycle>;
  totals: Map<string, SliceTotals>;
  architectVerdict?: string;
  pmVerdict?: string;
  sanityGate?: SanityGateResult;
  prUrl?: string;
}

const ZERO_PROGRESS: SliceProgress = { genRounds: 0, evalRounds: 0 };

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

  /**
   * Replace a slice's lifecycle state. The full variant is required, so
   * the type system rejects invalid transitions (e.g. PASS without
   * `mergedToFeature`).
   */
  transitionTo(ghIssue: string, next: SliceLifecycle) {
    this.runLog.slices.set(ghIssue, next);
  }

  /** Increment generator-round counter without changing phase. Throws on
   * SKIPPED — HITL slices have no generator rounds. */
  bumpGenRound(ghIssue: string, round: number) {
    const cur = this.requireWithProgress(ghIssue, "bumpGenRound");
    this.runLog.slices.set(ghIssue, {
      ...cur,
      progress: { ...cur.progress, genRounds: round },
    });
  }

  /** Increment evaluator-round counter without changing phase. */
  bumpEvalRound(ghIssue: string, round: number) {
    const cur = this.requireWithProgress(ghIssue, "bumpEvalRound");
    this.runLog.slices.set(ghIssue, {
      ...cur,
      progress: { ...cur.progress, evalRounds: round },
    });
  }

  /** Move slice to STUCK, preserving identity and progress. */
  markStuck(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markStuck");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(ghIssue, lifecycle.stuck(id, progress, error));
  }

  /** Move slice to CANCELLED, preserving identity and progress. */
  markCancelled(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markCancelled");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(ghIssue, lifecycle.cancelled(id, progress, error));
  }

  /** Move slice to ESCALATE, preserving identity and progress. */
  markEscalated(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markEscalated");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(ghIssue, lifecycle.escalate(id, progress, error));
  }

  /** Move slice to ERROR, preserving identity and progress. */
  markError(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markError");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(ghIssue, lifecycle.error(id, progress, error));
  }

  /** Move slice to CONFLICT, preserving identity and progress. */
  markConflict(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markConflict");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(ghIssue, lifecycle.conflict(id, progress, error));
  }

  /** Move slice to LANE-CANCELLED, preserving identity and progress. */
  markLaneCancelled(ghIssue: string, error: string) {
    const cur = this.requireSlice(ghIssue, "markLaneCancelled");
    const id = identityOf(cur);
    const progress = progressOf(cur) ?? ZERO_PROGRESS;
    this.runLog.slices.set(
      ghIssue,
      lifecycle.laneCancelled(id, progress, error),
    );
  }

  setReviewVerdicts(architect?: string, pm?: string) {
    if (architect) this.runLog.architectVerdict = architect;
    if (pm) this.runLog.pmVerdict = pm;
  }

  setFeatureBranch(name: string) {
    this.runLog.featureBranch = name;
  }

  /** Snapshot of a slice's current lifecycle, or undefined if not tracked. */
  getSlice(ghIssue: string): SliceLifecycle | undefined {
    return this.runLog.slices.get(ghIssue);
  }

  /** Current progress counters, or zeros if the slice isn't tracked yet. */
  getSliceProgress(ghIssue: string): SliceProgress {
    const cur = this.runLog.slices.get(ghIssue);
    return cur ? (progressOf(cur) ?? ZERO_PROGRESS) : ZERO_PROGRESS;
  }

  setSanityGate(result: SanityGateResult) {
    this.runLog.sanityGate = result;
  }

  setPrUrl(url: string) {
    this.runLog.prUrl = url;
  }

  private requireSlice(ghIssue: string, op: string): SliceLifecycle {
    const cur = this.runLog.slices.get(ghIssue);
    if (!cur) {
      throw new Error(`Logger.${op}: slice ${ghIssue} is not tracked yet`);
    }
    return cur;
  }

  private requireWithProgress(
    ghIssue: string,
    op: string,
  ): Exclude<SliceLifecycle, { phase: "SKIPPED" }> {
    const cur = this.requireSlice(ghIssue, op);
    if (cur.phase === "SKIPPED") {
      throw new Error(`Logger.${op}: cannot bump rounds on a SKIPPED slice`);
    }
    return cur;
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

    const totals = this.runLog.totals;
    let runCost = 0;
    let runToolCalls = 0;
    const rows = [...slices.values()]
      .map((s) => {
        const icon = statusIconFor(s.phase);
        const label = summaryStatusLabel(s.phase);
        const rounds = roundsCellFor(s);
        const branchInfo = branchInfoFor(s);
        const t = totals.get(s.ghIssue);
        const cost = t && t.costUsd > 0 ? `$${t.costUsd.toFixed(4)}` : "—";
        const tools = t ? String(t.toolCallCount) : "—";
        if (t) {
          runCost += t.costUsd;
          runToolCalls += t.toolCallCount;
        }
        return `| ${s.ghIssue} ${s.title} | ${icon} ${label} | ${rounds} | ${branchInfo} | ${cost} | ${tools} |`;
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
    const succeeded = all.filter((s) => bucketFor(s.phase) === "succeeded");
    const failed = all.filter((s) => bucketFor(s.phase) === "failed");
    const cancelled = all.filter((s) => bucketFor(s.phase) === "cancelled");
    const skipped = all.filter((s) => bucketFor(s.phase) === "skipped");
    const inFlight = all.filter((s) => bucketFor(s.phase) === "inFlight");

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
        const icon = statusIconFor(s.phase);
        const label = summaryStatusLabel(s.phase);
        const branch = s.branch || "(unknown)";
        lines.push(
          `  ${icon} #${s.ghIssue} ${s.title} [${label}] — branch preserved: ${branch}`,
        );
        if ("error" in s && s.error) lines.push(`       reason: ${s.error}`);
      }
    }
    lines.push("");

    if (cancelled.length > 0) {
      lines.push(`Cancelled (${cancelled.length}):`);
      for (const s of cancelled) {
        const icon = statusIconFor(s.phase);
        const label = summaryStatusLabel(s.phase);
        lines.push(`  ${icon} #${s.ghIssue} ${s.title} [${label}]`);
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
        lines.push(`  🔄 #${s.ghIssue} ${s.title} [${s.phase}]`);
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

function identityOf(s: SliceLifecycle): SliceIdentity {
  return { ghIssue: s.ghIssue, title: s.title, branch: s.branch };
}

function progressOf(s: SliceLifecycle): SliceProgress | null {
  return s.phase === "SKIPPED" ? null : s.progress;
}

function roundsCellFor(s: SliceLifecycle): string {
  switch (s.phase) {
    case "SKIPPED":
      return "—";
    case "PENDING":
    case "RUNNING":
    case "PASS":
    case "STUCK":
    case "ESCALATE":
    case "ERROR":
    case "CONFLICT":
    case "CANCELLED":
    case "LANE-CANCELLED":
      return `gen:${s.progress.genRounds} eval:${s.progress.evalRounds}`;
    default:
      return assertNever(s);
  }
}

function branchInfoFor(s: SliceLifecycle): string {
  switch (s.phase) {
    case "PASS":
      return "merged";
    case "STUCK":
    case "CONFLICT":
      return "preserved";
    case "SKIPPED":
      return "—";
    case "PENDING":
    case "RUNNING":
    case "ESCALATE":
    case "ERROR":
    case "CANCELLED":
    case "LANE-CANCELLED":
      return s.branch;
    default:
      return assertNever(s);
  }
}
