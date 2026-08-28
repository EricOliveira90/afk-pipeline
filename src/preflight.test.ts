import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MIN_FREE_DISK_GB,
  findHolders,
  formatGb,
  formatPreflightRefusal,
  formatPreflightReport,
  gbToBytes,
  runLaunchPreflight,
  type PreflightDirEntry,
  type PreflightFs,
  type PreflightReport,
  type RunNamespace,
} from "./preflight.js";
import { buildRunNamespace, reviewWorktreeDir } from "./orchestrator.js";
import { codexProvider } from "./codex.js";
import { kiroProvider } from "./kiro.js";
import type { ProcessPathRow } from "./kill-tree.js";

/**
 * ADR 0042: the launch preflight detects, reports, and refuses — it never
 * kills a process and never deletes anything holding bytes. Every check
 * runs here against fabricated inputs: an injected worktree listing, an
 * injected free-space reading, an injected process table, and a fake
 * filesystem. No git, no spawn, no real directories — per AGENTS.md's
 * assertion-placement rule, a launch guard is exactly the pure-decision
 * shape that belongs in a unit test.
 */

const REPO = join(tmpdir(), "afk-preflight-fixture");
const WORKTREES = join(REPO, ".afk", "worktrees");
const AFK = join(REPO, ".afk");

const S01 = join(WORKTREES, "afk-codex-demo-s01");
const S02 = join(WORKTREES, "afk-codex-demo-s02");
const SCRATCH01 = join(AFK, "merge-afk-codex-demo-s01");
const BRANCH01 = "afk-codex/demo-slice-01-thing";
const BRANCH02 = "afk-codex/demo-slice-02-other";

type NodeKind = "dir" | "file" | "link";

