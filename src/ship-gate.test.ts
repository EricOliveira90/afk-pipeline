import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "./test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeOptions, InvokeResult } from "./agent-provider.js";
import type { SanityCommandRunner } from "./preship.js";
import type { RunEventPayload } from "./run-events.js";
import {
  detectReviewWorktreeDrift,
  formatReviewWorktreeDrift,
  restoreCapturedReviewArtifacts,
  runShipGate,
  type RunShipGateArgs,
  type ShipCommandRunner,
  type ShipGateJournal,
} from "./ship-gate.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmDirWithRetry(tempDirs.pop()!);
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-ship-gate-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), ".afk/\n", "utf-8");
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

interface JournalFixture {
  journal: ShipGateJournal;
  event: ReturnType<typeof vi.fn>;
  phase: ReturnType<typeof vi.fn>;
  setReviewOutcomes: ReturnType<typeof vi.fn>;
  setPrOverrideNote: ReturnType<typeof vi.fn>;
  setPrUrl: ReturnType<typeof vi.fn>;
}

function makeJournal(): JournalFixture {
  const logDir = mkdtempSync(join(tmpdir(), "afk-ship-logs-"));
  tempDirs.push(logDir);
  const event = vi.fn();
  const phase = vi.fn();
  const setReviewOutcomes = vi.fn();
  const setPrOverrideNote = vi.fn();
  const setPrUrl = vi.fn();
  return {
    event,
    phase,
    setReviewOutcomes,
    setPrOverrideNote,
    setPrUrl,
    journal: {
      agentLog(sliceId, agent, round) {
        const suffix = round == null ? "" : `-${round}`;
        return createWriteStream(
          join(logDir, `${sliceId}-${agent}${suffix}.log`),
        );
      },
      event,
      phase,
      setPrOverrideNote,
      setPrUrl,
      setReviewOutcomes,
      setSanityGate: vi.fn(),
    },
  };
}

function writeReview(
  options: InvokeOptions,
  slug: string,
  kind: "architect" | "pm",
  verdict: string,
): void {
  const dir = join(options.cwd, ".kiro", "specs", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `review-${kind}.md`),
    `# Guardian Review\n\n**Verdict:** ${verdict}\n`,
    "utf-8",
  );
}

function invokeResult(): InvokeResult {
  return { exitCode: 0, stdout: "", stats: {} };
}

function makeArgs(
  repo: string,
  slug: string,
  journal: ShipGateJournal,
  invoke: RunShipGateArgs["invoke"],
  runCommand: ShipCommandRunner,
): RunShipGateArgs {
  return {
    repoRoot: repo,
    reviewDir: repo,
    featureBranch: `feat/${slug}`,
    defaultBranch: "main",
    prdSlug: slug,
    runSlug: slug,
    specsDir: `.kiro/specs/${slug}`,
    relevantFilesBlock: "(none)",
    reviewScope: "Selected slices only.",
    closesIssues: ["42"],
    invoke,
    journal,
    options: {
      reviewRetries: 1,
      reviewIdleTimeoutMs: 600_000,
      reviewIdleWarningIntervalMs: 30_000,
      serialReviews: true,
      openPrOnOverride: false,
    },
    runCommand,
  };
}

