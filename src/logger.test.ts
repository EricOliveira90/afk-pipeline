import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAdvisoryGateOutcomes,
  readQualityStageOutcomes,
} from "./logger.js";
import {
  RunJournal as Logger,
  type TerminalOutcome,
} from "./run-journal.js";
import {
  EVENTS_SCHEMA_VERSION,
  type RunEventPayload,
} from "./run-events.js";
import {
  MAX_CLEANER_ROUNDS,
  MAX_FINAL_EVALUATION_ATTEMPTS,
} from "./bounds.js";
import { parseGatePolicy, type GatePolicy } from "./gate-policy.js";
import { lifecycle } from "./slice-lifecycle.js";

const tempDirs: string[] = [];
type QualityStageAttemptInput = Parameters<
  Logger["recordQualityStageAttempt"]
>[0];
type JournalTestInput =
  | RunEventPayload
  | { qualityStageAttempt: QualityStageAttemptInput };

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-logger-"));
  tempDirs.push(dir);
  return dir;
}

function recordedPayloads(log: Logger): Array<Record<string, unknown>> {
  return readFileSync(join(log.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const { ts: _ts, ...payload } = JSON.parse(line) as Record<
        string,
        unknown
      >;
      return payload;
    });
}

function recordTestInput(log: Logger, input: JournalTestInput) {
  if ("qualityStageAttempt" in input) {
    log.recordQualityStageAttempt(input.qualityStageAttempt);
  } else {
    log.event(input);
  }
}

function qualityStageAttempt(
  input: QualityStageAttemptInput,
): JournalTestInput {
  return { qualityStageAttempt: input };
}

const PROGRESS = { genRounds: 1, evalRounds: 2 };

function id(ghIssue: string, title: string, branch: string) {
  return { ghIssue, title, branch };
}

function recordTerminal(
  log: Logger,
  sliceId: ReturnType<typeof id>,
  outcome: TerminalOutcome,
) {
  log.trackSlice(lifecycle.running(sliceId, PROGRESS));
  log.recordTerminal(sliceId, outcome);
}

describe("Logger.writeIdleWarning", () => {
  // Issue #182: the warning interval is 30 s, so passing the tick count
  // printed an 80-minute gap as "idle for 161 minutes". The parameter is
  // elapsed silent SECONDS.
  function capture(silentSeconds: number): string {
    const lines: string[] = [];
    const stream = {
      write: (text: string) => lines.push(text),
    } as unknown as Parameters<Logger["writeIdleWarning"]>[0];
    new Logger(makeRepo(), "idle").writeIdleWarning(
      stream,
      "generator",
      silentSeconds,
    );
    return lines.join("");
  }

  it("renders elapsed silence in minutes once past a minute", () => {
    expect(capture(4_800)).toContain("generator idle for 80 minutes…");
    expect(capture(60)).toContain("generator idle for 1 minute…");
  });

  it("renders sub-minute silence in seconds rather than rounding to 0", () => {
    expect(capture(30)).toContain("generator idle for 30s…");
  });
});

describe("Logger.formatConsoleSummary", () => {
  it("groups every phase into its bucket exhaustively", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "buckets");
    log.setFeatureBranch("feat/buckets");

    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    recordTerminal(log, id("2", "Stuck", "afk/2"), {
      phase: "STUCK",
      error: "QA failed",
    });
    recordTerminal(log, id("3", "Esc", "afk/3"), {
      phase: "ESCALATE",
      error: "negotiation gave up",
    });
    recordTerminal(log, id("4", "Err", "afk/4"), {
      phase: "ERROR",
      error: "boom",
    });
    recordTerminal(log, id("5", "Conf", "afk/5"), {
      phase: "CONFLICT",
      error: "merge",
    });
    recordTerminal(log, id("6", "Can", "afk/6"), {
      phase: "CANCELLED",
      error: "user abort",
    });
    recordTerminal(log, id("7", "Lane", "afk/7"), {
      phase: "LANE-CANCELLED",
      error: "predecessor failed",
    });
    log.trackSlice(lifecycle.skipped(id("8", "Hitl", "—")));
    log.trackSlice(
      lifecycle.running(id("9", "Run", "afk/9"), PROGRESS),
    );

    const out = log.formatConsoleSummary();
    expect(out).toContain("Succeeded (1):");
    // ESCALATE + ERROR + STUCK + CONFLICT all bucket as failed (4 entries).
    expect(out).toContain("Failed / Stuck (4):");
    expect(out).toContain("Cancelled (2):"); // CANCELLED + LANE-CANCELLED
    expect(out).toContain("Skipped — HITL (1):");
    expect(out).toContain("In flight when summary was emitted (1):");
    // ESCALATE / ERROR collapse to STUCK in display label
    expect(out).toContain("[STUCK]");
    expect(out).not.toContain("[ESCALATE]");
    expect(out).not.toContain("[ERROR]");
  });
});

describe("Logger.bumpGenRound / bumpEvalRound", () => {
  it("bumps counters without changing phase", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "bumps");
    log.trackSlice(lifecycle.running(id("1", "x", "afk/1"), {
      genRounds: 0,
      evalRounds: 0,
    }));
    log.bumpGenRound("1", 3);
    log.bumpEvalRound("1", 2);
    const cur = log.getSlice("1");
    expect(cur?.phase).toBe("RUNNING");
    expect(log.getSliceProgress("1")).toEqual({ genRounds: 3, evalRounds: 2 });
  });

  it("throws when bumping rounds on a SKIPPED slice", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "bumps");
    log.trackSlice(lifecycle.skipped(id("1", "h", "—")));
    expect(() => log.bumpGenRound("1", 1)).toThrow(/SKIPPED/);
  });
});

