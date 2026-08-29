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
  it("writes run-summary.md to both the stable path and the run directory", () => {
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