describe("runShipGate", () => {
  it("reuses sanity and favorable reviews cached against unchanged SHAs", async () => {
    const repo = makeRepo();
    const slug = "cache-hit";
    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("cached reviews must not invoke guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/41\n";
      }
      return "";
    });
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase: {
        sanity: { treeSha, ok: true },
        architect: { headSha, verdict: "SHIP" },
        pm: { headSha, verdict: "ACCEPT-WITH-NOTES" },
      },
    });

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: false,
        url: "https://github.com/acme/repo/pull/41",
        number: 41,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Reusing cached pre-ship sanity PASS"),
      ),
    ).toBe(true);
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Reusing cached architect review verdict SHIP"),
      ),
    ).toBe(true);
  });

  it("retries a guardian infrastructure failure without wave machinery", async () => {
    const repo = makeRepo();
    const slug = "infra-retry";
    const fixture = makeJournal();
    let architectAttempts = 0;
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        architectAttempts++;
        if (architectAttempts === 1) {
          throw new Error("wrapper failed before producing output");
        }
        writeReview(options, slug, "architect", "SHIP");
      } else {
        writeReview(options, slug, "pm", "FIX-BEFORE-SHIP");
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("BLOCKED");
    expect(architectAttempts).toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SHIP" }),
      expect.objectContaining({ outcome: "FIX-BEFORE-SHIP" }),
    );
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Infrastructure retry 1/1"),
      ),
    ).toBe(true);
  });

  it("opens an override PR and records the override outcome", async () => {
    const repo = makeRepo();
    const slug = "override";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review" ? "SHIP" : "FIX-BEFORE-SHIP",
      );
      return invokeResult();
    });
    let createBody = "";
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        createBody = args[args.indexOf("--body") + 1] ?? "";
        return "https://github.com/acme/repo/pull/52\n";
      }
      return "";
    });
    const args = makeArgs(
      repo,
      slug,
      fixture.journal,
      invoke,
      runCommand,
    );
    args.options.openPrOnOverride = true;

    const result = await runShipGate(args);

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: true,
        url: "https://github.com/acme/repo/pull/52",
        number: 52,
      },
    });
    expect(createBody).toContain("## Human override (--open-pr-on-override)");
    expect(createBody).toContain("PM review: **FIX-BEFORE-SHIP** (overridden)");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledOnce();
  });

  it("recovers an existing PR when draft creation fails", async () => {
    const repo = makeRepo();
    const slug = "existing-pr";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        "SHIP",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        throw new Error("a pull request already exists");
      }
      if (command === "gh" && args[1] === "view") {
        return JSON.stringify({
          number: 63,
          url: "https://github.com/acme/repo/pull/63",
        });
      }
      return "";
    });

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: false,
        url: "https://github.com/acme/repo/pull/63",
        number: 63,
      },
    });
    expect(fixture.setPrUrl).toHaveBeenCalledWith(
      "https://github.com/acme/repo/pull/63",
    );
  });

  /**
   * Commits a pnpm project whose typecheck script only passes once the
   * dependency install has run — the incident's dependency on `node_modules`,
   * without a registry install.
   */
  function commitSanityProject(repo: string): void {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {
          typecheck:
            "node -e \"require('node:fs').accessSync('node_modules/afk-marker')\"",
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf-8",
    );
    writeFileSync(join(repo, ".gitignore"), ".afk/\nnode_modules/\n", "utf-8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "add sanity scripts"]);
  }

  /**
   * Sanity subprocess seam: the install is stubbed (its effect, or its
   * failure), the steps run for real. No suite pays a registry install
   * (AGENTS.md test loop discipline; ADR 0033).
   */
  function stubSanityRunner(
    ran: string[],
    install: (cwd: string) => { exitCode: number; output?: string },
  ): SanityCommandRunner {
    return (command, args, options) => {
      ran.push([command, ...args].join(" "));
      if (args[0] === "install") {
        const outcome = install(options.cwd);
        return {
          outcome: "EXITED",
          exitCode: outcome.exitCode,
          output: outcome.output,
        };
      }
      try {
        execFileSync(command, [...args], { cwd: options.cwd, stdio: "pipe" });
        return { outcome: "EXITED", exitCode: 0 };
      } catch (error) {
        return {
          outcome: "EXITED",
          exitCode: 1,
          output: error instanceof Error ? error.message : String(error),
        };
      }
    };
  }

  // Regression for #101: the orchestrator hands the ship gate a scratch
  // review worktree (`git worktree add`, fresh checkout, no node_modules).
  // Every sanity command failed instantly and the gate blocked the ship as
  // a code failure on a green branch, skipping guardians and the draft PR.
  it("ships from an uninstalled review worktree by installing dependencies before sanity (#101)", async () => {
    const repo = makeRepo();
    const slug = "uninstalled-worktree";
    commitSanityProject(repo);
    // The exact incident shape: a fresh worktree of the feature branch with
    // no node_modules.
    const reviewDir = mkdtempSync(join(tmpdir(), "afk-review-wt-"));
    tempDirs.push(reviewDir);
    git(repo, ["worktree", "add", "--force", reviewDir, "-b", `feat/${slug}`]);
    expect(existsSync(join(reviewDir, "node_modules"))).toBe(false);

    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review" ? "SHIP" : "ACCEPT-WITH-NOTES",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/101\n";
      }
      return "";
    });
    const ran: string[] = [];
    const sanityRunCommand = stubSanityRunner(ran, (cwd) => {
      mkdirSync(join(cwd, "node_modules", "afk-marker"), { recursive: true });
      return { exitCode: 0 };
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      reviewDir,
      sanityRunCommand,
    });

    expect(result.verdict).toBe("SHIP");
    // The install ran first, in the review worktree, and the step that needs
    // it then passed for real.
    expect(ran).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
    ]);
    expect(existsSync(join(reviewDir, "node_modules", "afk-marker"))).toBe(
      true,
    );
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Pre-ship sanity gate passed"),
      ),
    ).toBe(true);
  });

  it("blocks with a CONFIGURATION failure — not a code failure — when the sanity install fails (#101)", async () => {
    const repo = makeRepo();
    const slug = "install-config-failure";
    commitSanityProject(repo);

    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("a configuration failure must not reach guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const ran: string[] = [];
    const sanityRunCommand = stubSanityRunner(ran, () => ({
      exitCode: 1,
      output: "  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n",
    }));

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      sanityRunCommand,
    });

    expect(result.verdict).toBe("BLOCKED");
    // Named in the base-gate vocabulary, with pnpm's own diagnostic — an
    // operator can tell a broken environment from a red suite.
    expect(result.failureReason).toContain("CONFIGURATION: install");
    expect(result.failureReason).toContain(
      "configuration failure of the environment, not a code failure",
    );
    expect(result.failureReason).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    // The sanity steps never ran, so they are not reported as failures.
    expect(ran).toEqual(["pnpm install --frozen-lockfile"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("records the CONFIGURATION kind on the sanity phase event and in the summary", async () => {
    const repo = makeRepo();
    const slug = "install-config-event";
    commitSanityProject(repo);

    const fixture = makeJournal();
    const setSanityGate = vi.fn();
    const event = vi.fn();
    const journal: ShipGateJournal = {
      ...fixture.journal,
      event,
      setSanityGate,
    };
    const sanityRunCommand = stubSanityRunner([], () => ({
      exitCode: 1,
      output: "ERR_PNPM_OUTDATED_LOCKFILE",
    }));

    await runShipGate({
      ...makeArgs(
        repo,
        slug,
        journal,
        vi.fn(async () => invokeResult()),
        vi.fn<ShipCommandRunner>(() => ""),
      ),
      sanityRunCommand,
    });

    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-ended",
        phase: "sanity",
        verdict: "FAIL",
        failureKind: "CONFIGURATION",
      }),
    );
    expect(setSanityGate).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        failures: ["install"],
        failureKind: "CONFIGURATION",
      }),
    );
  });

  // Issue #136: both guardians share one review worktree, so one agent's
  // shell can revert the other's freshly written review to the version
  // committed by the previous gate round. A new spawned scenario is
  // deliberate here — no existing fixture commits a prior round's review.
  //
  // Deliberately `serialReviews: false`, the production default
  // (`serialLanes === true` is off in every shipped config), so the half of
  // the fix that classifies the verdict from the snapshot is exercised on the
  // path runs actually take. The PM's revert is gated on the architect's
  // `run-phase-ended` event, which fires *after* the capture read — that is
  // the boundary the fix claims, and the ordering has to be pinned rather
  // than raced or the test would be flaky about which invariant it proves.
  it("commits the architect's own review after the PM agent reverts it in the shared worktree, reviews concurrent (#136)", async () => {
    const repo = makeRepo();
    const slug = "stale-review";
    const specsDir = join(repo, ".kiro", "specs", slug);
    const architectPath = join(specsDir, "review-architect.md");
    const stale =
      "# Architecture Guardian Review\n\n**Verdict:** FIX-BEFORE-SHIP\n\nlockAdjudicatedContract at lines 2065-2185.\n";
    const fresh =
      "# Architecture Guardian Review\n\n**Verdict:** SHIP\n\nrunImpasseAdjudication at line 2237.\n";
    // The previous gate round's review, already on the branch.
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(architectPath, stale, "utf-8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "round 3 reviews"]);

    const fixture = makeJournal();
    let architectCaptured!: () => void;
    const architectSettled = new Promise<void>((resolve) => {
      architectCaptured = resolve;
    });
    const journal: ShipGateJournal = {
      ...fixture.journal,
      event: (payload: RunEventPayload) => {
        fixture.event(payload);
        if (
          payload.type === "run-phase-ended" &&
          payload.phase === "architect-review"
        ) {
          architectCaptured();
        }
      },
    };
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        writeFileSync(architectPath, fresh, "utf-8");
      } else {
        await architectSettled;
        writeReview(options, slug, "pm", "SHIP");
        // What the PM guardian actually ran in run-20260829-161928 (item_70);
        // its editor's delete-and-re-add of the same file, four minutes after
        // the architect finished, had the identical effect.
        git(repo, [
          "checkout-index",
          "--force",
          "--",
          `.kiro/specs/${slug}/review-architect.md`,
        ]);
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/136\n"
        : "",
    );

    const args = makeArgs(repo, slug, journal, invoke, runCommand);
    const result = await runShipGate({
      ...args,
      options: { ...args.options, serialReviews: false },
    });

    expect(result).toMatchObject({ verdict: "SHIP" });
    expect(
      git(repo, ["show", `HEAD:.kiro/specs/${slug}/review-architect.md`]),
    ).toContain("runImpasseAdjudication at line 2237");
    expect(readFileSync(architectPath, "utf-8")).toBe(fresh);
    // The verdict came from the snapshot, not from the reverted file — the
    // stale blob says FIX-BEFORE-SHIP, which would have kept the PR closed.
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SHIP" }),
      expect.objectContaining({ outcome: "SHIP" }),
    );
    const restoreWarning = fixture.phase.mock.calls.find(([message]) =>
      String(message).includes(
        "Architect review artifact was changed in the review worktree",
      ),
    );
    expect(restoreWarning).toBeDefined();
    // F6: the warning names the file, not just the role.
    expect(String(restoreWarning![0])).toContain("review-architect.md");
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        reason: "review-artifact-restored",
      }),
    );
  });

  // Residual insurance (#136 review follow-up): the restore step covers the
  // two review files, so a guardian shell that moves anything else has to be
  // caught by the pre-commit HEAD/status check instead.
  it("blocks the gate when a guardian moves HEAD in the review worktree", async () => {
    const repo = makeRepo();
    const slug = "drift-head";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      if (kind === "pm") {
        // A rogue commit in the shared worktree: HEAD is no longer the tree
        // the guardians reviewed.
        writeFileSync(join(repo, "README.md"), "rogue\n", "utf-8");
        git(repo, ["commit", "-am", "rogue guardian commit"]);
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("BLOCKED");
    expect(result.failureReason).toContain("HEAD moved");
    expect(result.pr.requested).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        reason: "review-worktree-drift",
      }),
    );
  });
});