describe("Logger.writeSummary (run-summary.md byte stability)", () => {
  it("preserves every byte of a summary without adopted slices", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
      const repo = makeRepo();
      const log = new Logger(repo, "ordinary");
      log.restoreCompleted(id("130", "Pipeline finish", "afk/demo-02"));

      expect(log.writeSummary()).toBe(`# Run Summary — ordinary

Started: 2026-08-29T12:00:00.000Z
Finished: 2026-08-29T12:00:00.000Z

| Slice | Status | Rounds | Branch | Cost | Tool calls | Prompt bytes | Provider tokens |
|-------|--------|--------|--------|------|------------|--------------|-----------------|
| 130 Pipeline finish | ✅ PASS | gen:0 eval:0 | merged | — | — | — | — |
| **Run totals** | | | | **—** | **0** | **—** | **—** |



Pre-ship sanity gate: N/A
Architect review: N/A
PM review: N/A

`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-06 renders per-behavior coverage as its own section beside Base Gates", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "coverage");
    recordTerminal(log, id("85", "Coverage gate", "afk/85"), { phase: "PASS" });
    const shared = {
      ghIssue: "85",
      sliceNumber: "02",
      round: 1,
      attemptId: "a1",
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    };
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "acceptance:behaviors",
      stage: "acceptance",
      status: "FAIL",
      failureKind: "COMMAND",
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:04.000Z",
      durationMs: 4000,
      exitCode: null,
    });
    log.event({
      type: "behavior-coverage",
      ...shared,
      behaviorId: "B-01",
      gateId: "acceptance:behaviors",
      status: "covered",
      matched: 3,
      passed: 3,
      failed: 0,
    });
    log.event({
      type: "behavior-coverage",
      ...shared,
      behaviorId: "B-02",
      gateId: "acceptance:behaviors",
      status: "untested",
      matched: 0,
      passed: 0,
      failed: 0,
    });

    const md = log.writeSummary();
    // Beside the aggregate outcome, not instead of it: the gate reports one
    // row above, and this section is the per-behavior breakdown behind it.
    expect(md.indexOf("## Base Gates")).toBeGreaterThan(-1);
    expect(md.indexOf("## Behavior Coverage")).toBeGreaterThan(
      md.indexOf("## Base Gates"),
    );
    const coverage = md.slice(md.indexOf("## Behavior Coverage"));
    expect(coverage).toContain(
      "| 85 | 1 | B-01 | acceptance:behaviors | covered | 3 | 3 | 0 | ev-1 | log-1 |",
    );
    expect(coverage).toContain(
      "| 85 | 1 | B-02 | acceptance:behaviors | untested | 0 | 0 | 0 | ev-1 | log-1 |",
    );
    expect(md).toContain("Pre-ship sanity gate: N/A");
  });

  /**
   * Candidate review isolation is invisible in the log otherwise: the approved
   * baseline is a file an operator has to know exists, and a reviewer write
   * that fell outside the allowlist was silently discarded (#91 AC5/AC3). One
   * section answers both questions, and it renders only when such an event
   * exists so every other run's summary keeps its bytes.
   */
  it("[behavior:B-09] renders the approved baseline and reviewer-write violations", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "isolation");
    recordTerminal(log, id("70", "Isolated review", "afk/70"), {
      phase: "PASS",
    });
    log.event({
      type: "approved-baseline",
      ghIssue: "70",
      sliceNumber: "01",
      round: 2,
      treeId: "tree-abc",
      commit: "commit-def",
      artifactId: "baseline-1",
    });
    log.event({
      type: "reviewer-write-violation",
      ghIssue: "70",
      sliceNumber: "01",
      round: 2,
      attempt: 1,
      path: "src/orchestrator.ts",
    });
    log.event({
      type: "reviewer-write-violation",
      ghIssue: "70",
      sliceNumber: "01",
      round: 2,
      attempt: 2,
      path: "probe.txt",
    });

    const md = log.writeSummary();
    const section = md.slice(md.indexOf("## Candidate Review Isolation"));
    expect(md).toContain("## Candidate Review Isolation");
    expect(section).toContain(
      "| 70 | 2 | approved-baseline | tree-abc | commit-def | baseline-1 |",
    );
    expect(section).toContain(
      "| 70 | 2 | reviewer-write-violation | — | attempt 1 | src/orchestrator.ts |",
    );
    expect(section).toContain(
      "| 70 | 2 | reviewer-write-violation | — | attempt 2 | probe.txt |",
    );
    expect(md).toContain("Pre-ship sanity gate: N/A");
  });

  it("[behavior:B-09] renders no isolation section for a run without those events", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "no-isolation");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });

    expect(log.writeSummary()).not.toContain("## Candidate Review Isolation");
  });

  it("P-03 renders no empty coverage section when no coverage event exists", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "no-coverage");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.event({
      type: "gate-outcome",
      ghIssue: "1",
      sliceNumber: "01",
      round: 1,
      attemptId: "a1",
      gateId: "typecheck",
      stage: "base",
      status: "PASS",
      failureKind: null,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    });

    const md = log.writeSummary();
    expect(md).toContain("## Base Gates");
    expect(md).not.toContain("## Behavior Coverage");
    // The existing section keeps its exact tail, so an opted-out project's
    // summary is byte-for-byte today's.
    expect(md).toContain(
      "| 1 | 1 | typecheck | PASS | 1000ms | ev-1 | log-1 |\n\n\n" +
        "Pre-ship sanity gate: N/A",
    );
  });

  it("[behavior:B-14] renders an Applied Waivers section naming all four fields", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "waived");
    recordTerminal(log, id("193", "Feedback integrity", "afk/193"), {
      phase: "PASS",
    });
    log.event({
      type: "waiver-applied",
      ghIssue: "193",
      sliceNumber: "07",
      round: 1,
      riskClass: "deleted-test",
      path: "src/legacy-parser.test.ts",
      author: "eric",
      reason: "the module it covered was deleted with it",
    });

    const md = log.writeSummary();
    expect(md).toContain("## Applied Waivers");
    const section = md.slice(md.indexOf("## Applied Waivers"));
    expect(section).toContain(
      "| 193 | 1 | deleted-test | src/legacy-parser.test.ts | eric | " +
        "the module it covered was deleted with it |",
    );
  });

  it("[behavior:B-14] QA-01: renders one row per authorization, not one per round", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "waived-twice");
    recordTerminal(log, id("193", "Feedback integrity", "afk/193"), {
      phase: "PASS",
    });
    // The post-QA gate phase re-runs on every implementation round, so the same
    // launch authorization is honored — and journalled — once per round. That is
    // one human decision, and the summary has to read as one.
    for (const round of [1, 2]) {
      log.event({
        type: "waiver-applied",
        ghIssue: "193",
        sliceNumber: "07",
        round,
        riskClass: "deleted-test",
        path: "src/legacy-parser.test.ts",
        author: "eric",
        reason: "the module it covered was deleted with it",
      });
    }
    // A different path under the same class is a different decision.
    log.event({
      type: "waiver-applied",
      ghIssue: "193",
      sliceNumber: "07",
      round: 2,
      riskClass: "deleted-test",
      path: "src/other-parser.test.ts",
      author: "eric",
      reason: "the module it covered was deleted with it",
    });

    const md = log.writeSummary();
    const section = md.slice(md.indexOf("## Applied Waivers"));
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| 193 |"));
    expect(rows).toHaveLength(2);
    // The surviving row carries the round the waiver was first applied.
    expect(rows[0]).toBe(
      "| 193 | 1 | deleted-test | src/legacy-parser.test.ts | eric | " +
        "the module it covered was deleted with it |",
    );
    expect(rows[1]).toBe(
      "| 193 | 2 | deleted-test | src/other-parser.test.ts | eric | " +
        "the module it covered was deleted with it |",
    );
  });

  it("[behavior:P-06] renders no Applied Waivers section when nothing was waived", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "unwaived");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.event({
      type: "gate-outcome",
      ghIssue: "1",
      sliceNumber: "01",
      round: 1,
      attemptId: "a1",
      gateId: "typecheck",
      stage: "base",
      status: "PASS",
      failureKind: null,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    });

    const md = log.writeSummary();
    expect(md).not.toContain("## Applied Waivers");
    // The same exact tail the pre-#193 summary had: a run nobody waived
    // anything for is byte-for-byte today's.
    expect(md).toContain(
      "| 1 | 1 | typecheck | PASS | 1000ms | ev-1 | log-1 |\n\n\n" +
        "Pre-ship sanity gate: N/A",
    );
  });

  it("[behavior:B-03] renders a reused PASS as a reused one, and a prerequisite skip naming the gate that failed", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "cheap");
    recordTerminal(log, id("86", "Cost", "afk/86"), { phase: "PASS" });
    const shared = {
      ghIssue: "86",
      sliceNumber: "05",
      round: 1,
      attemptId: "a1",
      stage: "base" as const,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:00.000Z",
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    };
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "typecheck",
      status: "PASS",
      failureKind: null,
      durationMs: 0,
      exitCode: 0,
      cacheReused: true,
    });
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "lint",
      status: "FAIL",
      failureKind: "COMMAND",
      durationMs: 900,
      exitCode: 1,
    });
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "tests",
      status: "SKIPPED",
      failureKind: null,
      durationMs: 0,
      exitCode: null,
      prerequisiteSkipped: "lint",
    });

    const md = log.writeSummary();
    // A 0ms PASS is otherwise indistinguishable from a gate that did nothing,
    // so reuse is named in the cell rather than left to be inferred.
    expect(md).toContain("| 86 | 1 | typecheck | PASS (cache reuse) | 0ms |");
    expect(md).toContain("| 86 | 1 | lint | FAIL (COMMAND) | 900ms |");
    expect(md).toContain(
      "| 86 | 1 | tests | SKIPPED (prerequisite lint failed) | 0ms |",
    );
  });

  it("[behavior:B-02] renders an environmentSensitive gate in its own advisory block, never among the base gates", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "advisory");
    recordTerminal(log, id("86", "Cost", "afk/86"), { phase: "PASS" });
    const shared = {
      ghIssue: "86",
      sliceNumber: "05",
      round: 2,
      attemptId: "a1",
      stage: "base" as const,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:02.000Z",
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    };
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "tests",
      status: "PASS",
      failureKind: null,
      durationMs: 2000,
      exitCode: 0,
    });
    log.event({
      type: "gate-outcome",
      ...shared,
      gateId: "test:budgets",
      status: "FAIL",
      failureKind: "COMMAND",
      durationMs: 300,
      exitCode: 1,
      environmentSensitive: true,
    });

    const md = log.writeSummary();
    const gates = md.slice(
      md.indexOf("## Base Gates"),
      md.indexOf("## Advisory Gates"),
    );
    // An operator scanning `## Base Gates` is asking what blocked the
    // candidate, and a red row that can never block is not part of that
    // answer (ADR 0063).
    expect(gates).toContain("| 86 | 2 | tests | PASS | 2000ms |");
    expect(gates).not.toContain("test:budgets");
    expect(md.indexOf("## Advisory Gates")).toBeGreaterThan(
      md.indexOf("## Base Gates"),
    );
    const advisory = md.slice(md.indexOf("## Advisory Gates"));
    expect(advisory).toContain("never blocking");
    expect(advisory).toContain("| 86 | 2 | test:budgets | FAIL (COMMAND) | 300ms |");

    // The same events answer the PR body's reader, so the two renderings
    // cannot disagree about which advisory gate reported what.
    expect(readAdvisoryGateOutcomes(log.runDir)).toEqual([
      {
        ghIssue: "86",
        sliceNumber: "05",
        round: 2,
        gateId: "test:budgets",
        status: "FAIL (COMMAND)",
        durationMs: 300,
      },
    ]);
  });

  it("[behavior:B-02] renders no advisory block, and reads no advisory outcome, for a run with none", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "no-advisory");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.event({
      type: "gate-outcome",
      ghIssue: "1",
      sliceNumber: "01",
      round: 1,
      attemptId: "a1",
      gateId: "typecheck",
      stage: "base",
      status: "PASS",
      failureKind: null,
      startedAt: "2026-09-09T00:00:00.000Z",
      endedAt: "2026-09-09T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      treeId: "tree-abc",
      evidenceArtifactId: "ev-1",
      logArtifactId: "log-1",
    });

    const md = log.writeSummary();
    expect(md).not.toContain("## Advisory Gates");
    expect(readAdvisoryGateOutcomes(log.runDir)).toEqual([]);
    // And a directory with no events at all is an empty list, not a throw: a
    // PR body must not depend on a log file existing.
    expect(readAdvisoryGateOutcomes(join(repo, "nowhere"))).toEqual([]);
  });

  it("renders provenance for an adopted completed slice only", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "adopted");
    log.restoreCompleted(id("129", "Manual finish", "manual/demo-01"), {
      adopter: "Ada Lovelace",
      reason: "finished the slice manually",
      branch: "manual/demo-01",
      commit: "abc123",
    });
    log.restoreCompleted(id("130", "Pipeline finish", "afk/demo-02"));

    const md = log.writeSummary();
    const adoptedSection = md.slice(md.indexOf("## Adopted Slices"));

    expect(adoptedSection).toContain("129 Manual finish");
    expect(adoptedSection).toContain("Ada Lovelace");
    expect(adoptedSection).toContain("finished the slice manually");
    expect(adoptedSection).toContain("manual/demo-01");
    expect(adoptedSection).toContain("abc123");
    expect(adoptedSection).not.toContain("130 Pipeline finish");
  });

  it("renders ESCALATE and ERROR as STUCK in the markdown table", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "summary");
    log.setFeatureBranch("feat/summary");

    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    recordTerminal(log, id("2", "Esc", "afk/2"), {
      phase: "ESCALATE",
      error: "negotiation gave up",
    });
    recordTerminal(log, id("3", "Err", "afk/3"), {
      phase: "ERROR",
      error: "boom",
    });

    const md = log.writeSummary();
    // Header row + three data rows + totals row
    expect(md).toContain("| 1 Pass | ✅ PASS |");
    expect(md).toContain("| 2 Esc | 🔴 STUCK |");
    expect(md).toContain("| 3 Err | 🔴 STUCK |");
    expect(md).not.toContain("ESCALATE |");
    expect(md).not.toContain("| 3 Err | 🔴 ERROR |");
  });

  // #101: `FAIL (install)` read exactly like a red suite in the artifact an
  // operator reads. The base-gate vocabulary distinguishes the two.
  it("renders a sanity environment failure as FAIL (CONFIGURATION), not as a red suite", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-config");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["install"],
      failureKind: "CONFIGURATION",
      detail: "pnpm install --frozen-lockfile failed (exit 1): ERR_PNPM_X",
      skipped: [],
    });

    const md = log.writeSummary();

    expect(md).toContain(
      "Pre-ship sanity gate: FAIL (CONFIGURATION) — install: " +
        "pnpm install --frozen-lockfile failed (exit 1): ERR_PNPM_X",
    );
    expect(log.formatConsoleSummary()).toContain(
      "FAIL (CONFIGURATION) — install",
    );
  });

  // #272: a Windows crash-range exit (0xC0000374, heap corruption under memory
  // pressure) read as `FAIL (CONFIGURATION)` and sent an operator to debug an
  // environment that a plain relaunch cleared.
  it("renders a killed sanity process as ABNORMAL TERMINATION, not as CONFIGURATION", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-crash");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["install"],
      failureKind: null,
      terminationKind: "ABNORMAL_EXIT",
      detail:
        "pnpm install --frozen-lockfile terminated abnormally (exit 3221226356 " +
        "= 0xC0000374 STATUS_HEAP_CORRUPTION) — relaunch the run",
      skipped: [],
    });

    const md = log.writeSummary();

    expect(md).toContain(
      "Pre-ship sanity gate: FAIL (ABNORMAL TERMINATION) — install: " +
        "pnpm install --frozen-lockfile terminated abnormally",
    );
    expect(md).toContain("0xC0000374 STATUS_HEAP_CORRUPTION");
    expect(md).not.toContain("CONFIGURATION");
    const console_ = log.formatConsoleSummary();
    expect(console_).toContain("FAIL (ABNORMAL TERMINATION) — install");
    // The "Not ready" line names the action, not a broken environment.
    expect(console_).toContain(
      "sanity gate process was killed (ABNORMAL TERMINATION) — relaunch",
    );
    expect(console_).not.toContain("could not run (CONFIGURATION)");
  });

  it("names a red step's captured output beside the failing step (#272)", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-red-detail");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["tests"],
      failureKind: "COMMAND",
      detail:
        "tests failed (exit 1) — output: C:\\runs\\sanity-tests.log: " +
        "Test Files 1 failed | 359 passed (360)",
      skipped: [],
    });

    expect(log.writeSummary()).toContain(
      "Pre-ship sanity gate: FAIL (tests): tests failed (exit 1) — output: " +
        "C:\\runs\\sanity-tests.log: Test Files 1 failed | 359 passed (360)",
    );
  });

  it("keeps the plain FAIL rendering for a red suite", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-command");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["typecheck", "tests"],
      failureKind: "COMMAND",
      skipped: [],
    });

    expect(log.writeSummary()).toContain(
      "Pre-ship sanity gate: FAIL (typecheck, tests)",
    );
  });

  // #238: this repo has no `lint` script, so its lint step has never run — and
  // every green pre-ship gate in its history read as three steps passing.
  it("names the steps a passing sanity gate never ran (#238)", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-skipped");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: true,
      failures: [],
      failureKind: null,
      skipped: [{ name: "lint", scripts: ["lint"] }],
    });

    const md = log.writeSummary();

    expect(md).toContain(
      'Pre-ship sanity gate: PASS (skipped: lint — no "lint" script)',
    );
    expect(log.formatConsoleSummary()).toContain(
      'Pre-ship sanity gate: PASS (skipped: lint — no "lint" script)',
    );
  });

  it("names every absent script of a skipped step, and stays bare when none are (#238)", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-skipped-many");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: true,
      failures: [],
      failureKind: null,
      skipped: [
        { name: "lint", scripts: ["lint"] },
        { name: "tests", scripts: ["test:run", "test"] },
      ],
    });

    expect(log.writeSummary()).toContain(
      "Pre-ship sanity gate: PASS (skipped: " +
        'lint — no "lint" script; tests — no "test:run"/"test" script)',
    );

    const clean = new Logger(repo, "sanity-no-skips");
    recordTerminal(clean, id("1", "Pass", "afk/1"), { phase: "PASS" });
    clean.setSanityGate({
      ok: true,
      failures: [],
      failureKind: null,
      skipped: [],
    });
    expect(clean.writeSummary()).toContain("Pre-ship sanity gate: PASS\n");
  });

  it("keeps naming a skipped step beside a red one (#238)", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-skipped-red");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["tests"],
      failureKind: "COMMAND",
      skipped: [{ name: "lint", scripts: ["lint"] }],
    });

    expect(log.writeSummary()).toContain(
      'Pre-ship sanity gate: FAIL (tests) [skipped: lint — no "lint" script]',
    );
  });

  it("names dependents held by a parked adjudication issue", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "impasse-hold");
    recordTerminal(log, id("81", "Parked", "afk/81"), {
      phase: "AWAITING-ADJUDICATION",
      error: "contract impasse on F-01",
    });
    log.recordDependencyHold(
      id("82", "Dependent", "afk/82"),
      [{ ghIssue: "81", status: "AWAITING-ADJUDICATION" }],
    );

    const md = log.writeSummary();

    expect(md).toContain("#82 Dependent");
    expect(md).toContain("#81 (AWAITING-ADJUDICATION)");
  });

  it("omits dependency holds for ordinary failures", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "ordinary-failure");
    recordTerminal(log, id("81", "Failed", "afk/81"), {
      phase: "STUCK",
      error: "QA failed",
    });
    log.recordDependencyHold(
      id("82", "Dependent", "afk/82"),
      [{ ghIssue: "81", status: "STUCK" }],
    );

    const md = log.writeSummary();

    expect(md).not.toContain("## Dependency Holds");
    expect(md).not.toContain("#82 Dependent");
  });

  it("B-06 totals exact prompt bytes and only available token names per slice and run", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "envelope-totals");
    log.restoreCompleted(id("41", "First", "afk/41"));
    log.restoreCompleted(id("42", "Second", "afk/42"));
    const evidence = {
      type: "prompt-assembly" as const,
      sliceNumber: "01",
      round: 1,
      role: "generator" as const,
      includedArtifactClasses: ["contract-view"],
      includedArtifactIds: ["slice/contract.md"],
      omittedArtifactClasses: ["prior-conversation"],
      contextManifestVersion: 1,
    };
    const completion = {
      type: "invocation-completed" as const,
      sliceNumber: "01",
      round: 1,
      role: "generator" as const,
    };
    // Bytes ride on the pre-dispatch assembly record; tokens on the paired
    // post-return completion record (guardian round 2, PM 4).
    log.event({ ...evidence, ghIssue: "41", assembledByteSize: 101 });
    log.event({
      ...completion,
      ghIssue: "41",
      tokenCounts: { input_tokens: 11, output_tokens: 7 },
    });
    log.event({
      ...evidence,
      ghIssue: "41",
      round: 2,
      assembledByteSize: 29,
    });
    log.event({
      ...completion,
      ghIssue: "41",
      round: 2,
      tokenCounts: { input_tokens: 3 },
    });
    log.event({
      ...evidence,
      ghIssue: "42",
      sliceNumber: "02",
      assembledByteSize: 70,
    });
    log.event({
      ...completion,
      ghIssue: "42",
      sliceNumber: "02",
      tokenCounts: { cached_input_tokens: 5 },
    });

    const md = log.writeSummary();
    expect(md).toContain(
      "| 41 First | ✅ PASS | gen:0 eval:0 | merged | — | — | 130 | input_tokens: 14, output_tokens: 7 |",
    );
    expect(md).toContain(
      "| 42 Second | ✅ PASS | gen:0 eval:0 | merged | — | — | 70 | cached_input_tokens: 5 |",
    );
    expect(md).toContain(
      "**200** | **input_tokens: 14, output_tokens: 7, cached_input_tokens: 5**",
    );
    const secondRow = md
      .split("\n")
      .find((line) => line.startsWith("| 42 Second |"))!;
    expect(secondRow).not.toContain("output_tokens:");
    expect(secondRow).not.toContain(", input_tokens:");
  });

  // Architect round-7 A1: runQAStage emits evaluator-qa/evaluator-uat
  // completion events (kept in events.jsonl for ADR 0046), but those roles
  // have no prompt-assembly record, so their token counts must not enter
  // the B-06 envelope totals — both columns aggregate the same population.
  it("excludes unassembled evaluator token counts from B-06 envelope totals", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "envelope-totals-evaluator");
    log.restoreCompleted(id("41", "First", "afk/41"));
    log.event({
      type: "prompt-assembly",
      ghIssue: "41",
      sliceNumber: "01",
      round: 1,
      role: "generator",
      assembledByteSize: 101,
      includedArtifactClasses: ["contract-view"],
      includedArtifactIds: ["slice/contract.md"],
      omittedArtifactClasses: ["prior-conversation"],
      contextManifestVersion: 1,
    });
    log.event({
      type: "invocation-completed",
      ghIssue: "41",
      sliceNumber: "01",
      round: 1,
      role: "generator",
      tokenCounts: { input_tokens: 11, output_tokens: 7 },
    });
    log.event({
      type: "invocation-completed",
      ghIssue: "41",
      sliceNumber: "01",
      round: 1,
      role: "evaluator-qa",
      attempt: 1,
      tokenCounts: { input_tokens: 999 },
      nonCommandTimeMs: 1234,
    });
    log.event({
      type: "invocation-completed",
      ghIssue: "41",
      sliceNumber: "01",
      round: 1,
      role: "evaluator-uat",
      tokenCounts: { input_tokens: 999, output_tokens: 999 },
      nonCommandTimeMs: 5678,
    });

    const md = log.writeSummary();

    // Per-slice and run totals are byte-for-byte what they would be
    // without the evaluator events: 999 never enters either column.
    expect(md).toContain(
      "| 41 First | ✅ PASS | gen:0 eval:0 | merged | — | — | 101 | input_tokens: 11, output_tokens: 7 |",
    );
    expect(md).toContain(
      "**101** | **input_tokens: 11, output_tokens: 7**",
    );
    expect(md).not.toContain("999");
  });
});


