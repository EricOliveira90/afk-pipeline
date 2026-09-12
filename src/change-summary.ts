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

/** Canonical filename for the baseline → final variant (#96 B-04). */
export const FINAL_CHANGE_SUMMARY_FILENAME = "final-change-summary.json";

/**
 * One post-approval writing stage's slice of the baseline → final range.
 *
 * The boundaries are checkpoint refs, not stage outputs described in prose:
 * the final evaluator's first question is which stage wrote a given byte, and
 * only a per-stage ref pair can answer it.
 */
export interface PostApprovalStageBoundary {
  /** The stage's id — the same constant the orchestrator dispatched it under. */
  stageId: string;
  fromRef: string;
  toRef: string;
}

/**
 * The baseline → final summary: the same two-ref facts as the candidate
 * variant, plus a per-stage attribution of the range.
 *
 * `byStage` is keyed by exactly the stage ids that ran, in dispatch order. With
 * only PRD 4's no-op stub that is a single key, and its entry's `files` and
 * diff stats are therefore literally the summary's own — the stub tiles the
 * whole range by itself.
 */
export interface FinalChangeSummary extends ChangeSummary {
  byStage: Record<string, ChangeSummary>;
  /** Stage ids in the order they ran, since object key order is not a contract. */
  stageOrder: string[];
}

export interface FinalChangeSummaryInput {
  /** Any directory inside the repository holding every ref below. */
  cwd: string;
  /** The approved baseline's tree (or its checkpoint commit). */
  baselineRef: string;
  /** The final checkpoint, after every post-approval writing stage has run. */
  finalRef: string;
  /**
   * The stages that ran, in order. Their boundaries must tile
   * `baselineRef → finalRef` exactly: the first begins at the baseline, the
   * last ends at the final checkpoint, and each stage begins where the
   * previous one ended. A gap would be a byte no stage is accountable for,
   * which is the one thing this variant exists to make impossible.
   */
  stages: readonly PostApprovalStageBoundary[];
}

/**
 * Build the baseline → final variant. Every read goes through
 * {@link buildChangeSummary} — once for the whole range and once per stage —
 * so there is still exactly one producer of change-summary facts (PRD D11).
 */
export function buildFinalChangeSummary(
  input: FinalChangeSummaryInput,
): FinalChangeSummary {
  if (input.stages.length === 0) {
    throw new Error(
      "final change summary requires at least one post-approval writing stage; " +
        "an empty stage list attributes the range to nobody",
    );
  }
  const seen = new Set<string>();
  for (const stage of input.stages) {
    if (stage.stageId.trim() === "") {
      throw new Error("final change summary stage ids must be non-blank");
    }
    if (seen.has(stage.stageId)) {
      throw new Error(
        `final change summary stage id "${stage.stageId}" appears twice; ` +
          "byStage would lose one of them",
      );
    }
    seen.add(stage.stageId);
  }
  const first = input.stages[0]!;
  const last = input.stages[input.stages.length - 1]!;
  if (first.fromRef !== input.baselineRef) {
    throw new Error(
      `final change summary stage "${first.stageId}" begins at ` +
        `${first.fromRef}, not at the approved baseline ${input.baselineRef}`,
    );
  }
  if (last.toRef !== input.finalRef) {
    throw new Error(
      `final change summary stage "${last.stageId}" ends at ${last.toRef}, ` +
        `not at the final checkpoint ${input.finalRef}`,
    );
  }
  for (let index = 1; index < input.stages.length; index += 1) {
    const previous = input.stages[index - 1]!;
    const stage = input.stages[index]!;
    if (stage.fromRef !== previous.toRef) {
      throw new Error(
        `final change summary stage "${stage.stageId}" begins at ` +
          `${stage.fromRef}, but "${previous.stageId}" ended at ` +
          `${previous.toRef}; the stages must tile the range`,
      );
    }
  }

  const summary = buildChangeSummary(
    input.cwd,
    input.baselineRef,
    input.finalRef,
  );
  const byStage: Record<string, ChangeSummary> = {};
  for (const stage of input.stages) {
    byStage[stage.stageId] = buildChangeSummary(
      input.cwd,
      stage.fromRef,
      stage.toRef,
    );
  }
  return {
    ...summary,
    byStage,
    stageOrder: input.stages.map((stage) => stage.stageId),
  };
}

/**
 * Write the baseline → final variant into the slice's artifact directory. The
 * candidate variant's file is untouched: the two summaries answer different
 * questions and a reader must be able to hold both (PRD D11).
 */
export function writeFinalChangeSummary(
  input: FinalChangeSummaryInput & { artifactDir: string },
): { path: string; summary: FinalChangeSummary } {
  const summary = buildFinalChangeSummary(input);
  mkdirSync(input.artifactDir, { recursive: true });
  const path = join(input.artifactDir, FINAL_CHANGE_SUMMARY_FILENAME);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  return { path, summary };
}
