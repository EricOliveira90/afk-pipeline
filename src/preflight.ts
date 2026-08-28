import { existsSync, readdirSync, rmdirSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as git from "./git.js";
import { listProcessPaths, type ProcessPathRow } from "./kill-tree.js";

/**
 * The launch preflight: look at the machine before the run dispatches
 * anything, and refuse rather than discover the problem four hours in.
 * Detection, report, and fail-fast — nothing here kills a process or
 * touches a file that holds bytes. See ADR 0041.
 *
 * The three conditions come from three separate run post-mortems:
 *
 * - **Free disk.** Run 6 filled the machine mid-QA and died on an
 *   unhandled WriteStream `error`, leaving no cancellation record and a
 *   two-runs-stale failure reason in run state (#121). The floor is
 *   configurable and checked once, at launch: a run that starts with 200
 *   KB free was never going to finish.
 * - **Leftover worktrees.** A registered worktree inside this run's
 *   namespace that this run will not use is debris from a previous one.
 *   It is not harmless: `createWorktree`'s ADR 0010 assertion refuses a
 *   stale path mid-run, one slice at a time, hours after the operator
 *   walked away. Refusing at launch converts that into a refusal the
 *   operator is present for.
 * - **Holders.** Run 3's two hard kills each left a `codex.exe`
 *   descendant holding a slice worktree, which blocked the worktree
 *   refresh on *every* subsequent run until the machine restarted. The
 *   report names PIDs; the operator kills by hand.
 *
 * **No auto-kill, deliberately.** Both debated forms were cut, and the
 * arguments that killed them are recorded in ADR 0041 and in
 * `docs/specs/afk-v2-plan-debate.md` §2: a scan-based kill's cwd guard
 * both under- and over-matches, and a record-based kill cannot fire for
 * the crash classes that actually produce leaks (`TerminationReport.survivors`
 * is written only by the orderly-teardown path) while being the first
 * code path to break ADR 0020's "only snapshot/BFS members are ever
 * force-killed" guarantee. The receiver of this report is the operator
 * who just typed the launch command. Re-opening that decision goes
 * through the debate doc's trigger, not through this file.
 *
 * **What the holder scan cannot see.** It reads each process's
 * executable path and command line, which is everything a process table
 * will give us on Windows without native interop — `Win32_Process` does
 * not expose a working directory, and `openfiles`/`handle.exe` are
 * either off by default or absent. So a process holding a namespace
 * directory *only* as its cwd, with no namespace path in its argv, is
 * invisible to the scan: exactly the run-3 `codex.exe __otel-server`
 * shape. The report says so rather than implying a clean scan means a
 * clean machine. That gap is why the worktree checks are the fail-fast
 * half and the holder scan is the report half.
 *
 * **Failure posture** matches the busy probe and worktree quiescing:
 * anything the preflight cannot observe is reported as unobserved, never
 * asserted as clean and never converted into a refusal. A check that
 * refuses on its own blindness would train operators to pass
 * `--preflight-report-only` permanently.
 */

/** Free space a launch requires by default, in GB. */
export const DEFAULT_MIN_FREE_DISK_GB = 5;

const GIB = 1024 ** 3;

/** Guards against a junction loop turning the shell sweep into a walk. */
const MAX_SWEEP_DEPTH = 64;

export type PreflightCheck =
  | "disk-floor"
  | "leftover-worktree"
  | "stale-directory"
  | "namespace-holders";

export interface PreflightFinding {
  check: PreflightCheck;
  /**
   * `refuse` stops the launch (unless the operator asked for
   * report-only); `report` is information for the operator and nothing
   * more.
   */
  severity: "refuse" | "report";
  /** One operator-facing line, remedy included. */
  message: string;
  /** PIDs named by the holder scan. Absent for every other check. */
  pids?: number[];
}

export interface PreflightReport {
  findings: PreflightFinding[];
  /** Empty directory shells removed from the run's own namespace. */
  sweptShells: string[];
  /** Free bytes on the repo's volume; undefined when unmeasurable. */
  freeBytes?: number;
  /** The floor applied, in bytes. 0 means the disk check was disabled. */
  minFreeBytes: number;
  /**
   * What these checks structurally could not see this time — a stated
   * coverage limit, so a finding-free report is not read as a clean
   * machine.
   */
  caveats: string[];
  /** True when the launch must be refused. */
  refuse: boolean;
}

/**
 * The filesystem region a run owns, described so the preflight never has
 * to re-derive AFK's directory naming (the orchestrator owns that) and
 * never reasons about a path outside it.
 */
export interface RunNamespace {
  /**
   * Directories whose matching children belong to this run:
   * `.afk/worktrees` (slice worktrees and the review worktree) and
   * `.afk` (scratch merge worktrees).
   */
  roots: ReadonlyArray<{ dir: string; owns: (name: string) => boolean }>;
  /**
   * Paths this run will create or resume, with the branch each must hold
   * when it already exists.
   */
  intended: ReadonlyArray<{ path: string; branch: string }>;
  /**
   * Paths that hold live slice work, whether or not *this* invocation
   * touches them — a superset of `intended`.
   *
   * A narrowed re-run (`--slices 02`) legitimately leaves the worktree of
   * a MERGE-PENDING or STUCK slice registered: ADR 0029's merge-only
   * recovery and `--resume-stuck` both need that tree on a later run. So
   * "leftover from a previous run" cannot mean "not in this invocation's
   * scope"; it means no live slice of this PRD owns the path. Each entry
   * lists one acceptable branch for its path — a path may appear twice
   * when the recorded branch and the derived one differ.
   */
  retained: ReadonlyArray<{ path: string; branch: string }>;
}

export interface PreflightRequest {
  repoRoot: string;
  namespace: RunNamespace;
  /** Bytes of free space the launch requires. 0 disables the check. */
  minFreeBytes: number;
  /** Run every check, report everything, refuse nothing. */
  reportOnly?: boolean;
}

/** Directory entry, with links deliberately distinguished from directories. */
export interface PreflightDirEntry {
  name: string;
  /** True only for a real directory — a junction or symlink is not one. */
  isDirectory: boolean;
}

/** The filesystem surface the preflight needs, injectable for tests. */
export interface PreflightFs {
  /** Entries of `dir`, or undefined when it is not a readable directory. */
  readDir(dir: string): PreflightDirEntry[] | undefined;
  exists(path: string): boolean;
  /** Remove one empty directory. Throws like `rmdirSync`. */
  removeEmptyDir(dir: string): void;
}

export interface PreflightDeps {
  listWorktrees?: (
    repoRoot: string,
  ) => Array<{ path: string; branch: string | null }>;
  /** Free bytes on the volume holding `path`; undefined when unmeasurable. */
  freeBytes?: (path: string) => number | undefined;
  listProcesses?: () => Promise<ProcessPathRow[] | undefined>;
  fs?: PreflightFs;
  /** This process, excluded from the holder scan. */
  selfPid?: number;
}

/** `statfsSync`-backed free-space reader. Never throws. */
export function readFreeBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

const nodeFs: PreflightFs = {
  readDir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        // A junction or symlink is not a directory for our purposes: the
        // sweep must not walk through one, and must not delete one.
        isDirectory: entry.isDirectory() && !entry.isSymbolicLink(),
      }));
    } catch {
      return undefined;
    }
  },
  exists(path) {
    return existsSync(path);
  },
  removeEmptyDir(dir) {
    rmdirSync(dir);
  },
};