describe("Logger per-run log separation (ADR 0017)", () => {
  it("gives each Logger its own run directory under the prd log dir", () => {
    const repo = makeRepo();
    const first = new Logger(repo, "reruns");
    const second = new Logger(repo, "reruns");

    expect(first.runDir).not.toBe(second.runDir);
    expect(existsSync(first.runDir)).toBe(true);
    expect(existsSync(second.runDir)).toBe(true);
    // Both live under .afk/logs/<slug>/ and are named run-<timestamp>.
    const parent = join(repo, ".afk", "logs", "reruns");
    const runDirs = readdirSync(parent).filter((d) =>
      /^run-\d{8}-\d{6}/.test(d),
    );
    expect(runDirs.length).toBe(2);
  });

  it("writes agent logs into the run directory, not the shared prd dir", async () => {
    const repo = makeRepo();
    const log = new Logger(repo, "agent-logs");
    const stream = log.agentLog("07", "generator", 1);
    stream.write("hello from run\n");
    await new Promise<void>((resolve) => stream.end(resolve));

    const expected = join(log.runDir, "slice-07-generator-r1.log");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toContain("hello from run");
    // The pre-fix location must NOT receive the log — a re-run appending
    // to the previous run's file is exactly the defect this prevents.
    expect(
      existsSync(join(repo, ".afk", "logs", "agent-logs", "slice-07-generator-r1.log")),
    ).toBe(false);
  });

  it("a second run reusing the same filename does not touch the first run's log", async () => {
    const repo = makeRepo();
    const run1 = new Logger(repo, "isolation");
    const s1 = run1.agentLog("07", "generator", 1);
    s1.write("run one\n");
    await new Promise<void>((resolve) => s1.end(resolve));

    const run2 = new Logger(repo, "isolation");
    const s2 = run2.agentLog("07", "generator", 1);
    s2.write("run two\n");
    await new Promise<void>((resolve) => s2.end(resolve));

    const first = readFileSync(
      join(run1.runDir, "slice-07-generator-r1.log"),
      "utf-8",
    );
    const second = readFileSync(
      join(run2.runDir, "slice-07-generator-r1.log"),
      "utf-8",
    );
    expect(first).toBe("run one\n");
    expect(second).toBe("run two\n");
  });
});

