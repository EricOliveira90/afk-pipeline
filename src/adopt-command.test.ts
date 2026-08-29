import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAdoptCli } from "./adopt-command.js";
import type { GateDeclaration, GateResult } from "./gate-runner.js";
import { resolveCommit, resolveTree } from "./git.js";
import { loadRunState, saveRunState } from "./run-state.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-adopt-"));
  tempDirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "AFK Test"]);
  git(repo, ["config", "user.email", "afk@example.test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["branch", "feat/demo"]);
  git(repo, ["checkout", "-b", "manual/demo-01"]);
  writeFileSync(join(repo, "slice.txt"), "finished manually\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "finish slice"]);
  git(repo, ["checkout", "main"]);
  saveRunState(repo, {
    version: 1,
    prdSlug: "demo",
    featureBranch: "feat/demo",
    slices: {},
  });
  return repo;
}

const GATES: GateDeclaration[] = [
  {
    id: "typecheck",
    stage: "base",
    required: true,
    command: "pnpm",
    args: ["typecheck"],
  },
  {
    id: "lint",
    stage: "base",
    required: true,
    command: "pnpm",
    args: ["lint"],
  },
  {
    id: "tests",
    stage: "base",
    required: true,
    command: "pnpm",
    args: ["test"],
  },
];

function passingResult(gate: GateDeclaration, treeId: string): GateResult {
  return {
    gateId: gate.id,
    stage: gate.stage,
    status: "PASS",
    failureKind: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    treeId,
    logArtifactId: `${gate.id}.log`,
  };
}

describe("afk adopt", () => {
  it("verifies the candidate tree before merging and persists adoption provenance", async () => {
    const repo = makeRepo();
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const sliceTip = resolveCommit(repo, "manual/demo-01")!;
    const expectedTree = git(repo, [
      "merge-tree",
      "--write-tree",
      "feat/demo",
      "manual/demo-01",
    ]).split(/\r?\n/)[0]!;
    const observedGates: string[] = [];

    const result = await runAdoptCli(
      [
        "demo",
        "129",
        "--branch",
        "manual/demo-01",
        "--adopter",
        "Ada Lovelace",
        "--reason",
        "finished the slice manually",
      ],
      repo,
      {
        resolveGatePlan: () => ({ declarations: GATES }),
        runBaseGates: async ({ cwd, treeId, declarations }) => {
          expect(treeId).toBe(expectedTree);
          expect(resolveTree(cwd)).toBe(expectedTree);
          expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
          expect(readFileSync(join(cwd, "slice.txt"), "utf-8")).toBe(
            "finished manually\n",
          );
          observedGates.push(...declarations.map((gate) => gate.id));
          return declarations.map((gate) => passingResult(gate, treeId));
        },
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      output:
        `Adopted slice #129 from manual/demo-01 into feat/demo ` +
        `(verified commit ${sliceTip}).`,
    });
    expect(observedGates).toEqual(["typecheck", "lint", "tests"]);
    expect(resolveCommit(repo, "feat/demo")).not.toBe(featureBefore);
    expect(resolveTree(repo, "feat/demo")).toBe(expectedTree);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceTip);
    expect(loadRunState(repo, "demo").slices["129"]).toEqual({
      phase: "PASS",
      mergedToFeature: true,
      branch: "manual/demo-01",
      adoption: {
        adopter: "Ada Lovelace",
        reason: "finished the slice manually",
        branch: "manual/demo-01",
        commit: sliceTip,
      },
    });
  });
});