describe("detectReviewWorktreeDrift", () => {
  const specsDir = ".kiro/specs/slug";

  it("passes a worktree dirty only with this run's review artifacts", () => {
    expect(
      detectReviewWorktreeDrift({
        headShaBefore: "abc",
        headShaNow: "abc",
        statusPorcelain: [
          ` M ${specsDir}/review-architect.md`,
          `A  ${specsDir}/review-pm.md`,
        ].join("\n"),
        specsDir,
      }),
    ).toBeNull();
  });

  it("separates tracked source changes from untracked scratch", () => {
    const drift = detectReviewWorktreeDrift({
      headShaBefore: "abc",
      headShaNow: "abc",
      statusPorcelain: [
        ` M ${specsDir}/review-pm.md`,
        " M src/orchestrator.ts",
        " D src/git.ts",
        "R  src/old.ts -> src/new.ts",
        "?? guardian-scratch.log",
      ].join("\n"),
      specsDir,
    });

    expect(drift).toEqual({
      headMoved: undefined,
      changedPaths: ["M src/orchestrator.ts", "D src/git.ts", "R src/new.ts"],
      untrackedPaths: ["guardian-scratch.log"],
    });
    expect(formatReviewWorktreeDrift(drift!)).toContain("src/orchestrator.ts");
  });

  it("reports a moved HEAD even with a clean tree", () => {
    const drift = detectReviewWorktreeDrift({
      headShaBefore: "a".repeat(40),
      headShaNow: "b".repeat(40),
      statusPorcelain: "",
      specsDir,
    });

    expect(drift?.headMoved).toEqual({
      before: "a".repeat(40),
      after: "b".repeat(40),
    });
    expect(formatReviewWorktreeDrift(drift!)).toContain("HEAD moved");
  });

  it("stays silent when HEAD could not be resolved on either side", () => {
    expect(
      detectReviewWorktreeDrift({
        headShaBefore: null,
        headShaNow: "b".repeat(40),
        statusPorcelain: "",
        specsDir,
      }),
    ).toBeNull();
  });
});