describe("Logger.phase (run.log, ADR 0017)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends a timestamped line to run.log and echoes to stderr by default", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "phases");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    log.phase("[afk] Wave 1: dispatching 2 slice(s) [01, 02]");

    expect(errSpy).toHaveBeenCalledWith(
      "[afk] Wave 1: dispatching 2 slice(s) [01, 02]",
    );
    const content = readFileSync(join(log.runDir, "run.log"), "utf-8");
    // ISO-8601 timestamp prefix, then the message verbatim.
    expect(content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[afk\] Wave 1: dispatching 2 slice\(s\) \[01, 02\]\n$/,
    );
  });

  it("routes echo through console.log / console.warn when asked", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "phases-via");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    log.phase("stdout line", "log");
    log.phase("warn line", "warn");

    expect(logSpy).toHaveBeenCalledWith("stdout line");
    expect(warnSpy).toHaveBeenCalledWith("warn line");
    const content = readFileSync(join(log.runDir, "run.log"), "utf-8");
    expect(content).toContain("stdout line");
    expect(content).toContain("warn line");
  });

  it("accumulates lines in order across calls", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "phases-order");
    vi.spyOn(console, "error").mockImplementation(() => {});
    log.phase("first");
    log.phase("second");
    const lines = readFileSync(join(log.runDir, "run.log"), "utf-8")
      .trim()
      .split("\n");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });
});

