import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import {
  isSliceComplete,
  loadRunState,
  saveRunState,
  saveSliceState,
} from "./run-state.js";
import {
  runLaunchPreflight,
  type PreflightReport,
} from "./preflight.js";
import {
  buildRunNamespace,
  sliceBranch,
  sliceWorktreeDir,
} from "./orchestrator.js";
import { kiroProvider } from "./kiro.js";
import { parseIssuesMd } from "./issues-parser.js";

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

/**
 * The run-state key and feature branch a provider's run of PRD `demo`
 * uses — `pipelineRunSlug` / `featureBranchPrefix`. Kiro keeps the bare
 * names; every other provider is qualified.
 */
function runIdentity(provider: string): {
  runSlug: string;
  featureBranch: string;
} {
  return provider === "kiro"
    ? { runSlug: "demo", featureBranch: "feat/demo" }
    : { runSlug: `demo-${provider}`, featureBranch: `feat-${provider}/demo` };
}

/** Add one more provider's run state and feature branch to a repo. */
function addRun(repo: string, provider: string): void {
  const { runSlug, featureBranch } = runIdentity(provider);
  git(repo, ["branch", featureBranch, "main"]);
  saveRunState(repo, {
    version: 1,
    prdSlug: runSlug,
    featureBranch,
    slices: {},
  });
}

