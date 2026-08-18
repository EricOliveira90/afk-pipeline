/**
 * `afk status` (spec #26, slice #27) — tested at the filesystem
 * contract: a run directory goes in, rendered text / `--json` comes
 * out. No mocking of internals; fixtures are plain files shaped like
 * what a pipeline run leaves behind.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "./status.js";
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

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-status-"));
  tempDirs.push(dir);
  return dir;
}

const PROGRESS = { genRounds: 1, evalRounds: 1 };

/** Write a run directory fixture with an events.jsonl shaped like the tee's output. */
function writeRunDir(
  root: string,
  slug: string,
  runName: string,
  events: Array<Record<string, unknown>>,
): string {
  const runDir = join(root, ".afk", "logs", slug, runName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
  return runDir;
}

function standardEvents(): Array<Record<string, unknown>> {
  return [
    { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
    {
      type: "run-started",
      provider: "stub",
      runSlug: "demo-stub",
      ts: "2026-08-18T10:00:00.100Z",
    },
    {
      type: "slice-outcome",
      slice: lifecycle.pass(
        { ghIssue: "9401", title: "Passer", branch: "afk/9401" },
        PROGRESS,
        true,
      ),
      ts: "2026-08-18T10:05:00.000Z",
    },
    {
      type: "slice-outcome",
      slice: lifecycle.stuck(
        { ghIssue: "9402", title: "Failer", branch: "afk/9402" },
        PROGRESS,
        "QA failed after 3 rounds",
      ),
      ts: "2026-08-18T10:07:00.000Z",
    },
  ];
}

describe("afk status (filesystem contract)", () => {
  it("renders each slice outcome chronologically with reason and timestamp; exit 0", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260818-100000", standardEvents());

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    // Outcomes appear in event order with their reasons.
    const passIdx = output.indexOf("#9401");
    const stuckIdx = output.indexOf("#9402");
    expect(passIdx).toBeGreaterThan(-1);
    expect(stuckIdx).toBeGreaterThan(passIdx);
    expect(output).toContain("PASS");
    expect(output).toContain("STUCK");
    expect(output).toContain("QA failed after 3 rounds");
    // Timestamps are visible for chronology.
    expect(output).toContain("10:05:00");
  });

  it("--json emits the schema version and the same events the renderer consumes", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260818-100000", standardEvents());

    const { output, exitCode } = runStatus(["--json"], root);

    expect(exitCode).toBe(0);
    const model = JSON.parse(output);
    expect(model.schemaVersion).toBe(1);
    expect(model.events.map((e: { type: string }) => e.type)).toEqual([
      "header",
      "run-started",
      "slice-outcome",
      "slice-outcome",
    ]);
    expect(model.events[3].slice.error).toBe("QA failed after 3 rounds");
  });

  it("auto-detects the latest run of the most recently active PRD", () => {
    const root = makeRoot();
    // Older PRD with an old run; newer PRD with two runs.
    writeRunDir(root, "old-prd-stub", "run-20260810-090000", standardEvents());
    writeRunDir(root, "new-prd-stub", "run-20260817-090000", standardEvents());
    const latest = writeRunDir(root, "new-prd-stub", "run-20260818-110000", [
      { type: "header", version: 1, ts: "2026-08-18T11:00:00.000Z" },
      {
        type: "run-started",
        provider: "stub",
        runSlug: "new-prd-stub",
        ts: "2026-08-18T11:00:00.100Z",
      },
      {
        type: "slice-outcome",
        slice: lifecycle.pass(
          { ghIssue: "7777", title: "Newest", branch: "afk/7777" },
          PROGRESS,
          true,
        ),
        ts: "2026-08-18T11:01:00.000Z",
      },
    ]);

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    expect(output).toContain("#7777");
    expect(output).not.toContain("#9401");
    // The picked run directory is identifiable in the output.
    expect(output).toContain(latest.split(/[\\/]/).pop()!);
  });

  it("fails with a clear message and non-zero exit when no runs exist", () => {
    const root = makeRoot();

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).not.toBe(0);
    expect(output.toLowerCase()).toContain("no");
  });

  it("renders per-slice phase chronology with round, duration, and verdict (#28)", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260818-100000", [
      { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
      { type: "run-started", provider: "stub", runSlug: "demo-stub", ts: "2026-08-18T10:00:00.100Z" },
      { type: "wave-dispatched", wave: 1, slices: ["9401"], ts: "2026-08-18T10:00:01.000Z" },
      { type: "phase-started", ghIssue: "9401", agent: "explorer", ts: "2026-08-18T10:00:02.000Z" },
      { type: "phase-ended", ghIssue: "9401", agent: "explorer", ts: "2026-08-18T10:00:14.000Z" },
      { type: "phase-started", ghIssue: "9401", agent: "planner", round: 1, ts: "2026-08-18T10:00:15.000Z" },
      { type: "phase-ended", ghIssue: "9401", agent: "planner", round: 1, ts: "2026-08-18T10:00:55.000Z" },
      { type: "phase-started", ghIssue: "9401", agent: "evaluator-contract", round: 1, ts: "2026-08-18T10:01:00.000Z" },
      { type: "phase-ended", ghIssue: "9401", agent: "evaluator-contract", round: 1, verdict: "ACCEPT", ts: "2026-08-18T10:02:05.000Z" },
      {
        type: "slice-outcome",
        slice: lifecycle.pass(
          { ghIssue: "9401", title: "Passer", branch: "afk/9401" },
          PROGRESS,
          true,
        ),
        ts: "2026-08-18T10:05:00.000Z",
      },
    ]);

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    // Wave dispatch appears in the chronology.
    expect(output).toMatch(/wave 1\b.*9401/i);
    // Completed phases render with round, computed duration, and verdict.
    expect(output).toMatch(/#9401.*explorer.*12s/);
    expect(output).toMatch(/#9401.*planner.*round 1.*40s/);
    expect(output).toMatch(/#9401.*evaluator-contract.*round 1.*1m05s.*ACCEPT/);
    // Chronological order: explorer before planner before evaluator.
    const explorerIdx = output.indexOf("explorer");
    const plannerIdx = output.indexOf("planner");
    const evalIdx = output.indexOf("evaluator-contract");
    expect(explorerIdx).toBeGreaterThan(-1);
    expect(plannerIdx).toBeGreaterThan(explorerIdx);
    expect(evalIdx).toBeGreaterThan(plannerIdx);
    // The terminal outcome still closes the chronology.
    expect(output).toContain("PASS");
  });
});