describe("Logger.writeSummary per-run copy", () => {
  it("P-04 preserves both stable and per-run summary copies", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "summary-copy");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    const md = log.writeSummary();

    const stable = join(repo, ".afk", "logs", "summary-copy", "run-summary.md");
    const perRun = join(log.runDir, "run-summary.md");
    expect(readFileSync(stable, "utf-8")).toBe(md);
    expect(readFileSync(perRun, "utf-8")).toBe(md);
  });
});


/**
 * Structured events tee (spec #26 / slice #27). Beside the human
 * run.log, the Logger tees operator-meaningful transitions into
 * `events.jsonl` in the same run directory: a `version: 1` header
 * event first (copying the handoff.json convention), then one JSON
 * line per event, in append order. run.log is byte-for-byte unchanged
 * by the tee.
 */
describe("Logger events tee (events.jsonl)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function eventLines(runDir: string): Array<Record<string, unknown>> {
    return readFileSync(join(runDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("writes a version-1 header event as the first line of events.jsonl", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "events-header");

    const lines = eventLines(log.runDir);
    expect(lines[0]).toMatchObject({ type: "header", version: 1 });
    expect(lines[0]!.ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("appends timestamped events in call order after the header", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "events-order");

    log.event({ type: "run-started", provider: "stub", runSlug: "events-order" });
    log.event({
      type: "slice-outcome",
      slice: lifecycle.pass(id("1", "Pass", "afk/1"), PROGRESS, true),
    });

    const lines = eventLines(log.runDir);
    expect(lines.map((l) => l.type)).toEqual([
      "header",
      "run-started",
      "slice-outcome",
    ]);
    expect(lines[1]).toMatchObject({ provider: "stub" });
    // The slice-outcome payload serializes the SliceLifecycle variant
    // verbatim — no parallel status vocabulary.
    expect(lines[2]!.slice).toEqual(
      lifecycle.pass(id("1", "Pass", "afk/1"), PROGRESS, true),
    );
    for (const line of lines) {
      expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("phase() with a structured payload tees the event and leaves run.log unchanged", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "events-tee");
    vi.spyOn(console, "error").mockImplementation(() => {});

    log.phase("[afk] Pipeline run started (stub)", "error", {
      type: "run-started",
      provider: "stub",
      runSlug: "events-tee",
    });

    // run.log carries exactly the human line — no JSON leakage.
    const runLog = readFileSync(join(log.runDir, "run.log"), "utf-8");
    expect(runLog).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[afk\] Pipeline run started \(stub\)\n$/,
    );
    // events.jsonl carries the structured form.
    const lines = eventLines(log.runDir);
    expect(lines[1]).toMatchObject({ type: "run-started", provider: "stub" });
  });

  it("phase() without a payload writes nothing to events.jsonl", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "events-nopayload");
    vi.spyOn(console, "error").mockImplementation(() => {});

    log.phase("[afk] plain human line");

    const lines = eventLines(log.runDir);
    expect(lines).toHaveLength(1); // header only
  });
});

