import { afterEach, describe, expect, it } from "vitest";
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
import {
  CHANGE_SUMMARY_FILENAME,
  buildChangeSummary,
  writeCandidateChangeSummary,
} from "./change-summary.js";
import { rmDirWithRetry } from "./test-support.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmDirWithRetry(dir);
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-change-summary-"));
  dirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "fixture@example.com"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  // No machine-global hooks in a fixture repository.
  const hooksDir = join(repo, ".git", "test-hooks");
  mkdirSync(hooksDir, { recursive: true });
  git(repo, ["config", "core.hooksPath", hooksDir]);
  writeFileSync(join(repo, "kept.txt"), "one\ntwo\n", "utf-8");
  writeFileSync(join(repo, "removed.txt"), "gone\n", "utf-8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

describe("change summary", () => {
  it("[behavior:B-05] reports commits, per-file stats and totals between two refs", () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    rmSync(join(repo, "removed.txt"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "added.ts"), "export const a = 1;\n", "utf-8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "candidate work"]);
    const candidate = git(repo, ["rev-parse", "HEAD"]).trim();

    const summary = buildChangeSummary(repo, base, candidate);

    expect(summary.version).toBe(1);
    expect(summary.fromRef).toBe(base);
    expect(summary.toRef).toBe(candidate);
    expect(summary.commits).toEqual([
      { sha: candidate, subject: "candidate work" },
    ]);
    expect(summary.files).toEqual([
      { path: "kept.txt", status: "M", insertions: 1, deletions: 0 },
      { path: "removed.txt", status: "D", insertions: 0, deletions: 1 },
      { path: "src/added.ts", status: "A", insertions: 1, deletions: 0 },
    ]);
    expect(summary.totals).toEqual({
      files: 3,
      insertions: 2,
      deletions: 1,
      binaryFiles: 0,
    });
  });

  it("[behavior:B-05] is deterministic and carries no timestamp or run identity", () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    git(repo, ["commit", "-am", "again"]);
    const candidate = git(repo, ["rev-parse", "HEAD"]).trim();

    const first = buildChangeSummary(repo, base, candidate);
    const second = buildChangeSummary(repo, base, candidate);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(first).sort()).toEqual([
      "commits",
      "files",
      "fromRef",
      "toRef",
      "totals",
      "version",
    ]);
  });

  it("[behavior:B-05] compares bare trees, with no commits to list", () => {
    const repo = makeRepo();
    const baseTree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    git(repo, ["add", "-A"]);
    const candidateTree = git(repo, ["write-tree"]).trim();

    const summary = buildChangeSummary(repo, baseTree, candidateTree);

    expect(summary.commits).toEqual([]);
    expect(summary.files).toEqual([
      { path: "kept.txt", status: "M", insertions: 1, deletions: 0 },
    ]);
  });

  it("[behavior:B-05] writes the candidate variant into the slice artifact directory", () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    git(repo, ["commit", "-am", "candidate work"]);
    const candidate = git(repo, ["rev-parse", "HEAD"]).trim();
    const artifactDir = join(repo, ".afk", "artifacts", "prd-x-stub", "slice-01");

    const written = writeCandidateChangeSummary({
      cwd: repo,
      artifactDir,
      featureBaseRef: base,
      candidateRef: candidate,
    });

    expect(written.path).toBe(join(artifactDir, CHANGE_SUMMARY_FILENAME));
    const onDisk = readFileSync(written.path, "utf-8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(JSON.parse(onDisk)).toEqual(written.summary);
    expect(written.summary).toMatchObject({
      version: 1,
      fromRef: base,
      toRef: candidate,
    });
  });
});
