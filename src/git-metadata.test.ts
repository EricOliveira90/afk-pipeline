import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAddedMigrationFiles, resolveCommit } from "./git.js";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("terminal Git metadata", () => {
  it("resolves the final SHA and lists only newly added migrations", () => {
    const repo = mkdtempSync(join(tmpdir(), "afk-git-metadata-"));
    tempDirs.push(repo);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);

    const migrations = join(repo, "supabase", "migrations");
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, "001_existing.sql"), "select 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);

    git(repo, ["checkout", "-b", "feat/example"]);
    writeFileSync(join(migrations, "001_existing.sql"), "select 2;\n");
    writeFileSync(join(migrations, "002_added.sql"), "select 2;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "add migration"]);

    expect(resolveCommit(repo, "feat/example")).toBe(
      git(repo, ["rev-parse", "feat/example"]),
    );
    expect(
      listAddedMigrationFiles(repo, "main", "feat/example"),
    ).toEqual(["supabase/migrations/002_added.sql"]);
  });
});