/**
 * The quality-stage record (#274): one additive event type, one pure payload
 * builder, and one `run-summary.md` section rendered from that event alone.
 *
 * The builder is proved here rather than in a spawned run — the first rung of
 * AGENTS.md's ladder. The `enabled: true` branch needs a policy with a `clean`
 * member, and the only shipped one is `templates/quality-policy/afk.config.json`;
 * feeding the parsed template to a unit test costs milliseconds, whereas
 * proving that branch in a real stream would mean giving a spawned fixture
 * repo a `gatePolicy.clean` — turning the cleaner on inside a scenario that
 * exists to assert something else — or enabling it for this repository, which
 * the PRD puts out of scope. The disabled branch is corroborated in a real
 * stream by the orchestrator-runs and wave `[behavior:#274:B-06]` assertions.
 */
describe("[behavior:#274:B-05] the quality-stage-policy event", () => {
  const TEMPLATE_DIR = fileURLToPath(
    new URL("../templates/quality-policy", import.meta.url),
  );

  /** The shipped starter's parsed policy — the one policy with a `clean`. */
  function templatePolicy(): GatePolicy {
    const config = JSON.parse(
      readFileSync(join(TEMPLATE_DIR, "afk.config.json"), "utf-8"),
    ) as { gatePolicy: unknown };
    return parseGatePolicy(config.gatePolicy);
  }

  it("[behavior:#274:B-05] keeps the events schema at version 1, because the member is additive", () => {
    expect(EVENTS_SCHEMA_VERSION).toBe(1);
  });

  it("[behavior:#274:B-05] admits the payload as a typed literal", () => {
    const log = new Logger(makeRepo(), "stage-event-literal");
    log.recordQualityStagePolicy(templatePolicy());
    expect(recordedPayloads(log)[0]).toMatchObject({
      type: "quality-stage-policy",
      stage: "cleaner",
      enabled: true,
      source: "afk.config.json",
    });
  });

  it("[behavior:#274:B-07] reads enabled and the gate ids off the shipped template's policy", () => {
    const log = new Logger(makeRepo(), "stage-policy-enabled");
    log.recordQualityStagePolicy(templatePolicy());
    expect(recordedPayloads(log)[0]).toEqual({
      type: "quality-stage-policy",
      stage: "cleaner",
      enabled: true,
      // Declaration order, not sorted: the record must agree with the file it
      // was read from, and that is the order the cleaner would run them in.
      gateIds: [
        "clean:format",
        "clean:lint",
        "clean:typecheck",
        "clean:coverage-changed",
        "clean:complexity",
        "clean:duplication",
        "clean:architecture",
      ],
      source: "afk.config.json",
    });
  });

  it("[behavior:#274:B-07] reads a clean-less policy and null alike as disabled", () => {
    const { clean: _clean, ...cleanLess } = templatePolicy();
    const disabled = {
      type: "quality-stage-policy",
      stage: "cleaner",
      enabled: false,
      gateIds: [],
      source: "afk.config.json",
    };
    // The member's presence is the whole switch, so "no policy at all" and "a
    // policy that declares no clean stage" are one answer, not two.
    const cleanLessLog = new Logger(makeRepo(), "stage-policy-clean-less");
    cleanLessLog.recordQualityStagePolicy(cleanLess);
    expect(recordedPayloads(cleanLessLog)[0]).toEqual(disabled);
    const nullLog = new Logger(makeRepo(), "stage-policy-null");
    nullLog.recordQualityStagePolicy(null);
    expect(recordedPayloads(nullLog)[0]).toEqual(disabled);
  });

  it("[behavior:#274:B-07] never reaches past the snapshot it is handed", () => {
    // Pure: no filesystem, no repo root, no per-slice context (#251). Proved
    // by a hand-built policy the parser never saw producing exactly its ids.
    const handBuilt = {
      version: 1 as const,
      protectedPaths: { gatePolicyPaths: [], testGlobs: [] },
      riskClasses: [],
      clean: {
        gates: [
          {
            id: "only:gate",
            command: "pnpm",
            args: [],
            required: true,
            expectedCostMs: 1,
          },
        ],
        additionalWriteScope: [],
        suppressionDetectors: [],
      },
    };
    const log = new Logger(makeRepo(), "stage-policy-snapshot");
    log.recordQualityStagePolicy(handBuilt);
    expect(recordedPayloads(log)[0]?.gateIds).toEqual(["only:gate"]);
  });
});

