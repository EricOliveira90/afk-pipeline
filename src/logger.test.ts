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
import { readAdvisoryGateOutcomes } from "./logger.js";
import {
  RunJournal as Logger,
  type TerminalOutcome,
} from "./run-journal.js";
import { lifecycle } from "./slice-lifecycle.js";

const tempDirs: string[] = [];

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

  it("keeps the plain FAIL rendering for a red suite", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "sanity-command");
    recordTerminal(log, id("1", "Pass", "afk/1"), { phase: "PASS" });
    log.setSanityGate({
      ok: false,
      failures: ["typecheck", "tests"],
      failureKind: "COMMAND",
    });

    expect(log.writeSummary()).toContain(
      "Pre-ship sanity gate: FAIL (typecheck, tests)",
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
