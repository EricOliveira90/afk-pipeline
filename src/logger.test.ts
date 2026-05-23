import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./logger.js";
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

describe("Logger.formatConsoleSummary", () => {
  it("groups every phase into its bucket exhaustively", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "buckets");
    log.setFeatureBranch("feat/buckets");

    log.transitionTo(
      "1",
      lifecycle.pass(id("1", "Pass", "afk/1"), PROGRESS, true),
    );
    log.transitionTo(
      "2",
      lifecycle.stuck(id("2", "Stuck", "afk/2"), PROGRESS, "QA failed"),
    );
    log.transitionTo(
      "3",
      lifecycle.escalate(
        id("3", "Esc", "afk/3"),
        PROGRESS,
        "negotiation gave up",
      ),
    );
    log.transitionTo(
      "4",
      lifecycle.error(id("4", "Err", "afk/4"), PROGRESS, "boom"),
    );
    log.transitionTo(
      "5",
      lifecycle.conflict(id("5", "Conf", "afk/5"), PROGRESS, "merge"),
    );
    log.transitionTo(
      "6",
      lifecycle.cancelled(id("6", "Can", "afk/6"), PROGRESS, "user abort"),
    );
    log.transitionTo(
      "7",
      lifecycle.laneCancelled(
        id("7", "Lane", "afk/7"),
        PROGRESS,
        "predecessor failed",
      ),
    );
    log.transitionTo("8", lifecycle.skipped(id("8", "Hitl", "—")));
    log.transitionTo(
      "9",
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
    log.transitionTo("1", lifecycle.running(id("1", "x", "afk/1"), {
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
    log.transitionTo("1", lifecycle.skipped(id("1", "h", "—")));
    expect(() => log.bumpGenRound("1", 1)).toThrow(/SKIPPED/);
  });
});

describe("Logger.writeSummary (run-summary.md byte stability)", () => {
  it("renders ESCALATE and ERROR as STUCK in the markdown table", () => {
    const repo = makeRepo();
    const log = new Logger(repo, "summary");
    log.setFeatureBranch("feat/summary");

    log.transitionTo(
      "1",
      lifecycle.pass(id("1", "Pass", "afk/1"), PROGRESS, true),
    );
    log.transitionTo(
      "2",
      lifecycle.escalate(
        id("2", "Esc", "afk/2"),
        PROGRESS,
        "negotiation gave up",
      ),
    );
    log.transitionTo(
      "3",
      lifecycle.error(id("3", "Err", "afk/3"), PROGRESS, "boom"),
    );

    const md = log.writeSummary();
    // Header row + three data rows + totals row
    expect(md).toContain("| 1 Pass | ✅ PASS |");
    expect(md).toContain("| 2 Esc | 🔴 STUCK |");
    expect(md).toContain("| 3 Err | 🔴 STUCK |");
    expect(md).not.toContain("ESCALATE |");
    expect(md).not.toContain("| 3 Err | 🔴 ERROR |");
  });
});
