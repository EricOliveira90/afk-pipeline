/**
 * The file-scope gate's comparison, against real throwaway repositories.
 *
 * Real `git`, not a mock, for the same reason `src/git.test.ts` does it: the
 * behavior under test *is* what git reports — a three-dot base resolved
 * through a merge, an untracked file, a path git prints in its own spelling —
 * and a stub would only assert the fixture author's model of git. Repos are
 * shared per `describe` where the block's cases are read-only, because
 * building one costs several git processes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGates } from "./gate-runner.js";
import { runScopeGate, scopeGateDeclaration, SCOPE_GATE_ID } from "./scope-gate.js";
import { rmDirWithRetry } from "./test-support.js";

function git(cwd: string, args: string[]): string {
  // `stdio` piped rather than inherited: `git checkout` writes "Switched to
  // branch" to stderr, and a dozen of those buried in the reporter's output
  // makes a real failure harder to find.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const REL_SLICE_DIR = "specs/slices/01-scope-gate";

function write(repoDir: string, relPath: string, content: string): void {
  const abs = join(repoDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

/**
 * A locked manifest on disk. `paths: null` writes the
 * `no-repository-changes` scope, which declares nothing at all.
 */
function writeManifest(
  repoDir: string,
  paths: readonly string[] | null,
): void {
  write(
    repoDir,
    `${REL_SLICE_DIR}/acceptance-manifest.json`,
    JSON.stringify({
      version: 2,
      fileScope:
        paths === null
          ? { kind: "no-repository-changes" }
          : { kind: "paths", paths },
      migrationCount: 0,
      behaviors: [
        {
          id: "B-01",
          source: "scope gate fixture",
          given: "a locked file scope",
          when: "the candidate is compared against it",
          then: "an undeclared change is a violation",
          observableResult: "the gate names the path",
          preservation: false,
          gateIds: ["tests"],
        },
      ],
    }),
  );
}

function initRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  git(repoDir, ["init", "--initial-branch=main"]);
  write(repoDir, "README.md", "root\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "root"]);
  return repoDir;
}

/**
 * One repository holding every classification case at once: a declared
 * committed change, an undeclared committed change, an untracked file, a file
 * in the slice artifact directory, a migration, a declared path whose
 * `fileScope` entry is spelled with different casing, and the accepted
 * `contract.md` / `acceptance-manifest.json` pair a negotiated slice tree
 * always carries.
 */
