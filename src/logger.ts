import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  existsSync,
  WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";
import type { PromptAssemblyRole } from "./context-envelope.js";
import type { SanityGateResult } from "./preship.js";
import { readRunEvents } from "./run-events.js";
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

interface EnvelopeTotals {
  promptBytes: number;
  tokenCounts: Map<string, number>;
}

/**
 * The four assembled envelope roles (slice 04 B-06). The B-06 summary
 * columns are envelope totals — assembled prompt bytes beside their exposed
 * token counts — so both columns must aggregate the same invocation
 * population. Evaluator completion events ("evaluator-qa"/"evaluator-uat")
 * stay in events.jsonl for ADR 0046 but are excluded here because those
 * roles have no matching prompt-assembly record (architect round-7 A1).
 */
const ASSEMBLED_ENVELOPE_ROLES: ReadonlySet<string> = new Set<
  PromptAssemblyRole
>(["explorer", "planner", "evaluator-contract", "generator"]);

export interface DependencyBlocker {
  ghIssue: string;
  status: string;
}

interface DependencyHold {
  ghIssue: string;
  title: string;
  blockers: DependencyBlocker[];
}

export type { SanityGateResult };

/**
 * One-line operator rendering of the sanity gate verdict. A CONFIGURATION
 * failure is labelled the way the per-slice base gates are (`FAIL
 * (CONFIGURATION)`, see `gate-outcome` rendering below) so a broken
 * environment cannot be mistaken for a red suite in the artifact an operator
 * reads (#101).
 */
function sanityGateLabel(gate: SanityGateResult | undefined): string {
  if (!gate) return "N/A";
  if (gate.ok) return "PASS";
  const steps = gate.failures.join(", ");
  if (gate.failureKind !== "CONFIGURATION") return `FAIL (${steps})`;
  return `FAIL (CONFIGURATION) — ${steps}${gate.detail ? `: ${gate.detail}` : ""}`;
}

/**
 * The status cell for one gate row: the status, its failure kind when it
 * failed, and *why it cost nothing* when it cost nothing (#86 B-03, B-07).
 *
 * Both annotations are load-bearing for an operator: a bare `PASS (0ms)` reads
 * as a gate that did nothing, and a bare `SKIPPED` reads as a gate that was
 * quietly dropped. Naming the reuse and naming the failed prerequisite is what
 * keeps a cheaper run readable as the same verdict.
 */
function gateStatusCell(event: {
  status: string;
  failureKind: string | null;
  cacheReused?: boolean;
  prerequisiteSkipped?: string;
}): string {
  if (event.status === "FAIL" && event.failureKind) {
    return `FAIL (${event.failureKind})`;
  }
  if (event.status === "PASS" && event.cacheReused) return "PASS (cache reuse)";
  if (event.prerequisiteSkipped) {
    return `${event.status} (prerequisite ${event.prerequisiteSkipped} failed)`;
  }
  return event.status;
}

/**
 * One advisory gate outcome, for a reader outside this module. `src/ship-gate.ts`
 * renders these in the draft PR body from the same events the run summary
 * renders (#86 B-02), so the PR and the summary cannot disagree about which
 * advisory gate reported what.
 */
export interface AdvisoryGateOutcome {
  ghIssue: string;
  sliceNumber: string;
  round: number;
  gateId: string;
  status: string;
  durationMs: number;
}

/**
 * Every `environmentSensitive` gate outcome recorded in a run, in event order.
 * Empty when the run directory has no events or no advisory gate ran — an
 * absent block, never a throw, because a PR body must not depend on a log file.
 */