/**
 * Run the launch preflight. Never throws: an unobservable check becomes a
 * caveat, and a refusal is returned as `refuse` for the caller to act on
 * (the orchestrator logs the report and throws), so a preflight bug can
 * never be the reason a run does not start.
 */
export async function runLaunchPreflight(
  request: PreflightRequest,
  deps: PreflightDeps = {},
): Promise<PreflightReport> {
  const fs = deps.fs ?? nodeFs;
  const listWorktrees = deps.listWorktrees ?? git.listWorktrees;
  const freeBytes = deps.freeBytes ?? readFreeBytes;
  const listProcesses = deps.listProcesses ?? (() => listProcessPaths());
  const selfPid = deps.selfPid ?? process.pid;

  const findings: PreflightFinding[] = [];
  const caveats: string[] = [];

  // --- Registered worktrees, read once. Every path decision below needs
  // them, and an unreadable listing must not be mistaken for "none".
  let registered: Array<{ path: string; branch: string | null }> | undefined;
  try {
    registered = listWorktrees(request.repoRoot);
  } catch (err) {
    caveats.push(
      `registered worktrees could not be listed (${errText(err)}) — the ` +
        `leftover-worktree check did not run`,
    );
  }
  const registeredInNamespace = (registered ?? []).filter((wt) =>
    ownedByNamespace(wt.path, request.namespace),
  );
  const registeredPaths = new Set(
    (registered ?? []).map((wt) => normalise(wt.path)),
  );

  // --- 1. Sweep the empty directory shells first, so a namespace path
  // that is nothing but teardown residue is gone before the checks below
  // decide whether to refuse over it. Windows teardown leaves these when
  // `rmSync` clears the files and loses the race on the directories
  // (`Directory not empty`); run 6's post-mortem measured 467 of them at
  // 0.02 GB total, so this is hygiene, not a space reclaim.
  const sweep = sweepEmptyShells(request.namespace, fs, registeredPaths);
  for (const failure of sweep.failures) {
    findings.push({
      check: "stale-directory",
      severity: "report",
      message:
        `could not sweep the empty directory shell ${failure.dir} ` +
        `(${failure.reason}) — harmless, but it will still be there next launch`,
    });
  }

  // --- 2. Free disk.
  const free = freeBytes(request.repoRoot);
  if (free === undefined) {
    caveats.push(
      "free disk space could not be measured — the disk floor did not run",
    );
  } else if (request.minFreeBytes > 0 && free < request.minFreeBytes) {
    findings.push({
      check: "disk-floor",
      severity: "refuse",
      message:
        `only ${formatGb(free)} free on the volume holding ${request.repoRoot}, ` +
        `below the ${formatGb(request.minFreeBytes)} floor — free space, or ` +
        `lower the floor with --min-free-disk-gb`,
    });
  }

  // --- 3. Leftover registered worktrees, and stale directories on the
  // paths this run needs.
  const retainedAt = (path: string) =>
    request.namespace.retained.filter(
      (entry) => normalise(entry.path) === normalise(path),
    );
  for (const wt of registeredInNamespace) {
    const retained = retainedAt(wt.path);
    if (retained.length === 0) {
      findings.push({
        check: "leftover-worktree",
        severity: "refuse",
        message:
          `${wt.path} is a registered worktree in this run's namespace that ` +
          `no live slice of this PRD owns (branch ${wt.branch ?? "detached"}) — ` +
          `leftover from a previous run; clear it with ` +
          `\`afk clean-failed --prd-dir <prd-dir>\``,
      });
    } else if (!retained.some((entry) => entry.branch === wt.branch)) {
      findings.push({
        check: "leftover-worktree",
        severity: "refuse",
        message:
          `${wt.path} is registered for branch ${wt.branch ?? "detached"}, but ` +
          `that path belongs to ${retained.map((entry) => entry.branch).join(" / ")} — ` +
          `remove the worktree (\`git worktree remove\`) and re-run`,
      });
    }
    // Registered for a branch that path legitimately holds is the resume
    // or merge-recovery input, not a leftover: prepareSliceWorktree
    // announces the resume on dispatch.
  }

  for (const entry of request.namespace.intended) {
    if (registeredPaths.has(normalise(entry.path))) continue;
    if (!fs.exists(entry.path)) continue;
    findings.push({
      check: "stale-directory",
      severity: "refuse",
      message:
        `${entry.path} exists on disk but is not a registered worktree, and ` +
        `this run needs that path for ${entry.branch} — \`createWorktree\` ` +
        `would refuse it mid-run (ADR 0010); delete the directory and re-run`,
    });
  }

  // Namespace directories left over the paths above: already refused
  // (intended) or accounted for (registered). Anything else gets a line,
  // and a retained path gets a different one — it holds a live slice's
  // preserved tree that git no longer knows about, which is worth reading
  // before it is deleted.
  const handled = new Set([
    ...request.namespace.intended.map((entry) => normalise(entry.path)),
    ...registeredPaths,
  ]);
  const onDisk = namespaceDirsOnDisk(request.namespace, fs);
  for (const dir of onDisk) {
    if (handled.has(normalise(dir))) continue;
    findings.push({
      check: "stale-directory",
      severity: "report",
      message:
        retainedAt(dir).length > 0
          ? `${dir} holds the preserved tree of a slice this run is not ` +
            `dispatching, but git no longer has it registered — the next run ` +
            `that needs the path will refuse it (ADR 0010); read anything you ` +
            `want out of it, then \`afk clean-failed --prd-dir <prd-dir>\``
          : `${dir} is an unregistered directory in this run's namespace that ` +
            `this run will not use — previous-run residue, removable with ` +
            `\`afk clean-failed --prd-dir <prd-dir>\``,
    });
  }

  // --- 4. Holders: name the PIDs, kill nothing.
  const namespacePaths = [
    ...new Set([
      ...request.namespace.intended.map((entry) => entry.path),
      ...registeredInNamespace.map((wt) => wt.path),
      ...onDisk,
    ]),
  ];
  const rows = await listProcesses();
  if (rows === undefined) {
    caveats.push(
      "the process table could not be listed — no holder scan ran, so live " +
        "processes inside the namespace are unknown",
    );
  } else if (namespacePaths.length > 0) {
    const holders = findHolders(rows, namespacePaths, selfPid);
    if (holders.length > 0) {
      findings.push({
        check: "namespace-holders",
        severity: "report",
        pids: holders.map((holder) => holder.pid),
        message:
          `${holders.length} live process(es) reference paths in this run's ` +
          `namespace — terminate them by hand if a worktree refresh fails ` +
          `(taskkill /PID <pid> /T /F):\n` +
          holders
            .map(
              (holder) =>
                `      PID ${holder.pid} ${holder.name} → ${holder.matched}`,
            )
            .join("\n"),
      });
    }
    caveats.push(
      "the holder scan reads executable paths and command lines only; a " +
        "process holding a namespace directory as its working directory with " +
        "no namespace path in its argv is invisible to it (the run-3 " +
        "`codex.exe __otel-server` shape). If a worktree refresh still fails, " +
        "see ADR 0035 and restart the machine to clear the handle.",
    );
  }

  const refuse =
    request.reportOnly !== true &&
    findings.some((finding) => finding.severity === "refuse");

  return {
    findings,
    sweptShells: sweep.swept,
    freeBytes: free,
    minFreeBytes: request.minFreeBytes,
    caveats,
    refuse,
  };
}