describe("[behavior:#274:B-08] run-summary.md's Quality Stages section", () => {
  function summaryWith(
    slug: string,
    event?: Extract<RunEventPayload, { type: "quality-stage-policy" }>,
  ): string {
    const log = new Logger(makeRepo(), slug);
    log.restoreCompleted(id("274", "Quality policy starter", "afk/274"));
    if (event) log.event(event);
    return log.writeSummary();
  }

  it("[behavior:#274:B-08] names the stage, its enabled state and every gate id", () => {
    const md = summaryWith("stage-enabled", {
      type: "quality-stage-policy",
      stage: "cleaner",
      enabled: true,
      gateIds: ["clean:format", "clean:lint"],
      source: "afk.config.json",
    });

    expect(md).toContain("## Quality Stages");
    const section = md.slice(md.indexOf("## Quality Stages"));
    expect(section).toContain("`cleaner`: enabled");
    expect(section).toContain("gates `clean:format`, `clean:lint`");
    expect(section).toContain("(source: afk.config.json)");
  });

  it("[behavior:#274:B-08] [behavior:#97:P-07] renders the line in the disabled case too", () => {
    const md = summaryWith("stage-disabled", {
      type: "quality-stage-policy",
      stage: "cleaner",
      enabled: false,
      gateIds: [],
      source: "afk.config.json",
    });

    // A run that said nothing here could not be read as evidence of either
    // state — which is the whole reason this section is unconditional.
    expect(md).toContain("## Quality Stages");
    const section = md.slice(md.indexOf("## Quality Stages"));
    expect(section).toContain("`cleaner`: disabled");
    expect(section).toContain("no gates declared");
    expect(section).not.toContain("enabled");
  });

  it("[behavior:#274:B-08] [behavior:#97:P-06] renders no section for a stream without the event", () => {
    // A historical stream carries none, so its summary stays byte-identical.
    const md = summaryWith("stage-absent");
    expect(md).not.toContain("## Quality Stages");
    expect(md).not.toContain("cleaner");
    // And every other section still renders: the totals row and the trailing
    // lines are untouched (P-04).
    expect(md).toContain("| **Run totals** |");
    expect(md).toContain("Pre-ship sanity gate: N/A");
  });
});

/**
 * The ROI evidence family (#97 B-06/B-09/B-10).
 *
 * Unit tests over a hand-written stream, for the reason the #274 block above
 * gives: what is being asserted is a derivation from events, and a spawned
 * pipeline would prove the derivation only incidentally while costing seconds on
 * every run. The stream really is written and really is read back through
 * `readRunEvents`, so the serialization is exercised rather than mocked.
 */
describe("[behavior:#97:B-06] the quality-stage-attempt event", () => {
  const ATTEMPT = {
    ghIssue: "97",
    sliceNumber: "03",
    round: 1,
    stage: "cleaner" as const,
    stageRound: 2,
    attempt: 2,
    inputTreeId: "a".repeat(40),
    outputTreeId: "b".repeat(40),
    gateIds: ["clean:format", "scope"],
    outcome: "PASS",
    startedAt: "2026-09-13T00:00:00.000Z",
    endedAt: "2026-09-13T00:00:04.000Z",
    durationMs: 4_000,
    cacheReusedGateIds: ["scope"],
  };

  it("[behavior:#97:B-06] keeps the events schema at version 1, because the member is additive", () => {
    expect(EVENTS_SCHEMA_VERSION).toBe(1);
  });

  it("[behavior:#97:B-06] builds exactly PRD D11's fields and nothing else", () => {
    const log = new Logger(makeRepo(), "attempt-fields");
    log.recordQualityStageAttempt(ATTEMPT);
    expect(recordedPayloads(log)[0]).toEqual({
      type: "quality-stage-attempt",
      ...ATTEMPT,
    });
  });

  it("[behavior:#97:B-06] omits outputTreeId when no tree of the attempt survived", () => {
    const { outputTreeId: _dropped, ...withoutOutput } = ATTEMPT;
    const log = new Logger(makeRepo(), "attempt-without-output");
    log.recordQualityStageAttempt(withoutOutput);
    const event = recordedPayloads(log)[0]!;
    // Omitted, not `undefined`: a serialized line carries only what the attempt
    // actually knows, and `"outputTreeId": null` would be a claim about a tree.
    expect("outputTreeId" in event).toBe(false);
  });

  it("[behavior:#97:B-06] copies the id arrays, so a later mutation cannot rewrite the record", () => {
    const gateIds = ["clean:format"];
    const cacheReusedGateIds = ["scope"];
    const log = new Logger(makeRepo(), "attempt-defensive-copies");
    log.recordQualityStageAttempt({
      ...ATTEMPT,
      gateIds,
      cacheReusedGateIds,
    });
    gateIds.push("clean:lint");
    cacheReusedGateIds.push("clean:lint");
    const event = recordedPayloads(log)[0]!;
    expect(event.gateIds).toEqual(["clean:format"]);
    expect(event.cacheReusedGateIds).toEqual(["scope"]);
  });

  it("[behavior:#97:B-06] tees through the journal as a typed literal", () => {
    const attempt: QualityStageAttemptInput = ATTEMPT;
    const log = new Logger(makeRepo(), "attempt-event-literal");
    log.recordQualityStageAttempt(attempt);
    expect(recordedPayloads(log)[0]).toMatchObject({
      type: "quality-stage-attempt",
      ...ATTEMPT,
    });
  });

  it("[behavior:#97:B-06] records synchronously in call order", () => {
    const log = new Logger(makeRepo(), "attempt-event-order");
    log.event({
      type: "run-started",
      provider: "stub",
      runSlug: "attempt-event-order",
    });
    log.recordQualityStageAttempt(ATTEMPT);
    log.recordQualityStagePolicy(null);

    expect(recordedPayloads(log).map((event) => event.type)).toEqual([
      "run-started",
      "quality-stage-attempt",
      "quality-stage-policy",
    ]);
  });
});