describe("scope gate against a real candidate worktree", () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = initRepo("afk-scope-gate-");
    git(repoDir, ["checkout", "-b", "slice"]);
    // The accepted pair, written into the worktree during negotiation — which
    // is why it always shows up in the changed set (`src/escalation.ts`).
    write(repoDir, `${REL_SLICE_DIR}/contract.md`, "# Slice Contract\n");
    writeManifest(repoDir, [
      "src/declared.ts",
      // Deliberately not the on-disk casing: `normalizePath` lowercases both
      // sides, so a tracked spelling can never produce a false violation.
      "SRC/CASED.TS",
    ]);
    write(repoDir, "src/declared.ts", "export const declared = 1;\n");
    write(repoDir, "src/Cased.ts", "export const cased = 1;\n");
    write(repoDir, "src/undeclared.ts", "export const undeclared = 1;\n");
    write(repoDir, `${REL_SLICE_DIR}/handoff.md`, "# Handoff\n");
    write(repoDir, "supabase/migrations/010_orders.sql", "-- orders\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "slice work"]);
    // Uncommitted and untracked, because the generator's work is not
    // committed until the slice passes (`prd.md` D3).
    write(repoDir, "src/declared.ts", "export const declared = 2;\n");
    write(repoDir, "src/orphan.ts", "export const orphan = 1;\n");
  });

  afterAll(() => {
    rmDirWithRetry(repoDir);
  });

  function runAgainstWorktree(acceptedPairIntact: boolean) {
    return runScopeGate({
      source: { kind: "candidate", worktreeDir: repoDir, featureRef: "main" },
      absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
      sliceArtifactDir: REL_SLICE_DIR,
      acceptedPairIntact,
    });
  }

  it("B-09: names only the undeclared source and untracked paths as violations", () => {
    const outcome = runAgainstWorktree(true);

    expect(outcome.status).toBe("FAIL");
    expect(outcome.failureKind).toBe("COMMAND");
    expect(outcome.findings?.outOfScopePaths).toEqual([
      "src/orphan.ts",
      "src/undeclared.ts",
    ]);
    // Named exactly, because the gate log is what the repair round reads.
    expect(outcome.detail).toContain("src/undeclared.ts");
    expect(outcome.detail).toContain("src/orphan.ts");
  });

  it("B-09: exempts the artifact directory, the migration and a case-differing declared path", () => {
    const offenders = runAgainstWorktree(true).findings?.outOfScopePaths ?? [];

    expect(offenders).not.toContain(`${REL_SLICE_DIR}/handoff.md`);
    expect(offenders).not.toContain("supabase/migrations/010_orders.sql");
    expect(offenders).not.toContain("src/Cased.ts");
    expect(offenders).not.toContain("src/declared.ts");
  });

  it("B-10: names both accepted-pair files when the caller cannot prove the pair", () => {
    const proven = runAgainstWorktree(true).findings?.outOfScopePaths ?? [];
    const unproven = runAgainstWorktree(false);

    expect(proven).not.toContain(`${REL_SLICE_DIR}/contract.md`);
    expect(unproven.status).toBe("FAIL");
    expect(unproven.findings?.outOfScopePaths).toContain(
      `${REL_SLICE_DIR}/contract.md`,
    );
    expect(unproven.findings?.outOfScopePaths).toContain(
      `${REL_SLICE_DIR}/acceptance-manifest.json`,
    );
  });

  it("B-07: compares against the manifest bytes on disk at gate time, not at declaration time", async () => {
    const declaration = scopeGateDeclaration({
      source: { kind: "candidate", worktreeDir: repoDir, featureRef: "main" },
      absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
      sliceArtifactDir: REL_SLICE_DIR,
      acceptedPairIntact: true,
    });
    // An ADR 0048 scope amendment applied during the QA window, after the
    // declaration was built.
    writeManifest(repoDir, [
      "src/declared.ts",
      "SRC/CASED.TS",
      "src/undeclared.ts",
    ]);
    try {
      const outcome = await declaration.run!({ treeId: "t", cwd: repoDir });

      expect(outcome.findings?.outOfScopePaths).toEqual(["src/orphan.ts"]);
    } finally {
      writeManifest(repoDir, ["src/declared.ts", "SRC/CASED.TS"]);
    }
  });

  it("B-06: probes the source worktree and keeps the recorded treeId, with a different gate cwd", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "afk-scope-gate-cwd-"));
    const evidenceDir = join(elsewhere, "evidence");
    const treeId = "cccccccccccccccccccccccccccccccccccccccc";
    try {
      const result = await runGates({
        treeId,
        // Not a git repository at all, and not the worktree the comparison is
        // about: an unmaterialized post-QA checkpoint has no directory
        // (`src/post-qa-gates.ts`).
        cwd: join(elsewhere, "unmaterialized-checkpoint"),
        evidenceDir,
        declarations: [
          scopeGateDeclaration({
            source: {
              kind: "candidate",
              worktreeDir: repoDir,
              featureRef: "main",
            },
            absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
            sliceArtifactDir: REL_SLICE_DIR,
            acceptedPairIntact: true,
          }),
        ],
        inactivityTimeoutMs: 15_000,
        wallClockTimeoutMs: 30_000,
        heartbeatIntervalMs: 20,
      });

      const [gate] = result.evidence.results;
      expect(gate?.gateId).toBe(SCOPE_GATE_ID);
      expect(gate?.status).toBe("FAIL");
      expect(gate?.treeId).toBe(treeId);
      // The uncommitted edit and the untracked file both came from
      // `worktreeDir`, so the probe read that directory and not `cwd`.
      expect(gate?.findings?.outOfScopePaths).toContain("src/orphan.ts");
    } finally {
      rmDirWithRetry(elsewhere);
    }
  });

  it("P-02: reuses the shared comparison and probe helpers rather than copying them", () => {
    const source = readFileSync(
      new URL("./scope-gate.ts", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('from "./escalation.js"');
    expect(source).toContain('from "./git.js"');
    expect(source).toContain("outOfScopeChangedPaths(");
    expect(source).toContain("listChangedFiles(");
    expect(source).toContain("diffTreePaths(");
    // No second path normalizer and no second changed-set probe.
    expect(source).not.toContain("toLowerCase");
    expect(source).not.toContain("execFileSync");
  });
});