/** Path key matching the module's own: absolute, `/`, folded on Windows. */
function key(path: string): string {
  const abs = resolve(path).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * A filesystem described by the paths that exist in it. Parents are
 * implied as directories, so a spec names only the interesting leaves.
 * `failOn` makes `removeEmptyDir` throw for one path, which a real
 * antivirus lock does and a fixture cannot.
 */
function makeFs(
  spec: Record<string, NodeKind>,
  failOn: string[] = [],
): PreflightFs & { removed: string[] } {
  const nodes = new Map<string, { path: string; kind: NodeKind }>();
  for (const [path, kind] of Object.entries(spec)) {
    nodes.set(key(path), { path, kind });
    let parent = dirname(path);
    while (!nodes.has(key(parent)) && parent !== dirname(parent)) {
      nodes.set(key(parent), { path: parent, kind: "dir" });
      parent = dirname(parent);
    }
  }
  const failing = new Set(failOn.map(key));
  const removed: string[] = [];

  const childrenOf = (dir: string) =>
    [...nodes.values()].filter(
      (node) =>
        key(node.path) !== key(dir) && key(dirname(node.path)) === key(dir),
    );

  return {
    removed,
    readDir(dir: string): PreflightDirEntry[] | undefined {
      if (nodes.get(key(dir))?.kind !== "dir") return undefined;
      return childrenOf(dir).map((node) => ({
        name: node.path.slice(dir.length + 1),
        isDirectory: node.kind === "dir",
      }));
    },
    exists(path: string) {
      return nodes.has(key(path));
    },
    removeEmptyDir(dir: string) {
      if (failing.has(key(dir))) throw new Error("EBUSY: resource busy");
      if (childrenOf(dir).length > 0) throw new Error("ENOTEMPTY");
      nodes.delete(key(dir));
      removed.push(dir);
    },
  };
}

/** The namespace a `--slices 01` run of PRD `demo` on codex would use. */
function namespace(
  intended: Array<{ path: string; branch: string }> = [
    { path: S01, branch: BRANCH01 },
  ],
  retained?: Array<{ path: string; branch: string }>,
): RunNamespace {
  return buildRunNamespace({
    repoRoot: REPO,
    prdSlug: "demo",
    provider: codexProvider,
    featBranch: "feat-codex/demo",
    intended,
    retained,
  });
}

const PLENTY_OF_DISK = gbToBytes(50);

/** Defaults every check to "nothing to see", so a case sets only its own. */
function preflight(
  overrides: {
    intended?: Array<{ path: string; branch: string }>;
    retained?: Array<{ path: string; branch: string }>;
    worktrees?: Array<{ path: string; branch: string | null }>;
    listWorktrees?: () => never;
    freeBytes?: number | undefined;
    minFreeBytes?: number;
    processes?: ProcessPathRow[] | undefined;
    fs?: PreflightFs;
    reportOnly?: boolean;
  } = {},
): Promise<PreflightReport> {
  return runLaunchPreflight(
    {
      repoRoot: REPO,
      namespace: namespace(overrides.intended, overrides.retained),
      minFreeBytes: overrides.minFreeBytes ?? gbToBytes(5),
      reportOnly: overrides.reportOnly,
    },
    {
      listWorktrees: overrides.listWorktrees ?? (() => overrides.worktrees ?? []),
      freeBytes: () =>
        "freeBytes" in overrides ? overrides.freeBytes : PLENTY_OF_DISK,
      listProcesses: async () =>
        "processes" in overrides ? overrides.processes : [],
      fs: overrides.fs ?? makeFs({}),
      selfPid: 1000,
    },
  );
}

const refusals = (report: PreflightReport) =>
  report.findings.filter((finding) => finding.severity === "refuse");
const reports = (report: PreflightReport) =>
  report.findings.filter((finding) => finding.severity === "report");
const checks = (report: PreflightReport) =>
  report.findings.map((finding) => finding.check);

describe("preflight — a clean machine", () => {
  it("finds nothing, refuses nothing, and prints nothing", async () => {
    const report = await preflight();
    expect(report.findings).toEqual([]);
    expect(report.sweptShells).toEqual([]);
    expect(report.refuse).toBe(false);
    expect(formatPreflightReport(report)).toBeUndefined();
  });
});

describe("preflight — free disk floor", () => {
  it("refuses a launch below the floor and names the flag", async () => {
    const report = await preflight({ freeBytes: gbToBytes(0.19) });
    expect(refusals(report)).toHaveLength(1);
    expect(report.refuse).toBe(true);
    expect(refusals(report)[0]!.check).toBe("disk-floor");
    expect(refusals(report)[0]!.message).toContain("0.19 GB");
    expect(refusals(report)[0]!.message).toContain("5 GB floor");
    expect(refusals(report)[0]!.message).toContain("--min-free-disk-gb");
  });

  it("reports run 6's 200 KB in MB rather than as 0.00 GB", async () => {
    const report = await preflight({ freeBytes: 200 * 1024 });
    expect(refusals(report)[0]!.message).toContain("0.2 MB");
  });

  it("passes exactly at the floor", async () => {
    const report = await preflight({
      freeBytes: gbToBytes(5),
      minFreeBytes: gbToBytes(5),
    });
    expect(report.findings).toEqual([]);
  });

  it("treats a floor of zero as the check being switched off", async () => {
    const report = await preflight({ freeBytes: 1, minFreeBytes: 0 });
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
  });

  it("caveats an unmeasurable volume instead of refusing on its own blindness", async () => {
    const report = await preflight({ freeBytes: undefined });
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
    expect(report.caveats.join("\n")).toContain("could not be measured");
  });

  it("defaults to a five-gigabyte floor", () => {
    expect(DEFAULT_MIN_FREE_DISK_GB).toBe(5);
    expect(gbToBytes(DEFAULT_MIN_FREE_DISK_GB)).toBe(5 * 1024 ** 3);
  });
});

describe("preflight — leftover registered worktrees", () => {
  it("refuses a registered namespace worktree no live slice owns", async () => {
    const report = await preflight({
      worktrees: [{ path: S02, branch: BRANCH02 }],
    });
    expect(checks(report)).toEqual(["leftover-worktree"]);
    expect(report.refuse).toBe(true);
    expect(refusals(report)[0]!.message).toContain(S02);
    expect(refusals(report)[0]!.message).toContain("afk clean-failed");
  });

  it("keeps the preserved worktree of a slice outside a narrowed re-run", async () => {
    // `--slices 02` while slice 01 is MERGE-PENDING: ADR 0029's
    // merge-only recovery needs slice 01's tree on a later run, so it is
    // live work, not debris. This is the case a scope-only rule refuses
    // and the orchestrator's `retained` set exists to permit.
    const report = await preflight({
      intended: [{ path: S02, branch: BRANCH02 }],
      retained: [
        { path: S02, branch: BRANCH02 },
        { path: S01, branch: BRANCH01 },
      ],
      worktrees: [{ path: S01, branch: BRANCH01 }],
    });
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
  });

  it("accepts either the recorded or the derived branch for a retained path", async () => {
    const report = await preflight({
      intended: [],
      retained: [
        { path: S01, branch: BRANCH01 },
        { path: S01, branch: "afk-codex/demo-slice-01-renamed" },
      ],
      worktrees: [{ path: S01, branch: "afk-codex/demo-slice-01-renamed" }],
    });
    expect(report.findings).toEqual([]);
  });

  it("refuses a namespace path registered for a branch it does not belong to", async () => {
    const report = await preflight({
      worktrees: [{ path: S01, branch: "afk-codex/demo-slice-01-stale" }],
    });
    expect(checks(report)).toEqual(["leftover-worktree"]);
    expect(refusals(report)[0]!.message).toContain(BRANCH01);
    expect(refusals(report)[0]!.message).toContain("git worktree remove");
  });

  it("accepts a worktree already registered for the branch this run resumes", async () => {
    const report = await preflight({
      worktrees: [{ path: S01, branch: BRANCH01 }],
    });
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
  });

  it("ignores registered worktrees outside the namespace", async () => {
    const report = await preflight({
      worktrees: [
        { path: REPO, branch: "main" },
        { path: join(REPO, "..", "some-manual-worktree"), branch: "wip" },
        { path: join(WORKTREES, "afk-kiro-other-prd-s01"), branch: "afk/x" },
      ],
    });
    expect(report.findings).toEqual([]);
  });

  it("claims the scratch merge and review worktrees as leftovers, never as adoptable", async () => {
    const report = await preflight({
      worktrees: [
        { path: SCRATCH01, branch: BRANCH01 },
        { path: reviewWorktreeDir(REPO, "feat-codex/demo"), branch: "feat-codex/demo" },
      ],
    });
    expect(checks(report)).toEqual(["leftover-worktree", "leftover-worktree"]);
    expect(report.refuse).toBe(true);
  });

  it("caveats an unreadable worktree listing instead of reading it as empty", async () => {
    const report = await preflight({
      listWorktrees: () => {
        throw new Error("not a git repository");
      },
    });
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
    expect(report.caveats.join("\n")).toContain("not a git repository");
  });
});

describe("preflight — stale directories", () => {
  it("refuses an unregistered directory on a path this run needs", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S01, "src", "index.ts")]: "file" }),
    });
    expect(checks(report)).toEqual(["stale-directory"]);
    expect(report.refuse).toBe(true);
    expect(refusals(report)[0]!.message).toContain("ADR 0010");
  });

  it("only reports an unregistered directory on a path this run will not use", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S02, "src", "index.ts")]: "file" }),
    });
    expect(checks(report)).toEqual(["stale-directory"]);
    expect(reports(report)).toHaveLength(1);
    expect(reports(report)[0]!.message).toContain("previous-run residue");
    expect(report.refuse).toBe(false);
  });

  it("says an unregistered directory is a live slice's preserved tree when it is one", async () => {
    const report = await preflight({
      retained: [
        { path: S01, branch: BRANCH01 },
        { path: S02, branch: BRANCH02 },
      ],
      fs: makeFs({ [join(S02, "src", "index.ts")]: "file" }),
    });
    expect(reports(report)[0]!.message).toContain("preserved tree");
    expect(reports(report)[0]!.message).toContain("read anything you want out of it");
    expect(report.refuse).toBe(false);
  });
});

