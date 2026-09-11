/**
 * The scoped merge-resolution round (#132), tested against real repositories
 * and real `GateDeclaration`s: the round's whole subject is what git left in a
 * worktree, so a mocked git would test the mock. The two pure functions — the
 * bounding function and the marker scan — are tested without a repository at
 * all, which is where the fast assertions live.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  boundMergeResolutionBlock,
  conflictMarkerPaths,
  resolveRef,
  runMergeResolutionRound,
  CONFLICT_MARKER_PREFIXES,
  MERGE_RESOLUTION_BLOCK_HEADINGS,
  type MergeResolutionGatePhaseInput,
} from "./merge-resolution.js";
import { scopeGateDeclaration, SCOPE_GATE_ID } from "./scope-gate.js";
import {
  ACCEPTANCE_GATE_ID,
  ACCEPTANCE_GATE_STAGE,
  type GateDeclaration,
  type GateStatus,
} from "./gate-runner.js";
import { RunJournal } from "./run-journal.js";
import { lifecycle } from "./slice-lifecycle.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — Windows holds handles briefly
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const SLICE_DIR = ".kiro/specs/demo/slices/06-demo";

function manifest(paths: string[]): string {
  return JSON.stringify(
    {
      version: 2,
      fileScope: { kind: "paths", paths },
      migrationCount: 0,
      behaviors: [
        {
          id: "B-01",
          source: "GH #1 AC1",
          given: "a demo",
          when: "it runs",
          then: "it works",
          observableResult: "the test passes",
          preservation: false,
          gateIds: ["tests"],
        },
      ],
    },
    null,
    2,
  );
}

interface ConflictRepo {
  dir: string;
  featureTip: string;
  sliceTip: string;
}

/**
 * A repository whose `slice` branch and `feature` branch changed the same line
 * of `src/shared.ts`, each also carrying a file of its own. Checked out on
 * `slice`, which is the state the wave's merge path leaves the slice worktree
 * in when git refuses the merge.
 */