export function readAdvisoryGateOutcomes(
  runDir: string,
): AdvisoryGateOutcome[] {
  return (readRunEvents(runDir)?.events ?? []).flatMap((event) =>
    event.type === "gate-outcome" && event.environmentSensitive
      ? [
          {
            ghIssue: event.ghIssue,
            sliceNumber: event.sliceNumber,
            round: event.round,
            gateId: event.gateId,
            status: gateStatusCell(event),
            durationMs: event.durationMs,
          },
        ]
      : [],
  );
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
  /** Failure detail (e.g. the agent's stderr line) for a failed architect review. */
  architectDetail?: string;
  /** Failure detail (e.g. the agent's stderr line) for a failed PM review. */
  pmDetail?: string;
  sanityGate?: SanityGateResult;
  prUrl?: string;
  /** Set when the PR was opened via --open-pr-on-override (ADR 0015). */
  prOverrideNote?: string;
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
  private readonly dependencyHolds: DependencyHold[] = [];
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

  /**
   * Append an idle-warning line to a slice's agent log. Takes elapsed
   * silent SECONDS: the warning interval is 30 s, so the old
   * tick-count parameter printed an 80-minute gap as "161 minutes"
   * (issue #182).
   */
  writeIdleWarning(stream: WriteStream, agent: string, silentSeconds: number) {
    const minutes = Math.floor(silentSeconds / 60);
    const elapsed =
      minutes >= 1
        ? `${minutes} minute${minutes === 1 ? "" : "s"}`
        : `${Math.round(silentSeconds)}s`;
    stream.write(`\n[afk] ${agent} idle for ${elapsed}…\n`);
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

  recordDependencyHold(
    slice: Pick<SliceLifecycle, "ghIssue" | "title">,
    blockers: DependencyBlocker[],
  ) {
    if (
      !blockers.some(
        (blocker) => blocker.status === "AWAITING-ADJUDICATION",
      )
    ) {
      return;
    }
    this.dependencyHolds.push({
      ghIssue: slice.ghIssue,
      title: slice.title,
      blockers: [...blockers],
    });
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
    } = this.runLog;
    const runEvents = readRunEvents(this.runDir)?.events ?? [];
    const gateAttempts = runEvents.filter(
      (event) => event.type === "gate-outcome",
    );
    const envelopeTotals = new Map<string, EnvelopeTotals>();
    for (const event of runEvents) {
      // Prompt bytes come from the pre-dispatch assembly record; token
      // counts from the paired post-return completion record (guardian
      // round 2, PM 4). Absent fields aggregate as absent, never as 0.
      if (event.type === "prompt-assembly") {
        const total = envelopeTotals.get(event.ghIssue) ?? {
          promptBytes: 0,
          tokenCounts: new Map<string, number>(),
        };
        total.promptBytes += event.assembledByteSize;
        envelopeTotals.set(event.ghIssue, total);
      } else if (
        event.type === "invocation-completed" &&
        // Only assembled envelope roles enter B-06 totals; unassembled
        // evaluator roles would inflate the token column relative to the
        // prompt-bytes column (architect round-7 A1).
        ASSEMBLED_ENVELOPE_ROLES.has(event.role)
      ) {
        const total = envelopeTotals.get(event.ghIssue) ?? {
          promptBytes: 0,
          tokenCounts: new Map<string, number>(),
        };
        for (const [name, count] of Object.entries(event.tokenCounts ?? {})) {
          total.tokenCounts.set(
            name,
            (total.tokenCounts.get(name) ?? 0) + count,
          );
        }
        envelopeTotals.set(event.ghIssue, total);
      }
    }

    const totals = this.runLog.totals;
    let runCost = 0;
    let runToolCalls = 0;
    let runPromptBytes = 0;
    const runTokenCounts = new Map<string, number>();
    const rows = [...slices.values()]
      .map((s) => {
        const icon = statusIconFor(s.phase);
        const label = summaryStatusLabel(s.phase);
        const status =
          s.phase === "AWAITING-ADJUDICATION"
            ? `${icon} ${label} — ${s.error}`
            : `${icon} ${label}`;
        const rounds = roundsCellFor(s);
        const branchInfo = branchInfoFor(s);
        const t = totals.get(s.ghIssue);
        const cost = t && t.costUsd > 0 ? `$${t.costUsd.toFixed(4)}` : "—";
        const tools = t ? String(t.toolCallCount) : "—";
        const envelope = envelopeTotals.get(s.ghIssue);
        const promptBytes = envelope ? String(envelope.promptBytes) : "—";
        const tokenCounts = envelope
          ? formatTokenCounts(envelope.tokenCounts)
          : "—";
        if (t) {
          runCost += t.costUsd;
          runToolCalls += t.toolCallCount;
        }
        if (envelope) {
          runPromptBytes += envelope.promptBytes;
          for (const [name, count] of envelope.tokenCounts) {
            runTokenCounts.set(
              name,
              (runTokenCounts.get(name) ?? 0) + count,
            );
          }
        }
        return `| ${s.ghIssue} ${s.title} | ${status} | ${rounds} | ${branchInfo} | ${cost} | ${tools} | ${promptBytes} | ${tokenCounts} |`;
      })
      .join("\n");

    const totalsRow = `| **Run totals** | | | | **${runCost > 0 ? `$${runCost.toFixed(4)}` : "—"}** | **${runToolCalls}** | **${runPromptBytes > 0 ? runPromptBytes : "—"}** | **${formatTokenCounts(runTokenCounts)}** |`;
    // Advisory outcomes are rendered in their own block below rather than
    // among the base gates: an operator scanning this table is asking "what
    // blocked the candidate", and a red row that can never block does not
    // belong to that answer (#86 B-02, ADR 0063).
    const blockingAttempts = gateAttempts.filter(
      (event) => !event.environmentSensitive,
    );
    const advisoryAttempts = gateAttempts.filter(
      (event) => event.environmentSensitive,
    );
    const gateRows = blockingAttempts
      .map((event) => {
        return `| ${event.ghIssue} | ${event.round} | ${event.gateId} | ${gateStatusCell(event)} | ${event.durationMs}ms | ${event.evidenceArtifactId} | ${event.logArtifactId} |`;
      })
      .join("\n");
    const gateSection =
      blockingAttempts.length === 0
        ? ""
        : `
## Base Gates

| Slice | Round | Gate | Status | Elapsed | Evidence | Log |
|-------|-------|------|--------|---------|----------|-----|
${gateRows}
`;
    // Declared `environmentSensitive` gates: reported, never blocking. Present
    // only when such a gate ran, so every other run's summary is unchanged.
    const advisorySection =
      advisoryAttempts.length === 0
        ? ""
        : `
## Advisory Gates

Reported, never blocking: a wall-clock or environment-dependent result cannot
fail a gate (ADR 0063).

| Slice | Round | Gate | Status | Elapsed | Evidence | Log |
|-------|-------|------|--------|---------|----------|-----|
${advisoryAttempts
  .map(
    (event) =>
      `| ${event.ghIssue} | ${event.round} | ${event.gateId} | ${gateStatusCell(event)} | ${event.durationMs}ms | ${event.evidenceArtifactId} | ${event.logArtifactId} |`,
  )
  .join("\n")}
`;
    // The acceptance gate reports one aggregate outcome above; this is the
    // per-behavior breakdown behind it (#85 AC6). Rendered only when a
    // coverage event exists, so a run with no bound behavior — every run on a
    // project that never opted in — keeps today's summary byte-for-byte.
    const coverageAttempts = runEvents.filter(
      (event) => event.type === "behavior-coverage",
    );
    const coverageRows = coverageAttempts
      .map(
        (event) =>
          `| ${event.ghIssue} | ${event.round} | ${event.behaviorId} | ` +
          `${event.gateId} | ${event.status} | ${event.matched} | ` +
          `${event.passed} | ${event.failed} | ${event.evidenceArtifactId} | ` +
          `${event.logArtifactId} |`,
      )
      .join("\n");
    const coverageSection =
      coverageAttempts.length === 0
        ? ""
        : `
## Behavior Coverage

| Slice | Round | Behavior | Gate | Status | Matched | Passed | Failed | Evidence | Log |
|-------|-------|----------|------|--------|---------|--------|--------|----------|-----|
${coverageRows}
`;
    // The disposable review worktree's two records (#91 AC5/AC6): what one
    // deterministic PASS approved, and what the evaluator wrote that was
    // discarded. One section, because an operator reading it is asking one
    // question — what did candidate review establish, and did the reviewer
    // stay inside its allowlist. Rendered only when such an event exists, so
    // every other run's summary is unchanged.
    const isolationEvents = runEvents.filter(
      (event) =>
        event.type === "approved-baseline" ||
        event.type === "reviewer-write-violation",
    );
    const isolationRows = isolationEvents
      .map((event) =>
        event.type === "approved-baseline"
          ? `| ${event.ghIssue} | ${event.round} | approved-baseline | ` +
            `${event.treeId} | ${event.commit} | ${event.artifactId} |`
          : `| ${event.ghIssue} | ${event.round} | reviewer-write-violation | ` +
            `— | attempt ${event.attempt} | ${event.path} |`,
      )
      .join("\n");
    const isolationSection =
      isolationEvents.length === 0
        ? ""
        : `
## Candidate Review Isolation

| Slice | Round | Record | Tree | Commit / Attempt | Artifact / Path |
|-------|-------|--------|------|------------------|-----------------|
${isolationRows}
`;
    const dependencyRows = this.dependencyHolds
      .map(
        (hold) =>
          `| #${hold.ghIssue} ${hold.title} | ${hold.blockers
            .map((blocker) => `#${blocker.ghIssue} (${blocker.status})`)
            .join(", ")} |`,
      )
      .join("\n");
    const dependencySection =
      dependencyRows.length === 0
        ? ""
        : `
## Dependency Holds

| Slice | Blocked by |
|-------|------------|
${dependencyRows}
`;
    const adoptedEntries = [...slices.values()].flatMap((slice) =>
      slice.phase === "PASS" && slice.adoption
        ? [{ slice, adoption: slice.adoption }]
        : [],
    );
    const adoptionSection =
      adoptedEntries.length === 0
        ? ""
        : `
## Adopted Slices

${adoptedEntries
  .map(({ slice, adoption }) =>
    [
      `### #${slice.ghIssue} ${inlineMarkdown(slice.title)}`,
      "",
      `- Adopter: ${inlineMarkdown(adoption.adopter)}`,
      `- Reason: ${inlineMarkdown(adoption.reason)}`,
      `- Branch: ${inlineMarkdown(adoption.branch)}`,
      `- Commit: ${inlineMarkdown(adoption.commit)}`,
    ].join("\n"),
  )
  .join("\n\n")}
`;

    const summary = `# Run Summary — ${prdSlug}

Started: ${startedAt.toISOString()}
Finished: ${finishedAt!.toISOString()}

| Slice | Status | Rounds | Branch | Cost | Tool calls | Prompt bytes | Provider tokens |
|-------|--------|--------|--------|------|------------|--------------|-----------------|
${rows}
${totalsRow}
${dependencySection}${adoptionSection}
${gateSection}${advisorySection}${coverageSection}${isolationSection}

Pre-ship sanity gate: ${sanityGateLabel(sanityGate)}
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
    lines.push(`  Pre-ship sanity gate: ${sanityGateLabel(sanityGate)}`);
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
      if (sanityGate && !sanityGate.ok) {
        reasons.push(
          sanityGate.failureKind === "CONFIGURATION"
            ? "sanity gate could not run (CONFIGURATION)"
            : "sanity gate failed",
        );
      }
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

function formatTokenCounts(tokenCounts: ReadonlyMap<string, number>): string {
  if (tokenCounts.size === 0) return "—";
  return [...tokenCounts]
    .map(([name, count]) => `${name.replace(/\|/g, "\\|")}: ${count}`)
    .join(", ");
}

function inlineMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
    case "AWAITING-ADJUDICATION":
    case "ADJUDICATION-LOCK-REFUSED":
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