describe("preflight — empty-shell sweep", () => {
  it("removes a file-free namespace tree bottom-up", async () => {
    const fs = makeFs({
      [join(S02, "node_modules", ".pnpm", "esbuild")]: "dir",
      [join(S02, "src")]: "dir",
    });
    const report = await preflight({ fs });
    expect(report.sweptShells).toEqual([S02]);
    expect(fs.removed).toEqual([
      join(S02, "node_modules", ".pnpm", "esbuild"),
      join(S02, "node_modules", ".pnpm"),
      join(S02, "node_modules"),
      join(S02, "src"),
      S02,
    ]);
  });

  it("leaves a swept shell out of the stale-directory report", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S02, "node_modules")]: "dir" }),
    });
    expect(report.sweptShells).toEqual([S02]);
    expect(report.findings).toEqual([]);
  });

  it("never sweeps a tree that holds a file", async () => {
    const fs = makeFs({
      [join(S02, "node_modules")]: "dir",
      [join(S02, "src", "keep.ts")]: "file",
    });
    const report = await preflight({ fs });
    expect(report.sweptShells).toEqual([]);
    expect(fs.removed).toEqual([]);
  });

  it("never walks through or deletes a junction", async () => {
    const fs = makeFs({ [join(S02, "node_modules", "linked")]: "link" });
    const report = await preflight({ fs });
    expect(report.sweptShells).toEqual([]);
    expect(fs.removed).toEqual([]);
  });

  it("never sweeps a registered worktree, even an empty one", async () => {
    const fs = makeFs({ [join(S01, "src")]: "dir" });
    const report = await preflight({
      fs,
      worktrees: [{ path: S01, branch: BRANCH01 }],
    });
    expect(report.sweptShells).toEqual([]);
    expect(fs.removed).toEqual([]);
  });

  it("never sweeps outside the namespace", async () => {
    const fs = makeFs({
      [join(WORKTREES, "afk-kiro-other-prd-s01", "src")]: "dir",
      [join(AFK, "logs", "demo")]: "dir",
      [join(AFK, "state")]: "dir",
    });
    const report = await preflight({ fs });
    expect(report.sweptShells).toEqual([]);
    expect(fs.removed).toEqual([]);
  });

  it("reports a sweep it could not finish and still launches", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S02, "node_modules")]: "dir" }, [
        join(S02, "node_modules"),
      ]),
    });
    expect(report.sweptShells).toEqual([]);
    // Two honest lines about one directory: the sweep that failed, then
    // the residue it left behind with the command that clears it.
    expect(checks(report)).toEqual(["stale-directory", "stale-directory"]);
    expect(reports(report)[0]!.message).toContain("EBUSY");
    expect(reports(report)[1]!.message).toContain("afk clean-failed");
    expect(report.refuse).toBe(false);
  });
});

