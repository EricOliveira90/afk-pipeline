import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "./test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeOptions, InvokeResult } from "./agent-provider.js";
import type { SanityCommandRunner } from "./preship.js";
import {
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
  git(repo, ["config", "user.email", "afk@example.com"]);
  git(repo, ["config", "user.name", "AFK Test"]);
  writeFileSync(join(repo, ".gitignore"), ".afk/\n", "utf-8");
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

interface JournalFixture {
  journal: ShipGateJournal;
  phase: ReturnType<typeof vi.fn>;
  setReviewOutcomes: ReturnType<typeof vi.fn>;
  setPrOverrideNote: ReturnType<typeof vi.fn>;
  setPrUrl: ReturnType<typeof vi.fn>;
}

function makeJournal(): JournalFixture {
  const logDir = mkdtempSync(join(tmpdir(), "afk-ship-logs-"));
  tempDirs.push(logDir);
  const phase = vi.fn();
  const setReviewOutcomes = vi.fn();
  const setPrOverrideNote = vi.fn();
  const setPrUrl = vi.fn();
  return {
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
      event: vi.fn(),
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
      { outcome: "SHIP" },
      { outcome: "FIX-BEFORE-SHIP" },
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
});