describe("scope gate fail-closed and base resolution", () => {
  it("B-05: reports an unprovable changed set as infrastructure with no findings", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "afk-scope-gate-bare-"));
    try {
      const outcome = runScopeGate({
        source: {
          kind: "candidate",
          worktreeDir: notARepo,
          featureRef: "main",
        },
        absSliceDir: notARepo,
        sliceArtifactDir: REL_SLICE_DIR,
        acceptedPairIntact: true,
      });

      expect(outcome.status).toBe("INFRASTRUCTURE");
      expect(outcome.failureKind).toBeNull();
      expect(outcome.detail).toContain("could not be determined");
      // Never an empty violation list, which would read as a clean tree.
      expect(outcome.findings).toBeUndefined();
    } finally {
      rmDirWithRetry(notARepo);
    }
  });

  it("B-14: excludes a sibling path that reached this tree only through the feature-branch merge", () => {
    const repoDir = initRepo("afk-scope-gate-merge-");
    try {
      git(repoDir, ["checkout", "-b", "feature"]);
      git(repoDir, ["checkout", "-b", "slice"]);
      write(repoDir, `${REL_SLICE_DIR}/contract.md`, "# Slice Contract\n");
      writeManifest(repoDir, ["src/mine.ts"]);
      write(repoDir, "src/mine.ts", "export const mine = 1;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "slice work"]);
      // A sibling slice merged its own work into the feature branch while
      // this slice was away, and the slice tree took the merge (#132).
      git(repoDir, ["checkout", "feature"]);
      write(repoDir, "src/sibling.ts", "export const sibling = 1;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "sibling work"]);
      git(repoDir, ["checkout", "slice"]);
      git(repoDir, ["merge", "--no-edit", "feature"]);

      const outcome = runScopeGate({
        source: {
          kind: "candidate",
          worktreeDir: repoDir,
          featureRef: "feature",
        },
        absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
        sliceArtifactDir: REL_SLICE_DIR,
        acceptedPairIntact: true,
      });

      // `feature...HEAD` is `merge-base(feature, HEAD)..HEAD`, and the merge
      // made the feature tip that merge base, so the sibling's path is in
      // neither the changed set nor the violation list.
      expect(outcome.status).toBe("PASS");
      expect(outcome.findings).toBeUndefined();
    } finally {
      rmDirWithRetry(repoDir);
    }
  });

  it("B-11: compares checkpoint tree to checkpoint tree for a role write scope", () => {
    const repoDir = initRepo("afk-scope-gate-role-");
    try {
      write(repoDir, `${REL_SLICE_DIR}/contract.md`, "# Slice Contract\n");
      writeManifest(repoDir, ["src/declared.ts"]);
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "locked contract"]);
      const inputCheckpointTree = git(repoDir, ["rev-parse", "HEAD^{tree}"]);
      write(repoDir, "src/declared.ts", "export const declared = 1;\n");
      write(repoDir, "src/role-undeclared.ts", "export const x = 1;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "role output"]);
      const outputCheckpointTree = git(repoDir, ["rev-parse", "HEAD^{tree}"]);
      // Present in the working tree only, so a working-tree probe would see
      // it and a tree-to-tree diff must not.
      write(repoDir, "src/uncommitted.ts", "export const y = 1;\n");

      const outcome = runScopeGate({
        source: {
          kind: "role",
          cwd: repoDir,
          inputCheckpointTree,
          outputCheckpointTree,
        },
        absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
        sliceArtifactDir: REL_SLICE_DIR,
        acceptedPairIntact: true,
      });

      expect(outcome.status).toBe("FAIL");
      expect(outcome.findings?.outOfScopePaths).toEqual([
        "src/role-undeclared.ts",
      ]);
    } finally {
      rmDirWithRetry(repoDir);
    }
  });

  it("B-13: passes a no-repository-changes manifest only while nothing outside the allowlist changed", () => {
    const repoDir = initRepo("afk-scope-gate-empty-");
    try {
      git(repoDir, ["checkout", "-b", "slice"]);
      write(repoDir, `${REL_SLICE_DIR}/contract.md`, "# Slice Contract\n");
      writeManifest(repoDir, null);
      write(repoDir, "supabase/migrations/011_empty.sql", "-- empty\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "artifacts and migration only"]);
      const input = {
        source: {
          kind: "candidate" as const,
          worktreeDir: repoDir,
          featureRef: "main",
        },
        absSliceDir: join(repoDir, ...REL_SLICE_DIR.split("/")),
        sliceArtifactDir: REL_SLICE_DIR,
        acceptedPairIntact: true,
      };

      expect(runScopeGate(input).status).toBe("PASS");

      write(repoDir, "src/sneaked.ts", "export const sneaked = 1;\n");
      const outcome = runScopeGate(input);

      expect(outcome.status).toBe("FAIL");
      expect(outcome.findings?.outOfScopePaths).toEqual(["src/sneaked.ts"]);
    } finally {
      rmDirWithRetry(repoDir);
    }
  });
});
