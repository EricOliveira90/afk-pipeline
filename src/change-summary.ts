/**
 * The slice diff change summary (#91 AC7, PRD D11).
 *
 * One producer, two variants. The builder below is parameterised by a repo
 * directory and two tree-ish refs and holds no orchestrator, run-state or
 * run-slug state, which is what lets slice 04 add the baseline → final
 * variant here rather than write a second producer (D11): every variant is
 * the same two-ref read with its refs bound differently.
 *
 * The git reads are performed here with `execFileSync` rather than through
 * `src/git.ts`, because no exported function there answers "commits, changed
 * files and diff stats between two arbitrary tree-ish refs":
 * `logCommitsWithStat` is hard-wired to `<base>..HEAD` in one worktree,
 * `listChangedFiles` unions worktree and index state into a bare path list,
 * and `diffTreePaths` returns names with no commits and no stats — and
 * `src/git.ts` is outside this slice's file scope. The same decision
 * `src/gate-runner.ts` and `src/migration-gate.ts` already took for their own
 * reads.
 *
 * The summary is generated from git and never from an agent, and it carries
 * no timestamp or run identity: for a given `(cwd, fromRef, toRef)` the bytes
 * are the same every time, so an evaluator reading it twice reads the same
 * facts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One commit reachable from `toRef` but not from `fromRef`. */
export interface ChangeSummaryCommit {
  sha: string;
  subject: string;
}

/** One path that differs between the two refs, with its diff stats. */
export interface ChangeSummaryFile {
  path: string;
  /** Porcelain status letter (`A`, `M`, `D`, `R`, …) for the path. */
  status: string;
  /** `null` for a binary file, which git reports as `-`. */
  insertions: number | null;
  deletions: number | null;
}

export interface ChangeSummary {
  version: 1;
  fromRef: string;
  toRef: string;
  /**
   * Empty when either ref is a bare tree object rather than a commit-ish:
   * a tree has no history, so there is nothing to list. The files and
   * stats below are still exact — `git diff` compares trees.
   */
  commits: ChangeSummaryCommit[];
  files: ChangeSummaryFile[];
  totals: {
    files: number;
    insertions: number;
    deletions: number;
    /** Files git reported as binary, whose line counts are `null`. */
    binaryFiles: number;
  };
}


/** Hex width of a full object ID, the prefix `%H` always occupies. */
const SHA_HEX_LENGTH = 40;

function readGit(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    // Paths verbatim, never git's C-quoted escaping — the reason
    // `src/git.ts:1299-1305` records: a quoted non-ASCII path is a path no
    // reader of this summary can match against the locked file list.
    ["-c", "core.quotePath=false", ...args],
    {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  ) as string;
}

function lines(out: string): string[] {
  return out.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function isCommitish(cwd: string, ref: string): boolean {
  try {
    readGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readCommits(
  cwd: string,
  fromRef: string,
  toRef: string,
): ChangeSummaryCommit[] {
  if (!isCommitish(cwd, fromRef) || !isCommitish(cwd, toRef)) return [];
  const out = readGit(cwd, [
    "log",
    "--format=%H %s",
    `${fromRef}..${toRef}`,
  ]);
  // Split at the fixed hash width rather than on the first space: a subject
  // may contain spaces, and `%s` never contains a newline.
  return lines(out).map((line) => ({
    sha: line.slice(0, SHA_HEX_LENGTH),
    subject: line.slice(SHA_HEX_LENGTH + 1),
  }));
}

function parseCount(value: string): number | null {
  return value === "-" ? null : Number(value);
}

/**
 * Changed paths between two tree-ish refs, with per-path stats.
 *
 * Two reads rather than one: `--numstat` carries the line counts and
 * `--name-status` the status letter, and a reader of this summary needs both
 * to tell a deleted file from an emptied one.
 */
function readFiles(
  cwd: string,
  fromRef: string,
  toRef: string,
): ChangeSummaryFile[] {
  const statusByPath = new Map<string, string>();
  for (const line of lines(
    readGit(cwd, [
      "diff",
      "--name-status",
      "-M",
      fromRef,
      toRef,
    ]),
  )) {
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    // A rename reports `R<score>\told\tnew`; the new path is what changed.
    const path = fields[fields.length - 1] ?? "";
    if (path !== "") statusByPath.set(path, status);
  }

  const files: ChangeSummaryFile[] = [];
  for (const line of lines(
    readGit(cwd, [
      "diff",
      "--numstat",
      "-M",
      fromRef,
      toRef,
    ]),
  )) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const path = fields[fields.length - 1]!;
    files.push({
      path,
      status: statusByPath.get(path) ?? "M",
      insertions: parseCount(fields[0]!),
      deletions: parseCount(fields[1]!),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The one builder. `cwd` is any directory inside the repository holding both
 * refs; `fromRef` and `toRef` are tree-ish (a branch, a commit, or a bare
 * tree object).
 */
export function buildChangeSummary(
  cwd: string,
  fromRef: string,
  toRef: string,
): ChangeSummary {
  const files = readFiles(cwd, fromRef, toRef);
  return {
    version: 1,
    fromRef,
    toRef,
    commits: readCommits(cwd, fromRef, toRef),
    files,
    totals: {
      files: files.length,
      insertions: files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      binaryFiles: files.filter((file) => file.insertions === null).length,
    },
  };
}

/** Canonical filename, in the slice's artifact directory. */
export const CHANGE_SUMMARY_FILENAME = "change-summary.json";

export interface CandidateChangeSummaryInput {
  /** Any directory inside the repository holding both refs. */
  cwd: string;
  /** `.afk/artifacts/<run-slug>/slice-<n>/`. */
  artifactDir: string;
  /** The feature branch this slice was cut from. */
  featureBaseRef: string;
  /**
   * The candidate checkpoint. The orchestrator passes the checkpoint
   * *commit*, whose tree is the candidate tree the gates graded, so the
   * commit list is populated; a bare tree ID is still accepted and yields
   * the same files and stats with no commits.
   */
  candidateRef: string;
}

/**
 * The candidate variant: feature base → candidate checkpoint, written to
 * `change-summary.json` in the slice's artifact directory. Slice 04's
 * baseline → final variant binds the same builder's two refs differently.
 */
export function writeCandidateChangeSummary(
  input: CandidateChangeSummaryInput,
): { path: string; summary: ChangeSummary } {
  const summary = buildChangeSummary(
    input.cwd,
    input.featureBaseRef,
    input.candidateRef,
  );
  mkdirSync(input.artifactDir, { recursive: true });
  const path = join(input.artifactDir, CHANGE_SUMMARY_FILENAME);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  return { path, summary };
}
