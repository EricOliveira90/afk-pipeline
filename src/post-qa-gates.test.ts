import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCandidateTreeId } from "./gate-runner.js";
import { reviewArtifactViolations } from "./post-qa-gates.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Unit-level proof of the A1 tree-authority allowlist (guardian round 2):
 * the QA verdict authorizes exactly one captured tree, and the only drift a
 * later step may accept is inside the slice's review-artifact directory.
 */
describe("reviewArtifactViolations (architect A1 tree authority)", () => {
  let repo: string;
  const sliceDir = "specs/demo/slices/01-fixture";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "afk-tree-authority-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, sliceDir), { recursive: true });
    writeFileSync(join(repo, "src", "work.ts"), "export const v = 1;\n");
    writeFileSync(join(repo, sliceDir, "contract.md"), "# Contract\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "base"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns nothing for the identical tree", () => {
    const tree = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: tree,
        toTree: tree,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([]);
  });

  it("accepts drift confined to the slice's review-artifact directory", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    // The QA evaluator legitimately writes its report into the slice dir.
    writeFileSync(join(repo, sliceDir, "qa-report-r1-a1.md"), "PASS\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(postQa).not.toBe(qaApproved);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([]);
  });

  it("names every path drifting outside the allowlist, fail-closed input", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    // An evaluator source edit alongside a legitimate review artifact.
    writeFileSync(join(repo, sliceDir, "qa-report-r1-a1.md"), "PASS\n");
    writeFileSync(join(repo, "src", "work.ts"), "export const v = 2;\n");
    writeFileSync(join(repo, "src", "evil.ts"), "export const e = 1;\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual(["src/evil.ts", "src/work.ts"]);
  });

  it("does not let a sibling directory sharing the prefix string pass", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    mkdirSync(join(repo, `${sliceDir}-evil`), { recursive: true });
    writeFileSync(join(repo, `${sliceDir}-evil`, "x.ts"), "1\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([`${sliceDir}-evil/x.ts`]);
  });
});