function makeConflictRepo(scope = ["src/shared.ts", "src/mine.ts"]): ConflictRepo {
  const dir = mkdtempSync(join(tmpdir(), "afk-merge-resolution-"));
  tempDirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "afk@example.com"]);
  git(dir, ["config", "user.name", "afk"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, "src/shared.ts", "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
  write(dir, `${SLICE_DIR}/contract.md`, "# Contract\n\nDemo.\n");
  write(dir, `${SLICE_DIR}/acceptance-manifest.json`, manifest(scope));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  write(dir, "src/shared.ts", "export const one = 1;\nexport const two = 22;\nexport const three = 3;\n");
  write(dir, "src/sibling.ts", "export const sibling = true;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "sibling work"]);
  const featureTip = git(dir, ["rev-parse", "HEAD"]);

  git(dir, ["checkout", "main"]);
  git(dir, ["checkout", "-b", "slice"]);
  write(dir, "src/shared.ts", "export const one = 1;\nexport const two = 222;\nexport const three = 3;\n");
  write(dir, "src/mine.ts", "export const mine = true;\n");
  // A negotiated slice always shows its accepted contract pair as changed
  // against the feature branch — which is exactly why the scope gate takes an
  // attestation instead of exempting the pair unconditionally.
  write(dir, `${SLICE_DIR}/contract.md`, "# Contract\n\nLocked.\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "slice work"]);
  const sliceTip = git(dir, ["rev-parse", "HEAD"]);

  return { dir, featureTip, sliceTip };
}

function evidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-merge-resolution-evidence-"));
  tempDirs.push(dir);
  return dir;
}

function stubGate(
  id: string,
  stage: string,
  status: GateStatus,
): GateDeclaration {
  return {
    id,
    stage,
    required: true,
    run: () => ({
      status,
      failureKind: status === "PASS" ? null : "COMMAND",
      detail: `stub ${id} ${status}`,
    }),
  };
}

function gatePhase(
  repo: ConflictRepo,
  options: {
    acceptedPairIntact?: boolean;
    acceptance?: GateStatus;
    onOutcome?: (gateId: string, status: GateStatus) => void;
  } = {},
): MergeResolutionGatePhaseInput {
  return {
    repoRoot: repo.dir,
    ghIssue: "132",
    sliceNumber: "06",
    tag: "[afk] Slice #132 (demo)",
    round: 0,
    // Outside the worktree, as in production (the run's log directory lives in
    // the host repo, not in the slice's worktree): gate logs written *into* the
    // tree under test would show up as that tree's own untracked changes.
    evidenceDir: evidenceDir(),
    declarations: [
      scopeGateDeclaration({
        source: {
          kind: "candidate",
          worktreeDir: repo.dir,
          featureRef: repo.featureTip,
        },
        absSliceDir: join(repo.dir, SLICE_DIR),
        sliceArtifactDir: SLICE_DIR,
        acceptedPairIntact: options.acceptedPairIntact ?? true,
      }),
      stubGate(
        ACCEPTANCE_GATE_ID,
        ACCEPTANCE_GATE_STAGE,
        options.acceptance ?? "PASS",
      ),
    ],
    label: "merge resolution gates",
    infrastructureRetries: 0,
    inactivityTimeoutMs: 60_000,
    wallClockTimeoutMs: 120_000,
    heartbeatIntervalMs: 30_000,
    onGateOutcome: (outcome) =>
      options.onOutcome?.(outcome.gateId, outcome.status),
    onInfrastructureRetry: () => {},
  };
}

/** Resolve every conflicted path and commit the in-progress merge. */
function resolveAndCommit(dir: string, resolved: string): () => Promise<void> {
  return async () => {
    write(dir, "src/shared.ts", resolved);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--no-edit", "-m", "merge feature into slice"]);
  };
}

const BOTH_SIDES =
  "export const one = 1;\nexport const two = 22;\nexport const twoAgain = 222;\nexport const three = 3;\n";

describe("runMergeResolutionRound", () => {
  it("B-03: re-enters runCandidateGatePhase on the resolution merge commit's own tree with the slice's scope and acceptance declarations", async () => {
    const repo = makeConflictRepo();
    const seen: Array<[string, GateStatus]> = [];
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: resolveAndCommit(repo.dir, BOTH_SIDES),
      gatePhase: gatePhase(repo, {
        onOutcome: (gateId, status) => seen.push([gateId, status]),
      }),
    });

    expect(result.verdict).toBe("RESOLVED");
    expect(result.conflictedPaths).toEqual(["src/shared.ts"]);
    // The commit the gates proved: a merge commit whose second parent is the
    // merged feature tip and whose first parent is the pre-round slice tip.
    const parents = git(repo.dir, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ]).split(/\s+/);
    expect(parents[1]).toBe(repo.sliceTip);
    expect(parents[2]).toBe(repo.featureTip);
    expect(result.resolutionCommit).toBe(parents[0]);
    expect(result.treeId).toBe(git(repo.dir, ["rev-parse", "HEAD^{tree}"]));
    expect(result.gateRun?.evidence.treeId).toBe(result.treeId);
    // Both required declarations ran, on that tree, and the phase — not a
    // duplicated body — produced the evidence.
    expect(seen).toEqual([
      [SCOPE_GATE_ID, "PASS"],
      [ACCEPTANCE_GATE_ID, "PASS"],
    ]);
    for (const gate of result.gateRun!.evidence.results) {
      expect(gate.treeId).toBe(result.treeId);
    }
    expect(readFileSync(join(repo.dir, "src", "shared.ts"), "utf-8")).toBe(
      BOTH_SIDES,
    );
  });

  it("B-04: a red required gate keeps the resolution commit, leaves the feature tip unmoved and earns no retry", async () => {
    const repo = makeConflictRepo();
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: resolveAndCommit(repo.dir, BOTH_SIDES),
      gatePhase: gatePhase(repo, { acceptance: "FAIL" }),
    });

    expect(result.verdict).toBe("GATES-RED");
    expect(result.detail).toContain(ACCEPTANCE_GATE_ID);
    // Kept, not reset (ADR 0039): the commit is still the slice branch tip and
    // still reachable, and both refs are alive.
    expect(git(repo.dir, ["rev-parse", "slice"])).toBe(result.resolutionCommit);
    expect(git(repo.dir, ["rev-parse", "feature"])).toBe(repo.featureTip);
    expect(
      git(repo.dir, ["merge-base", "--is-ancestor", repo.sliceTip, "slice"]),
    ).toBe("");
  });

  it("B-06: refuses the retry when the resolved tree still carries conflict markers in a conflicted path, and dispatches no second round", async () => {
    const repo = makeConflictRepo();
    let dispatches = 0;
    const withMarkers =
      "export const one = 1;\n" +
      "<<<<<<< HEAD\nexport const two = 222;\n=======\nexport const two = 22;\n>>>>>>> feature\n" +
      "export const three = 3;\n";
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: async (block) => {
        dispatches++;
        await resolveAndCommit(repo.dir, withMarkers)();
        expect(block).toContain("src/shared.ts");
      },
      // Green gates on purpose: a suite that never opens the file cannot see
      // the markers, which is the case the pre-retry scan exists for.
      gatePhase: gatePhase(repo, { acceptance: "PASS" }),
    });

    expect(result.verdict).toBe("CONFLICT-MARKERS");
    expect(result.markerPaths).toEqual(["src/shared.ts"]);
    expect(dispatches).toBe(1);
    // The round refuses; it does not undo. The commit stays on the slice
    // branch and the feature tip never moved, so nothing shipped the markers.
    expect(git(repo.dir, ["rev-parse", "slice"])).toBe(result.resolutionCommit);
    expect(git(repo.dir, ["rev-parse", "feature"])).toBe(repo.featureTip);
  });

  it("B-07: the scope gate compares against the merged feature tip, so an already-merged sibling's file is not this slice's violation", async () => {
    const repo = makeConflictRepo();
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: resolveAndCommit(repo.dir, BOTH_SIDES),
      gatePhase: gatePhase(repo),
    });

    expect(result.verdict).toBe("RESOLVED");
    const scope = result.gateRun!.evidence.results.find(
      (gate) => gate.gateId === SCOPE_GATE_ID,
    );
    expect(scope?.status).toBe("PASS");
    expect(scope?.findings?.outOfScopePaths ?? []).not.toContain(
      "src/sibling.ts",
    );
    // The sibling's file is in the tree the gate ran on — it is not absent, it
    // is merged.
    expect(git(repo.dir, ["cat-file", "-e", "HEAD:src/sibling.ts"])).toBe("");
  });

  it("B-07: acceptedPairIntact is load-bearing, so a caller may not pass a literal true", async () => {
    const repo = makeConflictRepo();
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: resolveAndCommit(repo.dir, BOTH_SIDES),
      // What an unprovable pair gets: the same round, with both contract files
      // named instead of exempted. A caller hard-coding `true` would be
      // asserting something this value can be false about.
      gatePhase: gatePhase(repo, { acceptedPairIntact: false }),
    });

    expect(result.verdict).toBe("GATES-RED");
    const scope = result.gateRun!.evidence.results.find(
      (gate) => gate.gateId === SCOPE_GATE_ID,
    );
    expect(scope?.status).toBe("FAIL");
    expect(scope?.findings?.outOfScopePaths).toEqual([
      `${SLICE_DIR}/contract.md`,
    ]);
  });

  it("aborts the merge it started and keeps the slice tip when the generator resolves nothing", async () => {
    const repo = makeConflictRepo();
    const result = await runMergeResolutionRound({
      worktreeDir: repo.dir,
      featureRef: repo.featureTip,
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      blockBudgetBytes: 64_000,
      dispatchGenerator: async () => {},
      gatePhase: gatePhase(repo),
    });

    expect(result.verdict).toBe("UNRESOLVED");
    expect(git(repo.dir, ["rev-parse", "HEAD"])).toBe(repo.sliceTip);
    expect(git(repo.dir, ["rev-parse", "feature"])).toBe(repo.featureTip);
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a gate re-run that does not carry the slice's required scope declaration", async () => {
    const repo = makeConflictRepo();
    const phase = gatePhase(repo);
    await expect(
      runMergeResolutionRound({
        worktreeDir: repo.dir,
        featureRef: repo.featureTip,
        conflictDetails: "conflict",
        blockBudgetBytes: 64_000,
        dispatchGenerator: async () => {},
        gatePhase: {
          ...phase,
          declarations: phase.declarations.filter(
            (declaration) => declaration.id !== SCOPE_GATE_ID,
          ),
        },
      }),
    ).rejects.toThrow(/required scope declaration/);
    // Refused before the merge started, so the worktree is untouched.
    expect(git(repo.dir, ["status", "--porcelain"])).toBe("");
  });
});