export interface NamespaceHolder {
  pid: number;
  name: string;
  /** The namespace path the process's argv or executable path referenced. */
  matched: string;
}

/**
 * Processes whose executable path or command line names a path inside the
 * namespace. Exported for unit testing against fabricated process tables
 * — the same shape `listProcessPaths` returns.
 *
 * Path comparison is separator- and case-insensitive: a command line may
 * spell a Windows path with either slash, and Windows paths are
 * case-insensitive. Matching a directory prefix is deliberate — a process
 * holding `…/s01/node_modules/.bin/vitest` holds `…/s01`.
 */
export function findHolders(
  rows: readonly ProcessPathRow[],
  namespacePaths: readonly string[],
  selfPid: number,
): NamespaceHolder[] {
  const needles = namespacePaths.map((path) => ({
    display: path,
    needle: matchable(path),
  }));
  const holders: NamespaceHolder[] = [];
  for (const row of rows) {
    if (row.pid === selfPid) continue;
    const haystack = matchable(
      `${row.executablePath ?? ""}\n${row.commandLine ?? ""}`,
    );
    const hit = needles.find(({ needle }) => haystack.includes(needle));
    if (hit) {
      holders.push({ pid: row.pid, name: row.name, matched: hit.display });
    }
  }
  return holders;
}