describe("preflight — holder scan", () => {
  const row = (
    pid: number,
    name: string,
    commandLine?: string,
    executablePath?: string,
  ): ProcessPathRow => ({ pid, name, commandLine, executablePath });

  it("names the PIDs referencing a namespace path and refuses nothing", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S01, "src", "a.ts")]: "file" }),
      worktrees: [{ path: S01, branch: BRANCH01 }],
      processes: [
        row(4242, "node.exe", `node ${join(S01, "node_modules", ".bin", "vitest")}`),
        row(77, "chrome.exe", "chrome --profile-directory=Default"),
      ],
    });
    const holders = report.findings.filter(
      (finding) => finding.check === "namespace-holders",
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]!.severity).toBe("report");
    expect(holders[0]!.pids).toEqual([4242]);
    expect(holders[0]!.message).toContain("PID 4242 node.exe");
    expect(report.refuse).toBe(false);
  });

  it("states the working-directory gap whenever the scan ran", async () => {
    const report = await preflight({
      fs: makeFs({ [join(S01, "src", "a.ts")]: "file" }),
      worktrees: [{ path: S01, branch: BRANCH01 }],
      processes: [],
    });
    expect(report.caveats.join("\n")).toContain("working directory");
    expect(report.caveats.join("\n")).toContain("ADR 0035");
  });

  it("caveats an unlistable process table rather than reporting a quiet machine", async () => {
    const report = await preflight({
      worktrees: [{ path: S01, branch: BRANCH01 }],
      processes: undefined,
    });
    expect(
      report.findings.some((finding) => finding.check === "namespace-holders"),
    ).toBe(false);
    expect(report.caveats.join("\n")).toContain("process table could not be listed");
  });

  it("does not list the process table at all when no namespace path exists", async () => {
    // A directory that is not there cannot be held, and the listing is
    // the one part of the preflight with a real cost. Every first launch
    // of a PRD lands here.
    let listed = 0;
    const report = await runLaunchPreflight(
      {
        repoRoot: REPO,
        namespace: namespace(),
        minFreeBytes: gbToBytes(5),
      },
      {
        listWorktrees: () => [],
        freeBytes: () => PLENTY_OF_DISK,
        listProcesses: async () => {
          listed++;
          return [];
        },
        fs: makeFs({}),
        selfPid: 1000,
      },
    );
    expect(listed).toBe(0);
    expect(report.caveats).toEqual([]);
    expect(report.findings).toEqual([]);
  });
});