describe("restoreCapturedReviewArtifacts", () => {
  it("rewrites only the artifacts that diverged since capture", () => {
    const disk = new Map<string, string>([
      ["a.md", "reverted"],
      ["b.md", "untouched"],
    ]);
    const io = {
      read: (path: string) => disk.get(path) ?? null,
      write: (path: string, content: string) => void disk.set(path, content),
    };

    const report = restoreCapturedReviewArtifacts(
      [
        { label: "Architect", path: "a.md", content: "authored" },
        { label: "PM", path: "b.md", content: "untouched" },
      ],
      io,
    );

    expect(report).toEqual({
      restored: [{ label: "Architect", path: "a.md" }],
      failed: [],
    });
    expect(disk.get("a.md")).toBe("authored");
  });

  // The review worktree still belongs to a shell-holding agent when this
  // runs: the path can be gone, read-only, or on a full disk. Losing a
  // three-hour gate to a failed one-file write is the worse outcome.
  it("reports a throwing io as a failure instead of crashing the gate", () => {
    const writes: string[] = [];
    const io = {
      read: (path: string) => (path === "a.md" ? null : "on disk"),
      write: (path: string, content: string) => {
        if (path === "a.md") {
          throw Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          });
        }
        writes.push(`${path}:${content}`);
      },
    };

    const report = restoreCapturedReviewArtifacts(
      [
        { label: "Architect", path: "a.md", content: "authored" },
        { label: "PM", path: "b.md", content: "pm authored" },
      ],
      io,
    );

    expect(report.restored).toEqual([{ label: "PM", path: "b.md" }]);
    expect(report.failed).toEqual([
      {
        label: "Architect",
        path: "a.md",
        error: "ENOENT: no such file or directory",
      },
    ]);
    // The sibling artifact is still restored: one failure is not a bail-out.
    expect(writes).toEqual(["b.md:pm authored"]);
  });

  it("reports a throwing read as a failure", () => {
    const report = restoreCapturedReviewArtifacts(
      [{ label: "PM", path: "b.md", content: "authored" }],
      {
        read: () => {
          throw new Error("EACCES: permission denied");
        },
        write: () => {
          throw new Error("write must not be attempted after a failed read");
        },
      },
    );

    expect(report.restored).toEqual([]);
    expect(report.failed).toEqual([
      { label: "PM", path: "b.md", error: "EACCES: permission denied" },
    ]);
  });

  it("leaves the path alone when the agent wrote no file and skips cached verdicts", () => {
    const writes: string[] = [];
    const io = {
      read: () => null,
      write: (path: string) => void writes.push(path),
    };

    expect(
      restoreCapturedReviewArtifacts(
        [undefined, { label: "PM", path: "b.md", content: null }],
        io,
      ),
    ).toEqual({ restored: [], failed: [] });
    expect(writes).toEqual([]);
  });
});
