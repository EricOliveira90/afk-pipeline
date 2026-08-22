/**
 * `afk status` (spec #26, slice #27) — tested at the filesystem
 * contract: a run directory goes in, rendered text / `--json` comes
 * out. No mocking of internals; fixtures are plain files shaped like
 * what a pipeline run leaves behind.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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


describe("afk status warn events inline (#29)", () => {
  it("renders warn events inline at their chronological position, visually distinct", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260818-100000", [
      { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
      { type: "run-started", provider: "stub", runSlug: "demo-stub", ts: "2026-08-18T10:00:00.100Z" },
      // Prior-run state warns land at run start for re-runs.
      {
        type: "warn",
        reason: "prior-run-state",
        ghIssue: "9601",
        previousPhase: "STUCK",
        previousError: "QA failed after 3 rounds",
        message: "prior run: STUCK — QA failed after 3 rounds",
        ts: "2026-08-18T10:00:00.200Z",
      },
      { type: "phase-started", ghIssue: "9601", agent: "generator", round: 1, ts: "2026-08-18T10:00:10.000Z" },
      { type: "phase-ended", ghIssue: "9601", agent: "generator", round: 1, ts: "2026-08-18T10:01:10.000Z" },
      {
        type: "warn",
        reason: "lane-continuation",
        ghIssue: "9601",
        message: "failed (STUCK) — its lane continues with #9602",
        ts: "2026-08-18T10:02:00.000Z",
      },
      {
        type: "warn",
        reason: "not-run-hold",
        ghIssue: "9603",
        blockedBy: ["9601"],
        message: "not run — held by unresolved dependency #9601",
        ts: "2026-08-18T10:03:00.000Z",
      },
    ]);

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    // Warn lines are visually distinct from phase lines.
    expect(output).toMatch(/⚠.*#9601.*prior run: STUCK — QA failed after 3 rounds/);
    expect(output).toMatch(/⚠.*#9601.*lane continues with #9602/);
    expect(output).toMatch(/⚠.*#9603.*held by unresolved dependency #9601/);
    // Phase lines carry no warn marker.
    expect(output).toMatch(/\n\s+10:01:10\s+#9601 generator \(round 1\)/);
    // Inline chronology: prior-run warn precedes the generator phase,
    // lane-continuation follows it.
    const priorIdx = output.indexOf("prior run: STUCK");
    const genIdx = output.indexOf("generator (round 1)");
    const laneIdx = output.indexOf("lane continues");
    expect(priorIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(priorIdx);
    expect(laneIdx).toBeGreaterThan(genIdx);
  });

  it("--json carries phase and warn events verbatim", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260818-100000", [
      { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
      { type: "wave-dispatched", wave: 1, slices: ["9601"], ts: "2026-08-18T10:00:01.000Z" },
      { type: "phase-started", ghIssue: "9601", agent: "generator", round: 2, ts: "2026-08-18T10:00:10.000Z" },
      { type: "phase-ended", ghIssue: "9601", agent: "generator", round: 2, ts: "2026-08-18T10:01:10.000Z" },
      {
        type: "warn",
        reason: "not-run-hold",
        ghIssue: "9603",
        blockedBy: ["9601"],
        message: "not run — held by unresolved dependency #9601",
        ts: "2026-08-18T10:03:00.000Z",
      },
    ]);

    const { output, exitCode } = runStatus(["--json"], root);

    expect(exitCode).toBe(0);
    const model = JSON.parse(output);
    expect(model.events[1]).toEqual({
      type: "wave-dispatched",
      wave: 1,
      slices: ["9601"],
      ts: "2026-08-18T10:00:01.000Z",
    });
    expect(model.events[2]).toMatchObject({ type: "phase-started", agent: "generator", round: 2 });
    expect(model.events[4]).toMatchObject({
      type: "warn",
      reason: "not-run-hold",
      blockedBy: ["9601"],
    });
  });
});


describe("afk status future section integration (#30)", () => {
  it("renders remaining phases, upcoming waves, and blocker references; --json carries the future model", () => {
    const root = makeRoot();
    // Issues DAG: 02 blocked by 01; 03 is HITL.
    const specsDir = join(root, ".kiro", "specs", "demo");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(
      join(specsDir, "issues.md"),
      [
        "| Slice | GH Issue | Title | Type | Blocked by | User stories covered |",
        "|-------|----------|-------|------|------------|----------------------|",
        "| 01 | 9401 | Lead | AFK | — | 1 |",
        "| 02 | 9402 | Follower | AFK | 9401 | 2 |",
        "| 03 | 9403 | Manual | HITL | — | 3 |",
      ].join("\n") + "\n",
      "utf-8",
    );
    // Partial run: 9401 mid-pipeline (explorer + planner done), 9402 untouched.
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", [
      { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
      { type: "run-started", provider: "stub", runSlug: "demo-stub", ts: "2026-08-18T10:00:00.100Z" },
      { type: "wave-dispatched", wave: 1, slices: ["9401"], ts: "2026-08-18T10:00:01.000Z" },
      { type: "lanes-partitioned", wave: 1, lanes: [["9401"]], ts: "2026-08-18T10:00:01.500Z" },
      { type: "phase-started", ghIssue: "9401", agent: "explorer", ts: "2026-08-18T10:00:02.000Z" },
      { type: "phase-ended", ghIssue: "9401", agent: "explorer", ts: "2026-08-18T10:00:14.000Z" },
      { type: "phase-started", ghIssue: "9401", agent: "planner", round: 1, ts: "2026-08-18T10:00:15.000Z" },
      { type: "phase-ended", ghIssue: "9401", agent: "planner", round: 1, ts: "2026-08-18T10:00:55.000Z" },
    ]);
    const fixtureBefore = {
      issues: readFileSync(join(specsDir, "issues.md"), "utf-8"),
      events: readFileSync(join(runDir, "events.jsonl"), "utf-8"),
      runDirEntries: readdirSync(runDir).sort(),
    };

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    expect(output).toContain("Future:");
    // The in-flight slice lists exactly its remaining phases.
    expect(output).toMatch(
      /#9401 Lead — evaluator-contract → generator → evaluator-qa/,
    );
    // The dependency-held slice shows its blocker.
    expect(output).toMatch(/#9402 Follower — .*waits on #9401/);
    // Wave projection shows what unblocks what.
    expect(output).toMatch(/wave 1: #9401/);
    expect(output).toMatch(/wave 2: #9402/);
    // Lane composition of the dispatched wave renders too.
    expect(output).toMatch(/Lanes \(wave 1\): \[#9401\]/);
    // HITL is skipped, not pending work.
    expect(output).toMatch(/Skipped \(HITL\):[\s\S]*#9403/);

    // Read-only: the command changed nothing it read.
    expect(readFileSync(join(specsDir, "issues.md"), "utf-8")).toBe(
      fixtureBefore.issues,
    );
    expect(readFileSync(join(runDir, "events.jsonl"), "utf-8")).toBe(
      fixtureBefore.events,
    );
    expect(readdirSync(runDir).sort()).toEqual(fixtureBefore.runDirEntries);
    expect(existsSync(join(root, ".afk", "state"))).toBe(false);

    const { output: jsonOut } = runStatus(["--json"], root);
    const model = JSON.parse(jsonOut);
    expect(model.future.pending.map((p: { ghIssue: string }) => p.ghIssue)).toEqual([
      "9401",
      "9402",
    ]);
    expect(model.future.upcomingWaves).toEqual([
      { wave: 1, slices: ["9401"] },
      { wave: 2, slices: ["9402"] },
    ]);
  });

  /**
   * Deferred merge (ADR 0025). The operator needs three facts without
   * opening the state file: the phase, which prefixes collided, and that
   * the next run retries the merge unattended.
   */
  describe("MERGE-PENDING", () => {
    function mergePendingEvents(): Array<Record<string, unknown>> {
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
          slice: lifecycle.mergePending(
            { ghIssue: "9404", title: "Deferred", branch: "afk/9404" },
            PROGRESS,
            "Migration prefix collision: 042 already exists on feat/demo under a " +
              "different filename. The slice's work is committed on its slice branch " +
              "and QA passed — merge deferred; the next run retries the merge " +
              "(no agent, no regeneration).",
            ["042"],
          ),
          ts: "2026-08-18T10:09:00.000Z",
        },
      ];
    }

    it("renders the phase, the colliding prefixes, and the retry note", () => {
      const root = makeRoot();
      writeRunDir(root, "demo-stub", "run-20260818-100000", mergePendingEvents());

      const { output, exitCode } = runStatus([], root);

      expect(exitCode).toBe(0);
      expect(output).toContain("MERGE-PENDING");
      expect(output).toContain("colliding prefixes: 042");
      expect(output).toContain("the next run retries the merge");
    });

    it("--json carries the phase and the colliding prefixes structurally", () => {
      const root = makeRoot();
      writeRunDir(root, "demo-stub", "run-20260818-100000", mergePendingEvents());

      const { output, exitCode } = runStatus(["--json"], root);

      expect(exitCode).toBe(0);
      const model = JSON.parse(output);
      const outcome = model.events.find(
        (e: { type: string }) => e.type === "slice-outcome",
      );
      expect(outcome.slice.phase).toBe("MERGE-PENDING");
      expect(outcome.slice.collidingPrefixes).toEqual(["042"]);
      expect(outcome.slice.error).toContain("retries the merge");
      // Not pending work for this run, and it never unblocks dependents.
      expect(model.future.pending).toEqual([]);
    });
  });
});