/**
 * Remove namespace directories that contain no files at all — only
 * further empty directories. Registered worktrees are never candidates,
 * and a tree holding a single file, junction or symlink is left entirely
 * alone: the sweep exists to clear teardown's directory shells, not to
 * delete anything that holds bytes or points elsewhere.
 */
function sweepEmptyShells(
  namespace: RunNamespace,
  fs: PreflightFs,
  registeredPaths: ReadonlySet<string>,
): { swept: string[]; failures: Array<{ dir: string; reason: string }> } {
  const swept: string[] = [];
  const failures: Array<{ dir: string; reason: string }> = [];
  for (const dir of namespaceDirsOnDisk(namespace, fs)) {
    if (registeredPaths.has(normalise(dir))) continue;
    if (!isFileFreeTree(dir, fs, 0)) continue;
    try {
      removeEmptyTree(dir, fs);
      swept.push(dir);
    } catch (err) {
      failures.push({ dir, reason: errText(err) });
    }
  }
  return { swept, failures };
}

/** Namespace children that exist on disk right now. */
function namespaceDirsOnDisk(
  namespace: RunNamespace,
  fs: PreflightFs,
): string[] {
  const dirs: string[] = [];
  for (const root of namespace.roots) {
    for (const entry of fs.readDir(root.dir) ?? []) {
      if (!entry.isDirectory) continue;
      if (!root.owns(entry.name)) continue;
      dirs.push(join(root.dir, entry.name));
    }
  }
  return dirs;
}