describe("[behavior:#97:B-09] readQualityStageOutcomes", () => {
  /** A run directory holding exactly the events a test names. */
  function streamWith(
    slug: string,
    events: readonly JournalTestInput[],
  ): Logger {
    const log = new Logger(makeRepo(), slug);
    for (const event of events) recordTestInput(log, event);
    return log;
  }

  const attempt = (
    overrides: Partial<QualityStageAttemptInput>,
  ): JournalTestInput =>
    qualityStageAttempt({
      ghIssue: "97",
      sliceNumber: "03",
      round: 1,
      stage: "cleaner",
      stageRound: 1,
      attempt: 1,
      inputTreeId: "a".repeat(40),
      outputTreeId: "b".repeat(40),
      gateIds: ["clean:format"],
      outcome: "FAIL",
      startedAt: "2026-09-13T00:00:00.000Z",
      endedAt: "2026-09-13T00:00:01.000Z",
      durationMs: 1_000,
      cacheReusedGateIds: [],
      ...overrides,
    });

  it("[behavior:#97:B-09] returns one entry per (ghIssue, stage) with the rounds, elapsed and gate ids pooled", () => {
    const log = streamWith("outcomes-pooled", [
      {
        type: "quality-stage-policy",
        stage: "cleaner",
        enabled: true,
        gateIds: ["clean:format"],
        source: "afk.config.json",
      },
      attempt({ stageRound: 1, durationMs: 1_000 }),
      attempt({
        stageRound: 2,
        durationMs: 2_500,
        outcome: "PASS",
        gateIds: ["clean:format", "scope"],
        cacheReusedGateIds: ["scope"],
      }),
      attempt({
        stage: "final-evaluation",
        stageRound: 1,
        attempt: 1,
        gateIds: ["scope"],
        outcome: "PASS",
        durationMs: 700,
      }),
    ]);

    const outcomes = readQualityStageOutcomes(log.runDir);
    expect(outcomes.map((outcome) => outcome.stage)).toEqual([
      "cleaner",
      "final-evaluation",
    ]);
    expect(outcomes[0]).toMatchObject({
      ghIssue: "97",
      sliceNumber: "03",
      stage: "cleaner",
      enabled: true,
      // The last attempt's outcome is the stage's: a stage that ended PASS
      // after one FAIL passed.
      outcome: "PASS",
      roundsUsed: 2,
      roundLimit: MAX_CLEANER_ROUNDS,
      elapsedMs: 3_500,
      gateIds: ["clean:format", "scope"],
      cacheReusedGateIds: ["scope"],
      // No `final-evaluation-reuse` on this stream, so the tree was graded.
      finalDecision: "evaluate",
    });
    expect(outcomes[1]).toMatchObject({
      stage: "final-evaluation",
      roundLimit: MAX_FINAL_EVALUATION_ATTEMPTS,
      elapsedMs: 700,
    });
  });

  it("[behavior:#97:B-09] sums model ms from the stage-duration events already on the stream, matched on issue and agent", () => {
    const log = streamWith("outcomes-model-ms", [
      attempt({ stage: "cleaner", stageRound: 1 }),
      attempt({ stage: "final-evaluation", stageRound: 1, gateIds: ["scope"] }),
      { type: "stage-duration", ghIssue: "97", agent: "cleaner", durationMs: 900, history: null },
      { type: "stage-duration", ghIssue: "97", agent: "cleaner", durationMs: 100, history: null },
      {
        type: "stage-duration",
        ghIssue: "97",
        agent: "evaluator-final",
        durationMs: 400,
        history: null,
      },
      // Another slice's cleaner, and a role that is neither stage: neither is
      // this slice's model time.
      { type: "stage-duration", ghIssue: "98", agent: "cleaner", durationMs: 5_000, history: null },
      { type: "stage-duration", ghIssue: "97", agent: "generator", durationMs: 5_000, history: null },
    ]);

    const outcomes = readQualityStageOutcomes(log.runDir);
    expect(outcomes.find((o) => o.stage === "cleaner")?.modelMs).toBe(1_000);
    expect(outcomes.find((o) => o.stage === "final-evaluation")?.modelMs).toBe(
      400,
    );
  });

  it("[behavior:#97:B-09] reports model ms 0 when no stage-duration sample exists", () => {
    // A stage whose `phase-ended` never arrived contributes no sample, and "no
    // evidence" is `0` rather than a guess.
    const log = streamWith("outcomes-no-samples", [attempt({})]);
    expect(readQualityStageOutcomes(log.runDir)[0]?.modelMs).toBe(0);
  });

  it("[behavior:#97:B-09] counts a released round 0 as an attempt that spent no round", () => {
    const tree = "c".repeat(40);
    const log = streamWith("outcomes-round-zero", [
      attempt({
        stageRound: 0,
        attempt: 0,
        inputTreeId: tree,
        outputTreeId: tree,
        outcome: "PASS",
        durationMs: 120,
      }),
    ]);
    expect(readQualityStageOutcomes(log.runDir)[0]).toMatchObject({
      roundsUsed: 0,
      elapsedMs: 120,
      outcome: "PASS",
    });
  });

  it("[behavior:#97:B-09] reads a reuse off the stream as the final decision", () => {
    const log = streamWith("outcomes-reuse", [
      attempt({ outcome: "PASS" }),
      {
        type: "final-evaluation-reuse",
        ghIssue: "97",
        sliceNumber: "03",
        round: 1,
        finalTreeId: "b".repeat(40),
        baselineTreeId: "b".repeat(40),
      },
    ]);
    expect(readQualityStageOutcomes(log.runDir)[0]?.finalDecision).toBe("reuse");
  });

  it("[behavior:#97:B-09] returns [] for a run directory with no events and for one with no attempt", () => {
    // An absent block, never a throw: a PR body must not depend on a log file.
    expect(readQualityStageOutcomes(join(makeRepo(), "nope"))).toEqual([]);
    const log = streamWith("outcomes-empty", [
      {
        type: "quality-stage-policy",
        stage: "cleaner",
        enabled: false,
        gateIds: [],
        source: "afk.config.json",
      },
    ]);
    expect(readQualityStageOutcomes(log.runDir)).toEqual([]);
  });
});

describe("[behavior:#97:B-10] run-summary.md's per-slice quality-stage rows", () => {
  function summaryWith(
    slug: string,
    events: readonly JournalTestInput[],
  ): string {
    const log = new Logger(makeRepo(), slug);
    log.restoreCompleted(id("97", "Changed trees face final evaluation", "afk/97"));
    for (const event of events) recordTestInput(log, event);
    return log.writeSummary();
  }

  const POLICY: RunEventPayload = {
    type: "quality-stage-policy",
    stage: "cleaner",
    enabled: true,
    gateIds: ["clean:format"],
    source: "afk.config.json",
  };

  it("[behavior:#97:B-10] renders one row per entry beneath #274's header lines", () => {
    const md = summaryWith("rows-rendered", [
      POLICY,
      qualityStageAttempt({
        ghIssue: "97",
        sliceNumber: "03",
        round: 1,
        stage: "cleaner",
        stageRound: 1,
        attempt: 1,
        inputTreeId: "a".repeat(40),
        outputTreeId: "b".repeat(40),
        gateIds: ["clean:format", "scope"],
        outcome: "PASS",
        startedAt: "2026-09-13T00:00:00.000Z",
        endedAt: "2026-09-13T00:00:02.000Z",
        durationMs: 2_000,
        cacheReusedGateIds: ["scope"],
      }),
      { type: "stage-duration", ghIssue: "97", agent: "cleaner", durationMs: 750, history: null },
    ]);

    const section = md.slice(md.indexOf("## Quality Stages"));
    // #274's header line still comes first, and the rows sit beneath it (P-07).
    expect(section.indexOf("`cleaner`: enabled")).toBeLessThan(
      section.indexOf("| Slice | Stage |"),
    );
    expect(section).toContain(
      `| #97 | cleaner | yes | PASS | 1/${MAX_CLEANER_ROUNDS} | 2000ms | ` +
        `750ms | clean:format, scope | scope | evaluate |`,
    );
  });

  it("[behavior:#97:B-10] renders the header lines and no table for a stream with no attempt", () => {
    // Every #274-era summary stays byte-identical (P-06/P-07).
    const md = summaryWith("rows-absent", [POLICY]);
    expect(md).toContain("`cleaner`: enabled");
    expect(md).not.toContain("| Slice | Stage |");
  });
});