describe("findHolders", () => {
  const rows: ProcessPathRow[] = [
    { pid: 1, name: "self.exe", commandLine: `x ${S01}` },
    { pid: 2, name: "codex.exe", commandLine: "codex.exe __otel-server" },
    {
      pid: 3,
      name: "node.exe",
      commandLine: `node ${S01.replace(/\\/g, "/")}/node_modules/vitest`,
    },
    { pid: 4, name: "esbuild.exe", executablePath: join(S01, "node_modules", "esbuild.exe") },
  ];

  it("matches a namespace prefix through either path separator", () => {
    expect(findHolders(rows, [S01], 1).map((holder) => holder.pid)).toEqual([
      3, 4,
    ]);
  });

  it("excludes the orchestrator's own process", () => {
    expect(findHolders(rows, [S01], 1).some((holder) => holder.pid === 1)).toBe(
      false,
    );
  });

  it("cannot see a holder that names no namespace path — the run-3 shape", () => {
    // Recorded as a limitation, not an aspiration: Win32_Process exposes
    // no working directory, so `codex.exe __otel-server` holding S01 as
    // its cwd is structurally invisible. The report's caveat says so.
    expect(findHolders(rows, [S01], 1).some((holder) => holder.pid === 2)).toBe(
      false,
    );
  });

  it("reports the namespace path it matched, for the operator to act on", () => {
    expect(findHolders(rows, [S01], 1)[0]!.matched).toBe(S01);
  });
});

describe("preflight — report-only", () => {
  it("keeps every finding but declines to refuse", async () => {
    const report = await preflight({
      freeBytes: gbToBytes(0.19),
      worktrees: [{ path: S02, branch: BRANCH02 }],
      reportOnly: true,
    });
    expect(refusals(report)).toHaveLength(2);
    expect(report.refuse).toBe(false);
  });
});

describe("preflight report formatting", () => {
  it("marks refusals, lists swept shells, and appends the caveats", async () => {
    const report = await preflight({
      freeBytes: gbToBytes(0.19),
      fs: makeFs({ [join(S02, "node_modules")]: "dir" }),
      worktrees: [{ path: S01, branch: BRANCH01 }],
      processes: [],
    });
    const block = formatPreflightReport(report)!;
    expect(block).toContain("[afk] Launch preflight:");
    expect(block).toContain("swept 1 empty directory shell(s)");
    expect(block).toContain("[REFUSE]");
    expect(block).toContain("note: the holder scan");
  });

  it("lists only the refusing conditions in the refusal, and names the override", async () => {
    const report = await preflight({
      freeBytes: gbToBytes(0.19),
      fs: makeFs({ [join(S02, "src", "leftover.ts")]: "file" }),
    });
    const refusal = formatPreflightRefusal(report);
    expect(refusal).toContain("Refusing to launch: 1 preflight condition(s)");
    expect(refusal).toContain("--preflight-report-only");
    expect(refusal).not.toContain("previous-run residue");
  });
});

describe("formatGb", () => {
  it("prints whole gigabytes plainly, fractions to two places, and tiny values in MB", () => {
    expect(formatGb(gbToBytes(5))).toBe("5 GB");
    expect(formatGb(gbToBytes(0.19))).toBe("0.19 GB");
    expect(formatGb(200 * 1024)).toBe("0.2 MB");
  });
});

describe("buildRunNamespace", () => {
  const ns = namespace();
  const owns = (root: number, name: string) => ns.roots[root]!.owns(name);

  it("claims this PRD and provider's slice worktrees, and no other's", () => {
    expect(owns(0, "afk-codex-demo-s01")).toBe(true);
    expect(owns(0, "afk-codex-demo-s17")).toBe(true);
    expect(owns(0, "afk-codex-other-s01")).toBe(false);
    expect(owns(0, "afk-demo-s01")).toBe(false);
    expect(owns(0, "afk-codex-demo-s01-backup")).toBe(false);
  });

  it("claims the review worktree by its exact name", () => {
    expect(owns(0, "feat-codex-demo-review")).toBe(true);
    expect(owns(0, "feat-codex-demo")).toBe(false);
  });

  it("claims scratch merge worktrees under .afk without claiming its other tenants", () => {
    expect(owns(1, "merge-afk-codex-demo-s01")).toBe(true);
    expect(owns(1, "worktrees")).toBe(false);
    expect(owns(1, "logs")).toBe(false);
    expect(owns(1, "state")).toBe(false);
    expect(owns(1, "artifacts")).toBe(false);
  });

  it("keeps kiro's legacy unsuffixed prefixes separate from a named provider's", () => {
    const kiro = buildRunNamespace({
      repoRoot: REPO,
      prdSlug: "demo",
      provider: kiroProvider,
      featBranch: "feat/demo",
      intended: [],
    });
    expect(kiro.roots[0]!.owns("afk-demo-s01")).toBe(true);
    expect(kiro.roots[0]!.owns("afk-codex-demo-s01")).toBe(false);
    expect(kiro.roots[0]!.owns("feat-demo-review")).toBe(true);
  });
});