describe("resolveRef", () => {
  it("resolves a branch name to the sha the round merges", () => {
    const repo = makeConflictRepo();
    expect(resolveRef(repo.dir, "feature")).toBe(repo.featureTip);
  });
});

describe("conflictMarkerPaths", () => {
  it("names every path whose content still carries a marker at line start", () => {
    expect(
      conflictMarkerPaths([
        { path: "a.ts", content: "const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n" },
        { path: "b.ts", content: "const b = 2;\n" },
        { path: "c.md", content: "text\n>>>>>>> feat/x\n" },
        { path: "d.ts", content: "const d = 4;\n======= \n" },
      ]),
    ).toEqual(["a.ts", "c.md", "d.ts"]);
  });

  it("does not read a Markdown setext underline or an indented marker as a conflict", () => {
    expect(
      conflictMarkerPaths([
        { path: "doc.md", content: "Heading\n=======\n\nBody.\n" },
        { path: "e.ts", content: 'const s = "  <<<<<<< HEAD";\n' },
      ]),
    ).toEqual([]);
    // The literals are the contract's, trailing space included.
    expect(CONFLICT_MARKER_PREFIXES).toEqual([
      "<<<<<<< ",
      "======= ",
      ">>>>>>> ",
    ]);
  });
});

describe("boundMergeResolutionBlock", () => {
  const entry = (path: string, bytes: number) => ({
    path,
    diff: `@@ -1 +1 @@\n+${"x".repeat(bytes)}`,
  });

  it("B-10: drops whole files with a note naming them and their worktree, and stays inside the budget", () => {
    const worktreeDir = "C:/tmp/afk-slice-06";
    const block = boundMergeResolutionBlock({
      worktreeDir,
      featureRef: "feat/demo",
      conflictDetails: "CONFLICT (content): Merge conflict in src/shared.ts",
      hunks: [entry("src/shared.ts", 200)],
      siblingDiffs: [
        entry("src/sibling-a.ts", 4_000),
        entry("src/sibling-b.ts", 4_000),
      ],
      budgetBytes: 3_000,
    });

    expect(Buffer.byteLength(block, "utf-8")).toBeLessThanOrEqual(3_000);
    // The conflict is what the round is for, so its hunk is kept and the
    // sibling context is what yields.
    expect(block).toContain(MERGE_RESOLUTION_BLOCK_HEADINGS.hunks);
    expect(block).toContain("### src/shared.ts");
    expect(block).not.toContain("### src/sibling-a.ts");
    expect(block).toContain("2 file(s) omitted");
    expect(block).toContain("`src/sibling-a.ts`");
    expect(block).toContain("`src/sibling-b.ts`");
    expect(block).toContain(worktreeDir);
    // Diffs, never a sibling's commit history.
    expect(block).not.toMatch(/^commit [0-9a-f]{40}$/m);
  });

  it("B-10: never truncates a kept diff, and keeps every heading below level 1", () => {
    const block = boundMergeResolutionBlock({
      worktreeDir: "/tmp/wt",
      featureRef: "feat/demo",
      conflictDetails: "conflict",
      hunks: [entry("src/shared.ts", 40)],
      siblingDiffs: [entry("src/sibling.ts", 40)],
      budgetBytes: 8_000,
    });

    expect(block).toContain(`+${"x".repeat(40)}`);
    expect(block).not.toContain("omitted");
    // The block lives inside one level-1 section of the repair situation; a
    // level-1 heading here would split that section's extent.
    expect(block.split("\n").filter((line) => /^# /.test(line))).toEqual([]);
    expect(block).toContain(
      `## ${MERGE_RESOLUTION_BLOCK_HEADINGS.conflictedPaths}`,
    );
    expect(block).toContain(
      `## ${MERGE_RESOLUTION_BLOCK_HEADINGS.siblingDiffs}`,
    );
  });
});

describe("run-summary.md", () => {
  it("B-08: renders the round's verdict and duration in its own section, outside the repair-round counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-merge-resolution-summary-"));
    tempDirs.push(dir);
    const logger = new RunJournal(dir, "resolution");
    const slice = { ghIssue: "132", title: "Merge resolution", branch: "slice" };
    logger.trackSlice(lifecycle.running(slice, { genRounds: 1, evalRounds: 1 }));
    logger.recordTerminal(slice, { phase: "CONFLICT", error: "conflict" });
    logger.event({
      type: "merge-resolution-round",
      ghIssue: "132",
      sliceNumber: "06",
      verdict: "CONFLICT-MARKERS",
      durationMs: 4_321,
      conflictedPaths: ["src/shared.ts"],
      treeId: "abc123",
      detail: "markers survived",
    });

    const md = logger.writeSummary();
    const section = md.indexOf("## Merge Resolution Rounds");
    expect(section).toBeGreaterThan(-1);
    expect(md.slice(section)).toContain("CONFLICT-MARKERS");
    expect(md.slice(section)).toContain("4321ms");
    expect(md.slice(section)).toContain("`src/shared.ts`");
    // Distinct from the per-slice Rounds column, which is the repair rounds.
    expect(md.indexOf("| Slice | Status | Rounds |")).toBeLessThan(section);
  });

  it("B-08: leaves a run without a resolution round byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-merge-resolution-quiet-"));
    tempDirs.push(dir);
    const logger = new RunJournal(dir, "quiet");
    const slice = { ghIssue: "1", title: "Quiet", branch: "b" };
    logger.trackSlice(lifecycle.running(slice, { genRounds: 1, evalRounds: 1 }));
    logger.recordTerminal(slice, { phase: "PASS" });
    expect(logger.writeSummary()).not.toContain("Merge Resolution Rounds");
  });
});
