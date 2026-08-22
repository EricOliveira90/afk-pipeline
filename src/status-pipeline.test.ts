import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStatusModel } from "./status.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "afk-pipeline-status-"));
  const runDir = join(root, ".afk", "logs", "demo", "run-20260822-010000");
  const specs = join(root, ".kiro", "specs", "demo");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(specs, { recursive: true });
  writeFileSync(
    join(specs, "issues.md"),
    `# Slices

| # | GH Issue | Title | Type | Blocked By |
|---|----------|-------|------|------------|
| 01 | 101 | First slice | AFK | — |
| 02 | 102 | Serial successor | AFK | — |
| 03 | 103 | Dependent slice | AFK | 101 |
`,
  );
  const events = [
    { type: "header", version: 1, ts: "2026-08-22T01:00:00.000Z" },
    {
      type: "run-started",
      provider: "stub",
      runSlug: "demo-stub",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
      ts: "2026-08-22T01:00:00.100Z",
    },
    {
      type: "wave-dispatched",
      wave: 1,
      slices: ["101", "102"],
      ts: "2026-08-22T01:00:01.000Z",
    },
    {
      type: "lanes-partitioned",
      wave: 1,
      lanes: [["101", "102"]],
      ts: "2026-08-22T01:00:02.000Z",
    },
    {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 1,
      ts: "2026-08-22T01:00:03.000Z",
    },
    {
      type: "phase-ended",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 1,
      ts: "2026-08-22T01:00:05.000Z",
    },
    {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "evaluator-contract",
      round: 1,
      ts: "2026-08-22T01:00:05.000Z",
    },
    {
      type: "phase-ended",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "evaluator-contract",
      round: 1,
      verdict: "REVISE",
      ts: "2026-08-22T01:00:06.000Z",
    },
    {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 3,
      ts: "2026-08-22T01:00:07.000Z",
    },
  ];
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return { root, runDir };
}

describe("StatusModel.pipeline", () => {
  it("projects waves, serial lanes, observed rounds, and active elapsed time", () => {
    const { root, runDir } = fixture();
    const result = buildStatusModel(runDir, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.model.pipeline.run).toMatchObject({
      slug: "demo-stub",
      provider: "stub",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
      state: "active",
    });
    expect(result.model.pipeline.waves[0]?.lanes[0]?.slices.map((slice) => slice.ghIssue))
      .toEqual(["101", "102"]);
    const first = result.model.pipeline.waves[0]?.lanes[0]?.slices[0];
    expect(first?.contractRounds.map((round) => round.round)).toEqual([1, 3]);
    expect(first?.contractRounds[0]?.evaluator?.verdict).toBe("REVISE");
    expect(first?.contractRounds[1]?.primary?.state).toBe("active");
    expect(first?.contractRounds[1]?.primary?.elapsedMs).toBeGreaterThan(0);
  });
});
