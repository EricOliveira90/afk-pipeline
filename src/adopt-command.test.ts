import { execFileSync } from "node:child_process";
import {
  mkdirSync,
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
import {
  resolveCommit,
  resolveTree,
  updateBranchIfUnchanged,
} from "./git.js";
import { isSliceComplete, loadRunState, saveRunState } from "./run-state.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * The slice table adoption resolves `<slice>` against. `06` and `129` are
 * the PRD 2 identities that exposed the keying defect: the CLI's wording
 * invites the slice number, while run state is keyed on the issue ID.
 */
function writeIssuesMd(repo: string, prdSlug: string): void {
  const dir = join(repo, ".kiro", "specs", prdSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "issues.md"),
    [
      "| Slice | GH Issue | Title | Type | Blocked by | User stories covered |",
      "|-------|----------|-------|------|------------|----------------------|",
      "| 05    | #94      | Courier follow-up | HITL | — | 5 |",
      "| 06    | #129     | afk adopt | AFK | — | 17 |",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-adopt-"));
  tempDirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "AFK Test"]);
  git(repo, ["config", "user.email", "afk@example.test"]);
  writeIssuesMd(repo, "demo");
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

function makeConflictingRepo(): string {
  const repo = makeRepo();
  git(repo, ["checkout", "feat/demo"]);
  writeFileSync(join(repo, "base.txt"), "feature version\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "feature change"]);
  git(repo, ["checkout", "manual/demo-01"]);
  writeFileSync(join(repo, "base.txt"), "slice version\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "slice conflict"]);
  git(repo, ["checkout", "main"]);
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
  it("refuses --reason followed by another option before repository access", async () => {
    const missingRepo = join(tmpdir(), `afk-adopt-missing-${Date.now()}`);
    let gatesCalled = false;

    const result = await runAdoptCli(
      [
        "demo",
        "129",
        "--branch",
        "manual/demo-01",
        "--reason",
        "--adopter",
        "Ada Lovelace",
      ],
      missingRepo,
      {
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      },
    );

    expect(result).toEqual({
      exitCode: 2,
      output:
        "Usage: afk adopt <prd-slug> <slice> --branch <branch> " +
        "--reason <reason> [--adopter <name>]",
    });
    expect(gatesCalled).toBe(false);
  });

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

  it("refuses when a competing update wins the feature ref at finalization", async () => {
    const repo = makeRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const sliceBefore = resolveCommit(repo, "manual/demo-01")!;
    const stateBefore = readFileSync(statePath, "utf-8");

    git(repo, ["checkout", "-b", "concurrent-update", "feat/demo"]);
    writeFileSync(join(repo, "concurrent.txt"), "unverified change\n");
    git(repo, ["add", "concurrent.txt"]);
    git(repo, ["commit", "-m", "competing feature update"]);
    const competingCommit = resolveCommit(repo, "concurrent-update")!;
    git(repo, ["checkout", "main"]);

    let finalizationCalled = false;
    const dependencies = {
      resolveGatePlan: () => ({ declarations: GATES }),
      runBaseGates: async ({
        treeId,
        declarations,
      }: {
        treeId: string;
        declarations: readonly GateDeclaration[];
      }) => declarations.map((gate) => passingResult(gate, treeId)),
      finalizeCandidate: ({
        candidateCommit,
        expectedFeatureCommit,
        featureBranch,
      }: {
        candidateCommit: string;
        expectedFeatureCommit: string;
        featureBranch: string;
      }) => {
        finalizationCalled = true;
        const featureRef = `refs/heads/${featureBranch}`;
        git(repo, [
          "update-ref",
          featureRef,
          competingCommit,
          expectedFeatureCommit,
        ]);
        return updateBranchIfUnchanged(
          repo,
          featureBranch,
          candidateCommit,
          expectedFeatureCommit,
        );
      },
    };

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
      dependencies,
    );

    expect(finalizationCalled).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("branch changed");
    expect(resolveCommit(repo, "feat/demo")).toBe(competingCommit);
    expect(resolveCommit(repo, "feat/demo")).not.toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
  });

  it("names a failing base gate and leaves the worktree, refs, and state unchanged", async () => {
    const repo = makeRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const sliceBefore = resolveCommit(repo, "manual/demo-01")!;
    const stateBefore = readFileSync(statePath, "utf-8");
    const statusBefore = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const branchBefore = git(repo, ["branch", "--show-current"]);
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
          expect(resolveTree(cwd)).toBe(treeId);
          expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
          observedGates.push(...declarations.map((gate) => gate.id));
          return declarations.map((gate) => ({
            ...passingResult(gate, treeId),
            ...(gate.id === "lint"
              ? {
                  status: "FAIL" as const,
                  failureKind: "COMMAND" as const,
                  exitCode: 1,
                }
              : {}),
          }));
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("lint");
    expect(observedGates).toEqual(["typecheck", "lint", "tests"]);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    expect(git(repo, ["branch", "--show-current"])).toBe(branchBefore);
    expect(
      git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe(statusBefore);
  });

  it("names a merge conflict and leaves the worktree, both refs, and state unchanged", async () => {
    const repo = makeConflictingRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const sliceBefore = resolveCommit(repo, "manual/demo-01")!;
    const stateBefore = readFileSync(statePath, "utf-8");
    const statusBefore = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const branchBefore = git(repo, ["branch", "--show-current"]);
    let gatesCalled = false;

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
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output.toLowerCase()).toContain("conflict");
    expect(gatesCalled).toBe(false);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    expect(git(repo, ["branch", "--show-current"])).toBe(branchBefore);
    expect(
      git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe(statusBefore);
  });

  it.each([
    ["the manifest slice number", "06"],
    ["the GitHub issue ID", "129"],
  ])(
    "records the adopted slice under its issue ID when given %s",
    async (_label, entered) => {
      const repo = makeRepo();
      const sliceTip = resolveCommit(repo, "manual/demo-01")!;

      const result = await runAdoptCli(
        [
          "demo",
          entered,
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
          runBaseGates: async ({ treeId, declarations }) =>
            declarations.map((gate) => passingResult(gate, treeId)),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Adopted slice #129");
      const state = loadRunState(repo, "demo");
      expect(Object.keys(state.slices)).toEqual(["129"]);
      expect(isSliceComplete(state, "129")).toBe(true);
      expect(state.slices["129"]!.adoption!.commit).toBe(sliceTip);
    },
  );

  it("refuses an identifier the slice manifest does not declare", async () => {
    const repo = makeRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const stateBefore = readFileSync(statePath, "utf-8");
    let gatesCalled = false;

    const result = await runAdoptCli(
      [
        "demo",
        "07",
        "--branch",
        "manual/demo-01",
        "--adopter",
        "Ada Lovelace",
        "--reason",
        "finished the slice manually",
      ],
      repo,
      {
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("not declared in");
    expect(gatesCalled).toBe(false);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
  });

  it("refuses while the feature branch is checked out in a worktree", async () => {
    const repo = makeRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const stateBefore = readFileSync(statePath, "utf-8");
    const linked = join(repo, "..", `afk-adopt-linked-${Date.now()}`);
    tempDirs.push(linked);
    git(repo, ["worktree", "add", linked, "feat/demo"]);
    let gatesCalled = false;

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
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("checked out");
    expect(gatesCalled).toBe(false);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    // The linked worktree's tree still matches the ref it holds.
    expect(git(linked, ["status", "--porcelain"])).toBe("");
    git(repo, ["worktree", "remove", linked, "--force"]);
  });

  it("rolls the feature ref back when the state write fails", async () => {
    const repo = makeRepo();
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const statePath = join(repo, ".afk", "state", "demo.json");
    const stateBefore = readFileSync(statePath, "utf-8");
    const sliceBefore = resolveCommit(repo, "manual/demo-01")!;

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
        runBaseGates: async ({ treeId, declarations }) =>
          declarations.map((gate) => passingResult(gate, treeId)),
        persistSliceState: () => {
          throw new Error("EPERM: state file is not writable");
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("EPERM");
    expect(result.output).toContain("rolled back");
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
  });

  it("refuses when the candidate worktree survives teardown", async () => {
    const repo = makeRepo();
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const statePath = join(repo, ".afk", "state", "demo.json");
    const stateBefore = readFileSync(statePath, "utf-8");
    let candidateDir = "";

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
          candidateDir = cwd;
          return declarations.map((gate) => passingResult(gate, treeId));
        },
        removeWorktree: async () => ({
          removed: false,
          attempts: 3,
          lastError: "EBUSY: resource busy or locked",
        }),
      },
    );

    expect(candidateDir).not.toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("cleanup incomplete");
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    git(repo, ["worktree", "remove", candidateDir, "--force"]);
  });

  it("tears the candidate worktree down when gate-plan resolution throws", async () => {
    const repo = makeRepo();
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const worktreesBefore = git(repo, ["worktree", "list"]);

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
        resolveGatePlan: () => {
          throw new Error("no base gate catalog in this project");
        },
        runBaseGates: async () => {
          throw new Error("gates must not run");
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no base gate catalog");
    expect(git(repo, ["worktree", "list"])).toBe(worktreesBefore);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
  });

  it.each([
    ["missing", []],
    ["empty", ["--reason", ""]],
    ["whitespace-only", ["--reason", "   \t"]],
  ])("refuses a %s reason without changing branches or state", async (_label, reasonArgs) => {
    const repo = makeRepo();
    const statePath = join(repo, ".afk", "state", "demo.json");
    const featureBefore = resolveCommit(repo, "feat/demo")!;
    const sliceBefore = resolveCommit(repo, "manual/demo-01")!;
    const stateBefore = readFileSync(statePath, "utf-8");
    let gatesCalled = false;

    const result = await runAdoptCli(
      [
        "demo",
        "129",
        "--branch",
        "manual/demo-01",
        "--adopter",
        "Ada Lovelace",
        ...reasonArgs,
      ],
      repo,
      {
        resolveGatePlan: () => ({ declarations: GATES }),
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).toContain("reason");
    expect(gatesCalled).toBe(false);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
  });
});
