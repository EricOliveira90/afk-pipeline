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
  FINAL_CHANGE_SUMMARY_FILENAME,
  buildChangeSummary,
  buildFinalChangeSummary,
  writeCandidateChangeSummary,
  writeFinalChangeSummary,
} from "./change-summary.js";
import { POST_APPROVAL_WRITING_STAGE_ID } from "./final-evaluation.js";
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

describe("baseline → final change summary", () => {
  /**
   * A repository at the approved baseline, plus one post-approval write on
   * top. The stub stage tiles the whole range by itself, which is the shape
   * PRD 4 ships.
   */
  function makeApprovedThenWritten(): {
    repo: string;
    baseline: string;
    final: string;
  } {
    const repo = makeRepo();
    git(repo, ["commit", "--allow-empty", "-m", "approved candidate"]);
    const baseline = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "tidied.ts"), "export const t = 1;\n", "utf-8");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "post-approval writing"]);
    return { repo, baseline, final: git(repo, ["rev-parse", "HEAD"]).trim() };
  }

  it("[behavior:B-04] binds fromRef to the approved baseline and toRef to the final checkpoint", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();

    const summary = buildFinalChangeSummary({
      cwd: repo,
      baselineRef: baseline,
      finalRef: final,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baseline,
          toRef: final,
        },
      ],
    });

    expect(summary.fromRef).toBe(baseline);
    expect(summary.toRef).toBe(final);
    expect(summary.version).toBe(1);
  });

  it("[behavior:B-04] keys byStage by exactly the writing stage ids that ran", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();

    const summary = buildFinalChangeSummary({
      cwd: repo,
      baselineRef: baseline,
      finalRef: final,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baseline,
          toRef: final,
        },
      ],
    });

    // With only the stub stage, exactly one key.
    expect(Object.keys(summary.byStage)).toEqual([
      POST_APPROVAL_WRITING_STAGE_ID,
    ]);
    expect(summary.stageOrder).toEqual([POST_APPROVAL_WRITING_STAGE_ID]);
  });

  it("[behavior:B-04] sums each stage's files and diff stats to the summary totals", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();

    const summary = buildFinalChangeSummary({
      cwd: repo,
      baselineRef: baseline,
      finalRef: final,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baseline,
          toRef: final,
        },
      ],
    });
    const stages = summary.stageOrder.map((id) => summary.byStage[id]!);

    expect(
      stages.flatMap((stage) => stage.files.map((file) => file.path)).sort(),
    ).toEqual(summary.files.map((file) => file.path).sort());
    for (const key of ["files", "insertions", "deletions", "binaryFiles"] as const) {
      expect(
        stages.reduce((sum, stage) => sum + stage.totals[key], 0),
        key,
      ).toBe(summary.totals[key]);
    }
    expect(summary.totals.files).toBeGreaterThan(0);
  });

  it("[behavior:B-04] refuses a stage list that does not tile the baseline → final range", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();
    const base = { cwd: repo, baselineRef: baseline, finalRef: final };
    const stage = {
      stageId: POST_APPROVAL_WRITING_STAGE_ID,
      fromRef: baseline,
      toRef: final,
    };

    expect(() => buildFinalChangeSummary({ ...base, stages: [] })).toThrow(
      /at least one post-approval writing stage/,
    );
    expect(() =>
      buildFinalChangeSummary({
        ...base,
        stages: [{ ...stage, stageId: "  " }],
      }),
    ).toThrow(/non-blank/);
    expect(() =>
      buildFinalChangeSummary({
        ...base,
        stages: [
          { ...stage, toRef: baseline },
          { ...stage, fromRef: baseline },
        ],
      }),
    ).toThrow(/appears twice/);
    expect(() =>
      buildFinalChangeSummary({ ...base, stages: [{ ...stage, fromRef: final }] }),
    ).toThrow(/not at the approved baseline/);
    expect(() =>
      buildFinalChangeSummary({
        ...base,
        stages: [{ ...stage, toRef: baseline }],
      }),
    ).toThrow(/not at the final checkpoint/);
    // A gap between two stages is a byte no stage is accountable for.
    expect(() =>
      buildFinalChangeSummary({
        ...base,
        stages: [
          { stageId: "first", fromRef: baseline, toRef: baseline },
          { stageId: "second", fromRef: final, toRef: final },
        ],
      }),
    ).toThrow(/must tile the range/);
  });

  it("[behavior:B-04] keeps commits empty when the refs are bare trees", () => {
    const repo = makeRepo();
    const baselineTree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n", "utf-8");
    git(repo, ["add", "-A"]);
    const finalTree = git(repo, ["write-tree"]).trim();

    const summary = buildFinalChangeSummary({
      cwd: repo,
      baselineRef: baselineTree,
      finalRef: finalTree,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baselineTree,
          toRef: finalTree,
        },
      ],
    });

    expect(summary.commits).toEqual([]);
    expect(summary.byStage[POST_APPROVAL_WRITING_STAGE_ID]!.commits).toEqual([]);
  });

  it("[behavior:B-04] writes the final variant under its own artifact name", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();
    const artifactDir = join(repo, ".afk", "artifacts", "prd-x-stub", "slice-04");

    const written = writeFinalChangeSummary({
      cwd: repo,
      artifactDir,
      baselineRef: baseline,
      finalRef: final,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baseline,
          toRef: final,
        },
      ],
    });

    expect(written.path).toBe(join(artifactDir, FINAL_CHANGE_SUMMARY_FILENAME));
    expect(JSON.parse(readFileSync(written.path, "utf-8"))).toEqual(
      written.summary,
    );
  });

  it("[behavior:P-04] leaves the candidate variant and the ChangeSummary v1 shape untouched", () => {
    const { repo, baseline, final } = makeApprovedThenWritten();

    // Both variants come out of the one builder, so the candidate variant's
    // keys are still exactly v1's — the final variant adds its own on top of a
    // per-stage entry that is itself an unextended ChangeSummary.
    const candidate = buildChangeSummary(repo, baseline, final);
    expect(Object.keys(candidate).sort()).toEqual([
      "commits",
      "files",
      "fromRef",
      "toRef",
      "totals",
      "version",
    ]);
    const written = writeCandidateChangeSummary({
      cwd: repo,
      artifactDir: join(repo, ".afk", "artifacts", "prd-x-stub", "slice-04"),
      featureBaseRef: baseline,
      candidateRef: final,
    });
    expect(written.path.endsWith(CHANGE_SUMMARY_FILENAME)).toBe(true);
    expect(written.summary).toEqual(candidate);

    const summary = buildFinalChangeSummary({
      cwd: repo,
      baselineRef: baseline,
      finalRef: final,
      stages: [
        {
          stageId: POST_APPROVAL_WRITING_STAGE_ID,
          fromRef: baseline,
          toRef: final,
        },
      ],
    });
    expect(summary.version).toBe(1);
    expect(Object.keys(summary.byStage[POST_APPROVAL_WRITING_STAGE_ID]!).sort()).toEqual(
      Object.keys(candidate).sort(),
    );
  });
});
