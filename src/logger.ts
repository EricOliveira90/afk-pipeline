import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  existsSync,
  WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";
import type { GateEvidence, GateResult } from "./gate-runner.js";
import {
  assertNever,
  bucketFor,
  statusIconFor,
  summaryStatusLabel,
  traitsFor,
  type SliceLifecycle,
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
  gateAttempts: GateSummaryEntry[];
  architectVerdict?: string;
  pmVerdict?: string;
  /** Failure detail (e.g. the agent's stderr line) for a failed architect review. */
  architectDetail?: string;
  /** Failure detail (e.g. the agent's stderr line) for a failed PM review. */
  pmDetail?: string;
  sanityGate?: SanityGateResult;
  prUrl?: string;
  /** Set when the PR was opened via --open-pr-on-override (ADR 0015). */
  prOverrideNote?: string;
}

interface GateSummaryEntry {
  ghIssue: string;
  round: number;
  attemptId: string;
  evidenceArtifactId: string;
  result: GateResult;
}

/**
 * Directory name for one pipeline run's logs, derived from its start
 * time (e.g. `run-20260808-214501`). A numeric suffix disambiguates
 * runs that start within the same second (common in tests, possible in
 * re-entry loops). See ADR 0017.
 */
export function runDirNameFor(startedAt: Date, parentDir: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `run-${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}` +
    `-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  let candidate = base;
  for (let i = 2; existsSync(join(parentDir, candidate)); i++) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

export class Logger {
  private logDir: string;
  private runLog: RunLog;
  /**
   * Per-run log directory (`.afk/logs/<prd-slug>/run-<timestamp>/`).
   * Agent invocation logs and run.log live here, so a file's mtime and
   * size always describe THIS run — re-running the same PRD can no
   * longer make a stale log look live or a live log look stale by
   * appending into the previous run's files. See ADR 0017.
   */
  readonly runDir: string;

  constructor(
    repoRoot: string,
    prdSlug: string,
    slices: Map<string, SliceLifecycle>,
  ) {
    this.logDir = join(repoRoot, ".afk", "logs", prdSlug);
    mkdirSync(this.logDir, { recursive: true });
    const startedAt = new Date();
    this.runDir = join(this.logDir, runDirNameFor(startedAt, this.logDir));
    mkdirSync(this.runDir, { recursive: true });
    this.runLog = {
      prdSlug,
      startedAt,
      slices,
      totals: new Map(),
      gateAttempts: [],
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

  /**
   * Create a write stream for a specific agent invocation log, inside
   * this run's directory. Append mode is deliberate: within one run a
   * filename can be legitimately reopened (a lane successor re-runs
   * explorer/planner rounds after its refresh) and that history must
   * not be truncated. Cross-run append — the failure mode where run 3's
   * generator silently extended run 2's log — is impossible now that
   * each run has its own directory.
   */
  agentLog(sliceId: string, agent: string, round?: number): WriteStream {
    const suffix = round != null ? `-r${round}` : "";
    const filename = `slice-${sliceId}-${agent}${suffix}.log`;
    return createWriteStream(join(this.runDir, filename), { flags: "a" });
  }

  /**
   * Record full review outcomes, including the failure detail (typically
   * the failing agent's stderr line) that must surface in the run
   * summary — not only in launcher stderr. See ADR 0015.
   */
  setReviewOutcomes(
    architect?: { outcome: string; detail?: string },
    pm?: { outcome: string; detail?: string },
  ) {
    if (architect) {
      this.runLog.architectVerdict = architect.outcome;
      this.runLog.architectDetail = sanitizeDetail(architect.detail);
    }
    if (pm) {
      this.runLog.pmVerdict = pm.outcome;
      this.runLog.pmDetail = sanitizeDetail(pm.detail);
    }
  }

  /** Note that the PR was opened despite an unfavorable PM verdict. */
  setPrOverrideNote(note: string) {
    this.runLog.prOverrideNote = note;
  }

  setFeatureBranch(name: string) {
    this.runLog.featureBranch = name;
  }

  setSanityGate(result: SanityGateResult) {
    this.runLog.sanityGate = result;
  }

  setPrUrl(url: string) {
    this.runLog.prUrl = url;
  }

  addGateAttempt(
    ghIssue: string,
    round: number,
    evidence: GateEvidence,
    evidenceArtifactId: string,
  ) {
    for (const result of evidence.results) {
      this.runLog.gateAttempts.push({
        ghIssue,
        round,
        attemptId: evidence.attemptId,
        evidenceArtifactId,
        result,
      });
    }
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
      architectDetail,
      pmDetail,
      sanityGate,
      prUrl,
      prOverrideNote,
      gateAttempts,
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
    const gateRows = gateAttempts
      .map(({ ghIssue, round, evidenceArtifactId, result }) => {
        const status =
          result.status === "FAIL" && result.failureKind
            ? `${result.status} (${result.failureKind})`
            : result.status;
        return `| ${ghIssue} | ${round} | ${result.gateId} | ${status} | ${result.durationMs}ms | ${evidenceArtifactId} | ${result.logArtifactId} |`;
      })
      .join("\n");
    const gateSection =
      gateAttempts.length === 0
        ? ""
        : `
## Base Gates

| Slice | Round | Gate | Status | Elapsed | Evidence | Log |
|-------|-------|------|--------|---------|----------|-----|
${gateRows}
`;

    const summary = `# Run Summary — ${prdSlug}

Started: ${startedAt.toISOString()}
Finished: ${finishedAt!.toISOString()}

| Slice | Status | Rounds | Branch | Cost | Tool calls |
|-------|--------|--------|--------|------|------------|
${rows}
${totalsRow}
${gateSection}

Pre-ship sanity gate: ${
      sanityGate
        ? sanityGate.ok
          ? "PASS"
          : `FAIL (${sanityGate.failures.join(", ")})`
        : "N/A"
    }
Architect review: ${architectVerdict ?? "N/A"}${architectDetail ? ` — ${architectDetail}` : ""}
PM review: ${pmVerdict ?? "N/A"}${pmDetail ? ` — ${pmDetail}` : ""}
${prUrl ? `PR: ${prUrl}` : ""}${prOverrideNote ? `\n${prOverrideNote}` : ""}
`;

    writeFileSync(join(this.logDir, "run-summary.md"), summary);
    // Per-run archive copy — the stable path above is overwritten by
    // every run; the copy preserves each run's summary next to its logs.
    try {
      writeFileSync(join(this.runDir, "run-summary.md"), summary);
    } catch {
      // Best effort — the stable copy above is the contract.
    }
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
      architectDetail,
      pmDetail,
      sanityGate,
      prUrl,
      prOverrideNote,
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
    const deferred = all.filter((s) => bucketFor(s.phase) === "deferred");
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

    // Merge deferred (ADR 0029) gets its own section: the work passed QA
    // and is committed — reporting it under "Failed / Stuck" would tell
    // the operator to go fix something that fixes itself next run.
    if (deferred.length > 0) {
      lines.push(`Merge deferred (${deferred.length}):`);
      for (const s of deferred) {
        const icon = statusIconFor(s.phase);
        const label = summaryStatusLabel(s.phase);
        const branch = s.branch || "(unknown)";
        lines.push(
          `  ${icon} #${s.ghIssue} ${s.title} [${label}] — branch preserved: ${branch}`,
        );
        if ("error" in s && s.error) lines.push(`       reason: ${s.error}`);
      }
      lines.push("");
    }

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
    lines.push(
      `  Architect review: ${architectVerdict ?? "N/A"}${architectDetail ? ` — ${architectDetail}` : ""}`,
    );
    lines.push(
      `  PM review: ${pmVerdict ?? "N/A"}${pmDetail ? ` — ${pmDetail}` : ""}`,
    );

    const shipVerdicts = ["SHIP", "ACCEPT-WITH-NOTES"];
    const infraOutcomes = ["NEVER_RAN", "DIED_MID_RUN"];
    const sanityOk = !!sanityGate?.ok;
    const archOk = !!architectVerdict && shipVerdicts.includes(architectVerdict);
    const pmOk = !!pmVerdict && shipVerdicts.includes(pmVerdict);

    if (prUrl && (prOverrideNote || (sanityOk && archOk && pmOk))) {
      lines.push(`  PR: ${prUrl}`);
      if (prOverrideNote) lines.push(`  ${prOverrideNote}`);
    } else {
      const reasons: string[] = [];
      if (failed.length > 0) reasons.push(`${failed.length} slice(s) failed`);
      if (cancelled.length > 0) reasons.push(`${cancelled.length} cancelled`);
      if (sanityGate && !sanityGate.ok) reasons.push("sanity gate failed");
      if (!sanityGate) reasons.push("sanity gate not run");
      if (sanityGate?.ok) {
        if (!architectVerdict) reasons.push("architect review not run");
        else if (!archOk)
          reasons.push(
            infraOutcomes.includes(architectVerdict)
              ? `architect review ${architectVerdict}`
              : `architect verdict ${architectVerdict}`,
          );
        if (!pmVerdict) reasons.push("PM review not run");
        else if (!pmOk)
          reasons.push(
            infraOutcomes.includes(pmVerdict)
              ? `PM review ${pmVerdict}`
              : `PM verdict ${pmVerdict}`,
          );
      }
      const reasonText =
        reasons.length > 0 ? reasons.join("; ") : "reviews incomplete";
      lines.push(`  Not ready: ${reasonText}`);
    }

    return lines.join("\n");
  }
}

/**
 * Collapse a failure detail (often multi-line agent stderr) to a single
 * bounded line so it can sit inline in run-summary.md.
 */
function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const collapsed = detail.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > 400 ? `${collapsed.slice(0, 397)}...` : collapsed;
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
    case "MERGE-PENDING":
    case "CANCELLED":
    case "LANE-CANCELLED":
      return `gen:${s.progress.genRounds} eval:${s.progress.evalRounds}`;
    default:
      return assertNever(s);
  }
}

function branchInfoFor(s: SliceLifecycle): string {
  switch (traitsFor(s.phase).branchDisposition) {
    case "merged":
      return "merged";
    case "preserved":
      return "preserved";
    case "none":
      return "—";
    case "branch":
      return s.branch;
  }
}