function makeRepo(provider = "kiro"): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-adopt-"));
  tempDirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "AFK Test"]);
  git(repo, ["config", "user.email", "afk@example.test"]);
  writeIssuesMd(repo, "demo");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["checkout", "-b", "manual/demo-01"]);
  writeFileSync(join(repo, "slice.txt"), "finished manually\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "finish slice"]);
  git(repo, ["checkout", "main"]);
  addRun(repo, provider);
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
        "--reason <reason> [--adopter <name>] [--provider <name>]",
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

  /**
   * Adoption of a *parked* slice, from the persisted `AWAITING-ADJUDICATION`
   * record through the next launch's preflight (ADR 0055 Seam 2).
   *
   * The estate a park owns survives every lifecycle operation but the
   * slice's own re-dispatch, and adoption is not one: it moves the feature
   * ref and overwrites the record with `PASS`, reconciling nothing. The
   * worktree the park still holds is then registered with no live slice
   * owning it, which is precisely what preflight refuses — so the bypass
   * valve used on a parked slice bricked the next launch.
   */
  describe("a parked slice's adjudication estate", () => {
    const PARKED_BRANCH = "afk/demo-slice-06-afk-adopt";

    /**
     * The park as a run leaves it: record, branch, registered worktree.
     * `phase` covers both preserve-all shapes — AWAITING-ADJUDICATION (a
     * pending human decision) and ADJUDICATION-LOCK-REFUSED (decisions done,
     * lock gate objecting on the base). Adoption must refuse both.
     */
    function park(
      repo: string,
      phase:
        | "AWAITING-ADJUDICATION"
        | "ADJUDICATION-LOCK-REFUSED"
        | "ERROR" = "AWAITING-ADJUDICATION",
      options: { detached?: boolean } = {},
    ): string {
      const worktree = join(repo, ".afk", "worktrees", "afk-demo-s06");
      git(repo, ["branch", PARKED_BRANCH, "main"]);
      if (options.detached) {
        // A registered worktree with no branch attached — `listWorktrees`
        // reports `branch: null` for it, which is exactly what the
        // branch-only holder match could not see.
        git(repo, ["worktree", "add", "--detach", worktree, PARKED_BRANCH]);
      } else {
        git(repo, ["worktree", "add", worktree, PARKED_BRANCH]);
      }
      // The estate the run actually leaves in the worktree. Ownership is
      // this, not the phase (ADR 0055 Seam 2 §6): the files are what a
      // re-dispatch reads and what adoption would strand.
      const sliceDir = join(
        worktree,
        ".kiro",
        "specs",
        "demo",
        "slices",
        "06-afk-adopt",
      );
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(
        join(sliceDir, "contract-negotiation-outcome.json"),
        JSON.stringify({ version: 1, classification: "IMPASSE", findings: [] }),
        "utf-8",
      );
      if (phase !== "AWAITING-ADJUDICATION") {
        // Decisions already recorded: a refused lock, or an apply that died
        // after the last decision was accepted.
        writeFileSync(
          join(sliceDir, "adjudication-decisions.json"),
          JSON.stringify({ version: 1, decisions: [{ findingId: "F-01" }] }),
          "utf-8",
        );
      }
      saveSliceState(repo, "demo", "129", {
        phase,
        branch: PARKED_BRANCH,
        error:
          phase === "ADJUDICATION-LOCK-REFUSED"
            ? "adjudication: contract lock refused — migration prefix collision"
            : phase === "ERROR"
              ? "negotiate: planner died applying the accepted decisions"
              : "IMPASSE: F-01 requires human adjudication",
      });
      return worktree;
    }

    /** What the next launch of this PRD would say about the namespace. */
    async function nextLaunchPreflight(repo: string): Promise<PreflightReport> {
      const state = loadRunState(repo, "demo");
      const slice = parseIssuesMd(
        join(repo, ".kiro", "specs", "demo", "issues.md"),
      ).find((candidate) => candidate.ghIssue === "129")!;
      const incomplete = isSliceComplete(state, "129") ? [] : [slice];
      const entries = incomplete.map((candidate) => ({
        path: sliceWorktreeDir(repo, "demo", candidate, kiroProvider),
        branch: sliceBranch("demo", candidate, kiroProvider),
      }));
      return runLaunchPreflight({
        repoRoot: repo,
        namespace: buildRunNamespace({
          repoRoot: repo,
          prdSlug: "demo",
          provider: kiroProvider,
          featBranch: "feat/demo",
          intended: entries,
          retained: entries,
        }),
        minFreeBytes: 0,
      });
    }

    const adopt = (repo: string, deps: Parameters<typeof runAdoptCli>[2]) =>
      runAdoptCli(
        [
          "demo",
          "129",
          "--branch",
          "manual/demo-01",
          "--adopter",
          "Ada Lovelace",
          "--reason",
          "finished the parked slice manually",
        ],
        repo,
        deps,
      );

    it("refuses while the park still holds a registered worktree", async () => {
      const repo = makeRepo();
      const worktree = park(repo);
      const statePath = join(repo, ".afk", "state", "demo.json");
      const featureBefore = resolveCommit(repo, "feat/demo")!;
      const stateBefore = readFileSync(statePath, "utf-8");
      let gatesCalled = false;

      const result = await adopt(repo, {
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("recorded AWAITING-ADJUDICATION");
      // `git worktree list` reports forward slashes on Windows, and the
      // refusal quotes git's path so `git worktree remove` can be pasted.
      expect(result.output).toContain(worktree.replace(/\\/g, "/"));
      expect(result.output).toContain(PARKED_BRANCH);
      expect(result.output).toContain("git worktree remove");
      // Refused before the candidate merge, so nothing moved and the park
      // is exactly as the human left it.
      expect(gatesCalled).toBe(false);
      expect(existsSync(join(repo, ".afk", "adopt"))).toBe(false);
      expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      expect(isSliceComplete(loadRunState(repo, "demo"), "129")).toBe(false);
      // And the estate is still the next run's legitimate input rather than
      // a leftover, because the record still says the slice is live.
      expect((await nextLaunchPreflight(repo)).refuse).toBe(false);
    });

    it("refuses a lock-refused estate too, and points at the base fix", async () => {
      // The other preserve-all shape: the human decisions are recorded and
      // the lock gate objects on the current base. Adoption must still refuse
      // (the estate is a completed adjudication awaiting a base fix), keying
      // off the shared preserve-all trait rather than the park phase by name,
      // and the retry path stays coherent — the next launch does not refuse
      // the retained worktree, so the slice re-dispatches and re-runs the gate.
      const repo = makeRepo();
      const worktree = park(repo, "ADJUDICATION-LOCK-REFUSED");
      const statePath = join(repo, ".afk", "state", "demo.json");
      const featureBefore = resolveCommit(repo, "feat/demo")!;
      const stateBefore = readFileSync(statePath, "utf-8");
      let gatesCalled = false;

      const result = await adopt(repo, {
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("recorded ADJUDICATION-LOCK-REFUSED");
      expect(result.output).toContain(worktree.replace(/\\/g, "/"));
      expect(result.output).toContain(PARKED_BRANCH);
      // The forward path differs from a park's: fix the base, not decide.
      expect(result.output).toContain("fix the base");
      // Refused before the candidate merge — nothing moved.
      expect(gatesCalled).toBe(false);
      expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      expect(isSliceComplete(loadRunState(repo, "demo"), "129")).toBe(false);
      // The retry path: the estate is still the next run's legitimate input.
      expect((await nextLaunchPreflight(repo)).refuse).toBe(false);
    });

    it("refuses a detached registered worktree, with no ref or state mutation", async () => {
      // The leak the fourth gate round found: `listWorktrees` reports a
      // detached worktree with `branch: null`, and the guard matched holders
      // by branch identity alone — so the park's own registered worktree
      // slipped past it entirely and adoption moved the ref behind a live
      // estate. Ownership is now the disk fact plus the expected *path*, so
      // a detached HEAD is not a hiding place.
      const repo = makeRepo();
      const worktree = park(repo, "AWAITING-ADJUDICATION", { detached: true });
      const statePath = join(repo, ".afk", "state", "demo.json");
      const featureBefore = resolveCommit(repo, "feat/demo")!;
      const sliceBefore = resolveCommit(repo, "manual/demo-01")!;
      const stateBefore = readFileSync(statePath, "utf-8");
      let gatesCalled = false;

      const result = await adopt(repo, {
        resolveGatePlan: () => {
          gatesCalled = true;
          return { declarations: GATES };
        },
        runBaseGates: async () => {
          gatesCalled = true;
          return [];
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("live adjudication estate");
      expect(result.output).toContain(worktree.replace(/\\/g, "/"));
      expect(result.output).toContain("contract-negotiation-outcome.json");
      // Nothing moved: no candidate merge, no gates, no ref, no state.
      expect(gatesCalled).toBe(false);
      expect(existsSync(join(repo, ".afk", "adopt"))).toBe(false);
      expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
      expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      expect(isSliceComplete(loadRunState(repo, "demo"), "129")).toBe(false);
    });

    it("refuses an estate left by a post-decision apply failure in ordinary ERROR", async () => {
      // The class the fourth gate round closed: once every decision is
      // accepted, a planner or provider failure during the apply lands the
      // slice in plain `ERROR`. No phase trait protects that, and the
      // decision log is the only copy of the human's input — so the disk
      // fact has to be what refuses.
      const repo = makeRepo();
      const worktree = park(repo, "ERROR");
      const statePath = join(repo, ".afk", "state", "demo.json");
      const featureBefore = resolveCommit(repo, "feat/demo")!;
      const stateBefore = readFileSync(statePath, "utf-8");

      const result = await adopt(repo, {
        resolveGatePlan: () => ({ declarations: GATES }),
        runBaseGates: async () => [],
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("live adjudication estate");
      expect(result.output).toContain("adjudication-decisions.json");
      expect(result.output).toContain(worktree.replace(/\\/g, "/"));
      // The forward path for an apply failure is a re-dispatch retrying the
      // decisions already on disk — not a fresh decision, not a base fix.
      expect(result.output).toContain("retry the recorded decisions");
      expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
      expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    });

    it("adopts once the park is quiesced, and the next launch is clean", async () => {
      const repo = makeRepo();
      const worktree = park(repo);
      const treeId = git(repo, [
        "merge-tree",
        "--write-tree",
        "feat/demo",
        "manual/demo-01",
      ]).split(/\r?\n/)[0]!;

      // What the refusal tells the operator to do. `--force` stands in for
      // a tree with the parked worktree's own scratch in it; the branch and
      // the slice directory (decisions, impasse record) are untouched.
      git(repo, ["worktree", "remove", worktree, "--force"]);

      const result = await adopt(repo, {
        resolveGatePlan: () => ({ declarations: GATES }),
        runBaseGates: async ({ declarations }) =>
          declarations.map((gate) => passingResult(gate, treeId)),
      });

      expect(result.exitCode).toBe(0);
      expect(loadRunState(repo, "demo").slices["129"]).toMatchObject({
        phase: "PASS",
        mergedToFeature: true,
        adoption: { adopter: "Ada Lovelace" },
      });
      // The park's branch survives the adoption as evidence.
      expect(resolveCommit(repo, PARKED_BRANCH)).not.toBeNull();
      // The point of the refusal: no registered namespace worktree is left
      // for the next launch to refuse over.
      const preflight = await nextLaunchPreflight(repo);
      expect(preflight.findings).toEqual([]);
      expect(preflight.refuse).toBe(false);
    });
  });

  it("refuses by name when worktree enumeration fails, before any ref mutation", async () => {
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
        "--reason",
        "finished the slice manually",
      ],
      repo,
      {
        listWorktrees: () => {
          throw new Error("fatal: not a git repository");
        },
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
    expect(result.output).toBe(
      "Adoption refused: could not enumerate worktrees — " +
        "fatal: not a git repository",
    );
    // No candidate merge, so no ref moved and no state was written.
    expect(gatesCalled).toBe(false);
    expect(resolveCommit(repo, "feat/demo")).toBe(featureBefore);
    expect(resolveCommit(repo, "manual/demo-01")).toBe(sliceBefore);
    expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
    expect(existsSync(join(repo, ".afk", "adopt"))).toBe(false);
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

  /**
   * The PM ran `afk adopt` against a real Codex run and got
   * `Feature branch not found: feat/afk-v2-routing-adjudication` — the
   * bare PRD slug was used for the state key, so the command was unusable
   * for every non-kiro provider. ADR 0053 makes the run discovered.
   */
  describe("provider-qualified run state", () => {
    const PASSING = {
      resolveGatePlan: () => ({ declarations: GATES }),
      runBaseGates: async ({
        treeId,
        declarations,
      }: {
        treeId: string;
        declarations: readonly GateDeclaration[];
      }) => declarations.map((gate) => passingResult(gate, treeId)),
    };

    it.each(["kiro", "codex", "claude"])(
      "adopts into the %s run's own state and feature branch",
      async (provider) => {
        const repo = makeRepo(provider);
        const { runSlug, featureBranch } = runIdentity(provider);
        const featureBefore = resolveCommit(repo, featureBranch)!;
        const sliceTip = resolveCommit(repo, "manual/demo-01")!;

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
          PASSING,
        );

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain(featureBranch);
        expect(resolveCommit(repo, featureBranch)).not.toBe(featureBefore);
        const state = loadRunState(repo, runSlug);
        expect(state.featureBranch).toBe(featureBranch);
        expect(isSliceComplete(state, "129")).toBe(true);
        expect(state.slices["129"]!.adoption!.commit).toBe(sliceTip);
        // No unqualified sidecar left behind for a non-kiro run.
        expect(existsSync(join(repo, ".afk", "state", "demo.json"))).toBe(
          provider === "kiro",
        );
      },
    );

    it("refuses when two providers ran the same PRD, naming both", async () => {
      const repo = makeRepo("kiro");
      addRun(repo, "codex");
      const kiroBefore = resolveCommit(repo, "feat/demo")!;
      const codexBefore = resolveCommit(repo, "feat-codex/demo")!;
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
      expect(result.output).toContain("more than one run state");
      expect(result.output).toContain("demo, demo-codex");
      expect(result.output).toContain("--provider");
      expect(gatesCalled).toBe(false);
      expect(resolveCommit(repo, "feat/demo")).toBe(kiroBefore);
      expect(resolveCommit(repo, "feat-codex/demo")).toBe(codexBefore);
    });

    it("resolves the ambiguity when --provider names the run", async () => {
      const repo = makeRepo("kiro");
      addRun(repo, "codex");
      const kiroBefore = resolveCommit(repo, "feat/demo")!;

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
          "--provider",
          "codex",
        ],
        repo,
        PASSING,
      );

      expect(result.exitCode).toBe(0);
      expect(isSliceComplete(loadRunState(repo, "demo-codex"), "129")).toBe(
        true,
      );
      expect(Object.keys(loadRunState(repo, "demo").slices)).toEqual([]);
      expect(resolveCommit(repo, "feat/demo")).toBe(kiroBefore);
    });

    it("refuses a --provider with no run state, naming what is present", async () => {
      const repo = makeRepo("codex");

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
          "--provider",
          "kiro",
        ],
        repo,
        PASSING,
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(".afk/state/demo.json");
      expect(result.output).toContain("demo-codex");
    });

    it("refuses a PRD with no run state at all", async () => {
      const repo = makeRepo("codex");
      rmSync(join(repo, ".afk", "state"), { recursive: true, force: true });

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
        PASSING,
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("no run state for 'demo'");
    });
  });
});