/**
 * True when `dir` is a readable directory whose whole tree holds no
 * files. Non-directories are checked before recursing at every level, so
 * a real worktree exits on its own `package.json` instead of walking all
 * of `node_modules` to find out it is not a shell.
 */
function isFileFreeTree(dir: string, fs: PreflightFs, depth: number): boolean {
  if (depth > MAX_SWEEP_DEPTH) return false;
  const entries = fs.readDir(dir);
  if (entries === undefined) return false;
  if (entries.some((entry) => !entry.isDirectory)) return false;
  return entries.every((entry) =>
    isFileFreeTree(join(dir, entry.name), fs, depth + 1),
  );
}

/** Depth-first `rmdir`. Only ever called on a verified file-free tree. */
function removeEmptyTree(dir: string, fs: PreflightFs): void {
  for (const entry of fs.readDir(dir) ?? []) {
    if (entry.isDirectory) removeEmptyTree(join(dir, entry.name), fs);
  }
  fs.removeEmptyDir(dir);
}

/**
 * True when `path` is a child of one of the namespace roots whose name
 * that root claims. `owns` is handed the child segment in its original
 * case — the caller's pattern decides how to compare.
 */
function ownedByNamespace(path: string, namespace: RunNamespace): boolean {
  const abs = resolve(path);
  for (const root of namespace.roots) {
    const rootAbs = resolve(root.dir);
    if (!normalise(abs).startsWith(normalise(rootAbs) + "/")) continue;
    const name = abs.slice(rootAbs.length + 1).split(/[\\/]/)[0] ?? "";
    if (root.owns(name)) return true;
  }
  return false;
}

/** Platform-appropriate path key: absolute, forward slashes, folded case. */
function normalise(path: string): string {
  const abs = resolve(path).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Comparison form for substring matching inside a command line. */
function matchable(text: string): string {
  const slashed = text.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Free space as an operator reads it. Sub-10-MB readings — run 6 died at
 * 200 KB — round to `0.00 GB` and lose the whole point, so they are
 * reported in MB.
 */
export function formatGb(bytes: number): string {
  const gb = bytes / GIB;
  if (gb < 0.01) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(2)} GB`;
}

/** GB (as typed on the CLI) to bytes. */
export function gbToBytes(gb: number): number {
  return Math.round(gb * GIB);
}

/**
 * The operator-facing block, or undefined when the preflight found
 * nothing worth a line. Caveats are printed only alongside findings: a
 * clean launch does not need a paragraph about what the scan cannot see,
 * but a report the operator is about to act on does.
 */
export function formatPreflightReport(
  report: PreflightReport,
): string | undefined {
  const lines: string[] = [];
  if (report.sweptShells.length > 0) {
    lines.push(
      `  swept ${report.sweptShells.length} empty directory shell(s) from the run namespace`,
    );
  }
  for (const finding of report.findings) {
    const mark = finding.severity === "refuse" ? "REFUSE" : "report";
    lines.push(`  [${mark}] ${finding.message}`);
  }
  if (lines.length === 0) return undefined;
  for (const caveat of report.caveats) lines.push(`  note: ${caveat}`);
  return `[afk] Launch preflight:\n${lines.join("\n")}`;
}

/** The refusal message, listing only the conditions that refuse. */
export function formatPreflightRefusal(report: PreflightReport): string {
  const refusals = report.findings.filter(
    (finding) => finding.severity === "refuse",
  );
  return (
    `Refusing to launch: ${refusals.length} preflight condition(s) would ` +
    `have failed this run mid-flight:\n` +
    refusals.map((finding) => `  - ${finding.message}`).join("\n") +
    `\nClear them and re-run, or pass --preflight-report-only to launch anyway.`
  );
}
