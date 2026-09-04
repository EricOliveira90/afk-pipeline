import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearExactStageCheckpoint,
  inspectExactStageCheckpoint,
  recordExactStageCheckpoint,
  type ExactStageCheckpoint,
} from "./exact-stage-resume.js";
import { loadRunState, saveRunState } from "./run-state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "afk-exact-stage-"));
  dirs.push(path);
  return path;
}

const tree = "a".repeat(40);
const checkpoint: ExactStageCheckpoint = {
  version: 1,
  completedStage: "deterministic-qa",
  candidateTreeId: tree,
  nextPendingStage: "post-qa-deterministic",
  round: 2,
};

function inspect(root: string, currentCandidateTreeId: string | null = tree) {
  return inspectExactStageCheckpoint({
    repoRoot: root,
    prdSlug: "demo",
    ghIssue: "154",
    currentCandidateTreeId,
    expectedCompletedStage: "deterministic-qa",
    maximumRound: 3,
  });
}

describe("exact-stage checkpoint", () => {
  it("round-trips the completed stage, exact candidate, and pending stage", () => {
    const root = repo();
    recordExactStageCheckpoint(
      { repoRoot: root, prdSlug: "demo", ghIssue: "154" },
      checkpoint,
    );

    expect(inspect(root)).toEqual({ action: "resume", checkpoint });
    expect(loadRunState(root, "demo").stageCheckpoints).toEqual({
      "154": checkpoint,
    });
  });

  it("fails closed when the candidate changed", () => {
    const root = repo();
    recordExactStageCheckpoint(
      { repoRoot: root, prdSlug: "demo", ghIssue: "154" },
      checkpoint,
    );

    expect(inspect(root, "b".repeat(40))).toEqual({
      action: "reevaluate",
      reason:
        `the preserved candidate tree ${"b".repeat(40)} does not match ` +
        `recorded tree ${tree}`,
    });
  });

  it.each([
    ["missing", undefined, /no exact-stage checkpoint/],
    ["malformed collection", "broken", /collection is malformed/],
    [
      "malformed candidate",
      { "154": { ...checkpoint, candidateTreeId: "HEAD" } },
      /candidate tree identity is malformed/,
    ],
    [
      "contradictory stage",
      { "154": { ...checkpoint, completedStage: "shared-preview-uat" } },
      /contradicts the current candidate flow/,
    ],
    [
      "contradictory pending stage",
      { "154": { ...checkpoint, nextPendingStage: "generator" } },
      /next pending stage is malformed or contradictory/,
    ],
  ])("fails closed on %s evidence", (_label, stageCheckpoints, reason) => {
    const root = repo();
    const state = loadRunState(root, "demo");
    if (stageCheckpoints !== undefined) state.stageCheckpoints = stageCheckpoints;
    saveRunState(root, state);

    expect(inspect(root)).toEqual({
      action: "reevaluate",
      reason: expect.stringMatching(reason),
    });
  });

  it("clears only the consumed slice checkpoint", () => {
    const root = repo();
    const state = loadRunState(root, "demo");
    state.stageCheckpoints = {
      "154": checkpoint,
      "155": { ...checkpoint, candidateTreeId: "c".repeat(40) },
    };
    saveRunState(root, state);

    clearExactStageCheckpoint({
      repoRoot: root,
      prdSlug: "demo",
      ghIssue: "154",
    });

    expect(loadRunState(root, "demo").stageCheckpoints).toEqual({
      "155": { ...checkpoint, candidateTreeId: "c".repeat(40) },
    });
  });

  it("clears a malformed checkpoint collection before normal re-evaluation", () => {
    const root = repo();
    const state = loadRunState(root, "demo");
    state.stageCheckpoints = "broken";
    saveRunState(root, state);

    clearExactStageCheckpoint({
      repoRoot: root,
      prdSlug: "demo",
      ghIssue: "154",
    });

    expect(loadRunState(root, "demo").stageCheckpoints).toBeUndefined();
  });
});
