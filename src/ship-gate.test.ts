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
import { loadRunState, saveReviewPhase } from "./run-state.js";
import {
  buildPrCreationPlan,
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
  architectAuthority: {
    reachableTrigger: string | null;
    introducedByReviewedDiff: boolean;
  } = {
    reachableTrigger:
      "A normal pipeline retry consumes the invalid state.",
    introducedByReviewedDiff: true,
  },
): void {
  const dir = join(options.cwd, ".kiro", "specs", slug);
  mkdirSync(dir, { recursive: true });
  const findings =
    verdict === "SHIP"
      ? []
      : [
          {
            id: kind === "architect" ? "A-01" : "P-01",
            title: `${kind} finding`,
            class: kind === "architect" ? "INTEGRITY" : "PRODUCT",
            clearCondition: `Clear the ${kind} finding.`,
            disposition: "OPEN",
            ...(kind === "architect"
              ? architectAuthority
              : {}),
          },
        ];
  writeFileSync(
    join(dir, `review-${kind}.md`),
    [
      "# Guardian Review",
      "",
      `**Verdict:** ${verdict}`,
      "",
      `## Structured findings (v${kind === "architect" ? 2 : 1})`,
      JSON.stringify({
        version: kind === "architect" ? 2 : 1,
        findings,
      }),
      "",
    ].join("\n"),
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

describe("buildPrCreationPlan adoption provenance", () => {
  it("identifies each adopted slice and records its full provenance", () => {
    const plan = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["129", "130"],
      adoptions: [
        {
          ghIssue: "129",
          adopter: "Ada Lovelace",
          reason: "finished the slice manually",
          branch: "manual/demo-01",
          commit: "abc123",
        },
      ],
    });

    expect(plan.body).toContain("## Adopted Slices");
    expect(plan.body).toContain("#129");
    expect(plan.body).toContain("Ada Lovelace");
    expect(plan.body).toContain("finished the slice manually");
    expect(plan.body).toContain("manual/demo-01");
    expect(plan.body).toContain("abc123");
    expect(plan.body).not.toContain("#130\n- Adopter:");
  });
});

describe("runShipGate", () => {
  it("B-04 downgrades an unauthorized architect blocker and retains its finding", async () => {
    const repo = makeRepo();
    const slug = "architect-authority-floor";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(
        options,
        slug,
        kind,
        kind === "architect" ? "FIX-BEFORE-SHIP" : "SHIP",
        {
          reachableTrigger: null,
          introducedByReviewedDiff: false,
        },
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/42\n"
        : "",
    );

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("SHIP");
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ACCEPT-WITH-NOTES",
        findings: [
          expect.objectContaining({
            id: "A-01",
            reachableTrigger: null,
            introducedByReviewedDiff: false,
          }),
        ],
      }),
      expect.objectContaining({ outcome: "SHIP" }),
    );
    expect(
      loadRunState(repo, slug).reviewPhase?.rounds?.[0]?.architect,
    ).toMatchObject({
      source: "INVOKED",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "architect finding",
          class: "INTEGRITY",
          clearCondition: "Clear the architect finding.",
          disposition: "OPEN",
          reachableTrigger: null,
          introducedByReviewedDiff: false,
        },
      ],
    });
    // Slice #171: with no ledger this is round 1, so the architect still reads
    // the whole branch against the base.
    const architectPrompt = invoke.mock.calls
      .map(([options]) => options)
      .find((options) => options.role === "architect-review")!.prompt;
    expect(architectPrompt).toContain("review round 1");
    expect(architectPrompt).toContain("git diff main...HEAD");
    expect(architectPrompt).not.toContain("verification round");
  });

  it("P-01 reuses favorable cache entries and records the no-ledger findings fallback", async () => {
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
    const round = loadRunState(repo, slug).reviewPhase?.rounds?.[0];
    expect(round?.architect).toEqual({
      source: "CACHE",
      outcome: "SHIP",
      findings: [],
      findingsOriginRound: null,
    });
    expect(round?.pm).toEqual({
      source: "CACHE",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [],
      findingsOriginRound: null,
    });
    expect(loadRunState(repo, slug).reviewPhase?.architect).toEqual({
      headSha: round?.headSha,
      verdict: "SHIP",
    });
  });

  it("P-01 copies cache-sourced findings only from matching ledger evidence", async () => {
    const repo = makeRepo();
    const slug = "cache-backed";
    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("cached reviews must not invoke guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/42\n"
        : "",
    );
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const priorFinding = {
      stableId: "A-01",
      currentId: "A-02",
      title: "Backed note",
      class: "INTEGRITY",
      clearCondition: "Retain the evidence.",
      disposition: "OPEN" as const,
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const cachedReviewPhase = {
      sanity: { treeSha, ok: true as const },
      architect: {
        headSha,
        verdict: "ACCEPT-WITH-NOTES" as const,
      },
      pm: { headSha, verdict: "SHIP" as const },
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "pre-review",
          headSha,
          architect: {
            source: "INVOKED" as const,
            outcome: "ACCEPT-WITH-NOTES" as const,
            findings: [priorFinding],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 1,
          },
        },
      ],
    };
    saveReviewPhase(repo, slug, cachedReviewPhase);

    await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    expect(invoke).not.toHaveBeenCalled();
    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds?.[1]?.architect).toEqual({
      source: "CACHE",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [priorFinding],
      findingsOriginRound: 1,
    });
    expect(rounds?.[1]?.pm).toEqual({
      source: "CACHE",
      outcome: "SHIP",
      findings: [],
      findingsOriginRound: 1,
    });
  });

  it("B-02 P-02 persists only final outcomes after infrastructure retry semantics", async () => {
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
    const round = loadRunState(repo, slug).reviewPhase?.rounds?.[0];
    expect(round).toMatchObject({
      round: 1,
      architect: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "FIX-BEFORE-SHIP",
        findingsOriginRound: 1,
      },
    });
    expect(round?.pm.findings).toHaveLength(1);
  });

  it("P-05 opens an override PR without changing the existing decision policy", async () => {
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

  it("opens an override PR for an architect block with a favorable PM", async () => {
    const repo = makeRepo();
    const slug = "architect-override";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review"
          ? "FIX-BEFORE-SHIP"
          : "ACCEPT-WITH-NOTES",
      );
      return invokeResult();
    });
    let createBody = "";
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        createBody = args[args.indexOf("--body") + 1] ?? "";
        return "https://github.com/acme/repo/pull/53\n";
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
        url: "https://github.com/acme/repo/pull/53",
        number: 53,
      },
    });
    expect(createBody).toContain(
      "Architect review: **FIX-BEFORE-SHIP** (overridden)",
    );
    expect(createBody).toContain("PM review: **ACCEPT-WITH-NOTES**");
    expect(createBody).toContain("review-architect.md");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledOnce();
  });

  it("keeps the PR closed when both guardians block under either override setting", async () => {
    for (const openPrOnOverride of [false, true]) {
      const repo = makeRepo();
      const slug = `both-block-${openPrOnOverride}`;
      const fixture = makeJournal();
      const invoke = vi.fn(async (options: InvokeOptions) => {
        writeReview(
          options,
          slug,
          options.role === "architect-review" ? "architect" : "pm",
          "FIX-BEFORE-SHIP",
        );
        return invokeResult();
      });
      const runCommand = vi.fn<ShipCommandRunner>(() => "");
      const args = makeArgs(
        repo,
        slug,
        fixture.journal,
        invoke,
        runCommand,
      );
      args.options.openPrOnOverride = openPrOnOverride;

      const result = await runShipGate(args);

      expect(result.verdict).toBe("BLOCKED");
      // Slice #173: one unfavorable round is not the cap, so nothing is filed
      // and no exit is taken — `runCommand` never ran means no `gh` at all.
      expect(runCommand).not.toHaveBeenCalled();
      expect(fixture.setPrOverrideNote).not.toHaveBeenCalled();
      expect(result.pr.cappedExit).toBe(false);
      expect(
        loadRunState(repo, slug).reviewPhase?.filedFindings,
      ).toBeUndefined();
      expect(fixture.phase).toHaveBeenCalledWith(
        expect.stringContaining(
          "Guardian round cap not reached — 1 unfavorable round(s) of 3",
        ),
        "log",
      );
    }
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
  it("P-03 commits and parses each captured guardian artifact despite a concurrent sibling rewrite (#136)", async () => {
    const repo = makeRepo();
    const slug = "stale-review";
    const specsDir = join(repo, ".kiro", "specs", slug);
    const architectPath = join(specsDir, "review-architect.md");
    const stale = [
      "# Architecture Guardian Review",
      "",
      "**Verdict:** FIX-BEFORE-SHIP",
      "",
      "## Structured findings (v2)",
      '{"version":2,"findings":[{"id":"A-01","title":"Stale blocker","class":"INTEGRITY","clearCondition":"Fix stale flow","disposition":"OPEN","reachableTrigger":"A retry consumes stale state.","introducedByReviewedDiff":true}]}',
      "",
      "lockAdjudicatedContract at lines 2065-2185.",
      "",
    ].join("\n");
    const fresh = [
      "# Architecture Guardian Review",
      "",
      "**Verdict:** SHIP",
      "",
      "## Structured findings (v2)",
      '{"version":2,"findings":[]}',
      "",
      "runImpasseAdjudication at line 2237.",
      "",
    ].join("\n");
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
  it("B-01 QA-01 blocks worktree HEAD drift and persists the completed guardian round", async () => {
    const repo = makeRepo();
    const slug = "drift-head";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    let driftedHeadSha = "";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      if (kind === "pm") {
        // A rogue commit in the shared worktree: HEAD is no longer the tree
        // the guardians reviewed.
        writeFileSync(join(repo, "README.md"), "rogue\n", "utf-8");
        git(repo, ["commit", "-am", "rogue guardian commit"]);
        driftedHeadSha = git(repo, ["rev-parse", "HEAD"]);
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
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toEqual([
      {
        round: 1,
        reviewedHeadSha,
        headSha: driftedHeadSha,
        architect: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ]);
  });

  it("B-01 QA-02 persists the completed guardian round when the artifact commit fails", async () => {
    const repo = makeRepo();
    const slug = "artifact-commit-failure";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      if (kind === "pm") {
        writeFileSync(join(repo, ".git", "index.lock"), "locked\n", "utf-8");
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    await expect(
      runShipGate(makeArgs(repo, slug, fixture.journal, invoke, runCommand)),
    ).rejects.toThrow();

    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-started",
        phase: "draft-pr",
      }),
    );
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toEqual([
      {
        round: 1,
        reviewedHeadSha,
        headSha: reviewedHeadSha,
        architect: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ]);
  });

  it("B-01 QA-03 retries one failed round-state write and persists exactly one round", async () => {
    const repo = makeRepo();
    const slug = "round-write-retry";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const args = makeArgs(
      repo,
      slug,
      fixture.journal,
      invoke,
      runCommand,
    );
    let writeAttempts = 0;
    args.saveReviewPhase = (repoRoot, runSlug, reviewPhase) => {
      writeAttempts++;
      if (writeAttempts === 1) {
        throw new Error("injected round-state write failure");
      }
      saveReviewPhase(repoRoot, runSlug, reviewPhase);
    };

    await expect(runShipGate(args)).rejects.toThrow(
      "injected round-state write failure",
    );

    expect(writeAttempts).toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-started",
        phase: "draft-pr",
      }),
    );
    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds?.[0]).toEqual({
      round: 1,
      reviewedHeadSha,
      headSha: git(repo, ["rev-parse", "HEAD"]),
      architect: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
    });
  });

  it("B-01 QA-04 keeps the reusable caches when the round write is retried", async () => {
    const repo = makeRepo();
    const slug = "round-write-retry-cache";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const args = makeArgs(repo, slug, fixture.journal, invoke, runCommand);
    let writeAttempts = 0;
    args.saveReviewPhase = (repoRoot, runSlug, reviewPhase) => {
      writeAttempts++;
      if (writeAttempts === 1) {
        throw new Error("injected round-state write failure");
      }
      saveReviewPhase(repoRoot, runSlug, reviewPhase);
    };

    await expect(runShipGate(args)).rejects.toThrow(
      "injected round-state write failure",
    );

    expect(writeAttempts).toBe(2);
    const reviewPhase = loadRunState(repo, slug).reviewPhase;
    expect(reviewPhase?.rounds).toHaveLength(1);
    // The retry must carry the same cache payload the failed write carried:
    // a transient failure that erased these entries would force the next run
    // to re-run the sanity gate and both favorable guardians for nothing.
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    expect(reviewPhase?.architect).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.pm).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.sanity).toEqual({
      treeSha: git(repo, ["rev-parse", "HEAD^{tree}"]),
      ok: true,
    });
  });

  it("B-02 QA-01 persists both findings distinctly when two known aliases contest one prior identity", async () => {
    const repo = makeRepo();
    const slug = "alias-collision";
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      if (kind === "pm") {
        writeReview(options, slug, "pm", "SHIP");
        return invokeResult();
      }
      // Two findings naming the one prior entry through both of its aliases.
      const dir = join(options.cwd, ".kiro", "specs", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "review-architect.md"),
        [
          "# Guardian Review",
          "",
          "**Verdict:** FIX-BEFORE-SHIP",
          "",
          "## Structured findings (v2)",
          JSON.stringify({
            version: 2,
            findings: [
              {
                id: "A-05",
                title: "Current-alias claimant",
                class: "PRODUCT",
                clearCondition: "Clear the current alias.",
                disposition: "REPEATED",
                reachableTrigger: "A retry reaches the current alias.",
                introducedByReviewedDiff: false,
              },
              {
                id: "A-01",
                title: "Stable-alias claimant",
                class: "INTEGRITY",
                clearCondition: "Clear the stable alias.",
                disposition: "OPEN",
                reachableTrigger: "A retry reaches the stable alias.",
                introducedByReviewedDiff: false,
              },
            ],
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const cachedReviewPhase = {
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "pre-review",
          headSha: "prior-head",
          architect: {
            source: "INVOKED" as const,
            outcome: "FIX-BEFORE-SHIP" as const,
            findings: [
              {
                stableId: "A-01",
                currentId: "A-05",
                title: "The one prior finding",
                class: "INTEGRITY",
                clearCondition: "Commit the durable evidence.",
                disposition: "OPEN" as const,
                reachableTrigger:
                  "A retry consumes the incomplete durable record.",
                introducedByReviewedDiff: true,
              },
            ],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 1,
          },
        },
      ],
    };
    saveReviewPhase(repo, slug, cachedReviewPhase);

    await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    // Both parsed findings persist distinctly: neither fingerprint matches the
    // prior entry, so the stableId claimant keeps A-01 and the current-alias
    // claimant mints a new identity (ADR 0057 decision 1 amendment).
    expect(rounds).toHaveLength(2);
    expect(rounds?.[1]?.architect).toEqual({
      source: "INVOKED",
      outcome: "FIX-BEFORE-SHIP",
      findings: [
        {
          stableId: "A-05",
          currentId: "A-05",
          title: "Current-alias claimant",
          class: "PRODUCT",
          clearCondition: "Clear the current alias.",
          disposition: "REPEATED",
          reachableTrigger: "A retry reaches the current alias.",
          introducedByReviewedDiff: false,
        },
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "Stable-alias claimant",
          class: "INTEGRITY",
          clearCondition: "Clear the stable alias.",
          disposition: "OPEN",
          reachableTrigger: "A retry reaches the stable alias.",
          introducedByReviewedDiff: false,
        },
      ],
      findingsOriginRound: 2,
    });
    // A blocking architect result is unfavorable, so it is never cached.
    expect(loadRunState(repo, slug).reviewPhase?.architect).toBeUndefined();
    expect(headSha).toBeTruthy();

    // Slice #171: this same second round read the ledger the first wrote — its
    // prompt is scoped to the fix diff from round 1's headSha and lists the
    // prior finding by the stable ID the guardian must reuse (ADR 0057
    // decision 2). Asserted here rather than in a new spawned scenario.
    const architectPrompt = invoke.mock.calls
      .map(([options]) => options)
      .find((options) => options.role === "architect-review")!.prompt;
    expect(architectPrompt).toContain("review round 2, a verification round");
    expect(architectPrompt).toContain("git diff prior-head..HEAD");
    expect(architectPrompt).not.toContain("git diff main...HEAD");
    expect(architectPrompt).toContain("[A-01]");
    expect(architectPrompt).toContain("Commit the durable evidence.");
    expect(architectPrompt).toContain("Reuse the stable IDs");
    expect(fixture.phase).toHaveBeenCalledWith(
      expect.stringContaining(
        "Architect review round 2: verifying the fix diff prior-head..HEAD",
      ),
      "log",
    );
  });

  // One spawned scenario, deliberately: the cap exit's wiring is what the unit
  // tests cannot reach — the ordering of file-then-decide, the durable
  // filed-issue record, the PR body, and the note dedupe *across* ship-gate
  // entries. It runs the gate twice against one repo so the second entry pays
  // no second setup and proves the once-across-rounds rule end to end
  // (slices #173 and #174).
  it("takes the recorded cap exit, files each finding once across rounds, and ships", async () => {
    const repo = makeRepo();
    const slug = "guardian-round-cap";
    const fixture = makeJournal();
    const writeCappedArchitectReview = (options: InvokeOptions) => {
      const dir = join(options.cwd, ".kiro", "specs", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "review-architect.md"),
        [
          "# Guardian Review",
          "",
          "**Verdict:** FIX-BEFORE-SHIP",
          "",
          "## Structured findings (v2)",
          JSON.stringify({
            version: 2,
            findings: [
              {
                id: "A-01",
                title: "Durable record is written incomplete",
                class: "INTEGRITY",
                clearCondition: "The round persists before the early return.",
                disposition: "REPEATED",
                reachableTrigger: "A retry consumes the incomplete record.",
                introducedByReviewedDiff: true,
              },
              {
                id: "A-02",
                title: "Helper name drifts from the module's convention",
                class: "CONVENTION",
                clearCondition: "The helper follows the module's naming.",
                disposition: "REPEATED",
                reachableTrigger: null,
                introducedByReviewedDiff: false,
              },
            ],
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
    };
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        writeCappedArchitectReview(options);
      } else {
        writeReview(options, slug, "pm", "SHIP");
      }
      return invokeResult();
    });
    let nextIssue = 100;
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        return `https://github.com/acme/repo/issues/${nextIssue++}\n`;
      }
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/77\n";
      }
      return "";
    });

    const priorFindings = [
      {
        stableId: "A-01",
        currentId: "A-01",
        title: "Durable record is written incomplete",
        class: "INTEGRITY",
        clearCondition: "The round persists before the early return.",
        disposition: "OPEN" as const,
        reachableTrigger: "A retry consumes the incomplete record.",
        introducedByReviewedDiff: true,
      },
      {
        stableId: "A-02",
        currentId: "A-02",
        title: "Helper name drifts from the module's convention",
        class: "CONVENTION",
        clearCondition: "The helper follows the module's naming.",
        disposition: "OPEN" as const,
        reachableTrigger: null,
        introducedByReviewedDiff: false,
      },
    ];
    // Two unfavorable rounds already spent; this pass is the third.
    const cachedReviewPhase = {
      rounds: [1, 2].map((round) => ({
        round,
        reviewedHeadSha: round === 1 ? "pre-review" : `head-${round - 1}`,
        headSha: `head-${round}`,
        architect: {
          source: "INVOKED" as const,
          outcome: "FIX-BEFORE-SHIP" as const,
          findings: priorFindings.map((finding) => ({ ...finding })),
          findingsOriginRound: round,
        },
        pm: {
          source: "INVOKED" as const,
          outcome: "SHIP" as const,
          findings: [],
          findingsOriginRound: round,
        },
      })),
    };
    saveReviewPhase(repo, slug, cachedReviewPhase);

    const capped = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    // The gate stops fixing and ships: a capped run is successful, like an
    // override (ADR 0057 decision 4, extending ADR 0015's carve-out).
    expect(capped.verdict).toBe("SHIP");
    expect(capped.pr).toMatchObject({
      requested: true,
      overridden: false,
      cappedExit: true,
      url: "https://github.com/acme/repo/pull/77",
    });

    // The blocker and the note are each filed exactly once, blocker first.
    const issueCalls = runCommand.mock.calls.filter(
      ([command, args]) =>
        command === "gh" && args[0] === "issue" && args[1] === "create",
    );
    expect(issueCalls).toHaveLength(2);
    const issueBodies = issueCalls.map(([, args]) => args[5]!);
    expect(issueBodies[0]).toContain("unresolved at the guardian round cap");
    expect(issueBodies[0]).toContain("`A-01`");
    expect(issueBodies[1]).toContain("note shipped unfixed");
    expect(issueBodies[1]).toContain("`A-02`");

    // The filed issues are durable, so a later round cannot file them again.
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toEqual([
      expect.objectContaining({
        guardian: "architect",
        stableId: "A-01",
        kind: "BLOCKER",
        round: 3,
        issue: "https://github.com/acme/repo/issues/100",
      }),
      expect.objectContaining({
        guardian: "architect",
        stableId: "A-02",
        kind: "NOTE",
        round: 3,
        issue: "https://github.com/acme/repo/issues/101",
      }),
    ]);

    // The PR body and the run summary both record the exit, through the same
    // plumbing the override uses.
    const prCreateBodies = () =>
      runCommand.mock.calls
        .filter(
          ([command, args]) =>
            command === "gh" && args[0] === "pr" && args[1] === "create",
        )
        .map(([, args]) => args[args.indexOf("--body") + 1]!);
    const prBody = prCreateBodies()[0]!;
    expect(prBody).toContain("## Guardian round cap reached");
    expect(prBody).toContain("3 unfavorable round(s), reaching its cap of 3");
    expect(prBody).toContain("https://github.com/acme/repo/issues/100");
    expect(prBody).not.toContain("https://github.com/acme/repo/issues/101");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledWith(
      expect.stringContaining("PR opened at the guardian round cap after 3"),
    );

    // Round 4, same disagreement: nothing is filed a second time.
    const secondFixture = makeJournal();
    const carried = loadRunState(repo, slug).reviewPhase!;
    const again = await runShipGate({
      ...makeArgs(repo, slug, secondFixture.journal, invoke, runCommand),
      cachedReviewPhase: carried,
    });

    expect(again.verdict).toBe("SHIP");
    expect(again.pr.cappedExit).toBe(true);
    expect(
      runCommand.mock.calls.filter(
        ([command, args]) =>
          command === "gh" && args[0] === "issue" && args[1] === "create",
      ),
    ).toHaveLength(2);
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toHaveLength(2);
    // The round-4 PR body still names the issues the earlier round filed.
    expect(prCreateBodies().at(-1)!).toContain(
      "https://github.com/acme/repo/issues/100",
    );
  });

  it("refuses the cap exit when an unresolved blocker cannot be filed", async () => {
    const repo = makeRepo();
    const slug = "guardian-cap-filing-failure";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(
        options,
        slug,
        kind,
        kind === "architect" ? "FIX-BEFORE-SHIP" : "SHIP",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        throw new Error("gh: could not create issue (403)");
      }
      return "";
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      options: {
        ...makeArgs(repo, slug, fixture.journal, invoke, runCommand).options,
        // Cap 1, so this single blocking round reaches it.
        guardianRoundCap: 1,
        reviewRetries: 1,
      },
    });

    // Filing is mandatory for a cap exit, not best-effort: no PR, no success.
    expect(result.verdict).toBe("BLOCKED");
    expect(result.failureReason).toContain("guardian round cap reached");
    expect(result.failureReason).toContain("could not be filed as issues");
    expect(result.pr.requested).toBe(false);
    expect(fixture.setPrOverrideNote).not.toHaveBeenCalled();
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toBeUndefined();
    // Two attempts per draft with one retry, and the retry is announced.
    expect(
      runCommand.mock.calls.filter(
        ([command, args]) =>
          command === "gh" && args[0] === "issue" && args[1] === "create",
      ),
    ).toHaveLength(2);
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guardian-cap-filing-failed" }),
    );
    // The round itself still persists: the ledger records every round.
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toHaveLength(1);
  });

  it("keeps a clean ship when a note cannot be filed", async () => {
    const repo = makeRepo();
    const slug = "note-filing-failure";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "ACCEPT-WITH-NOTES");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        throw new Error("gh: could not create issue (403)");
      }
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/78\n";
      }
      return "";
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    });

    // A note nobody could file must not sink a ship both guardians cleared.
    expect(result.verdict).toBe("SHIP");
    expect(result.pr.cappedExit).toBe(false);
    expect(result.pr.overridden).toBe(false);
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guardian-note-filing-failed" }),
    );
    // Nothing was recorded as filed, so a later round retries it.
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toBeUndefined();
  });

  it("B-01 QA-06 keeps the reused caches when the artifact commit fails", async () => {
    const repo = makeRepo();
    const slug = "artifact-commit-failure-cache";
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const fixture = makeJournal();
    // Only PM is invoked: the architect verdict and the sanity gate are reused
    // from cache, so both must survive the failing exit below.
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(options, slug, "pm", "SHIP");
      writeFileSync(join(repo, ".git", "index.lock"), "locked\n", "utf-8");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const cachedReviewPhase = {
      sanity: { treeSha, ok: true as const },
      architect: { headSha, verdict: "SHIP" as const },
    };
    saveReviewPhase(repo, slug, cachedReviewPhase);

    await expect(
      runShipGate({
        ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
        cachedReviewPhase,
      }),
    ).rejects.toThrow();

    const reviewPhase = loadRunState(repo, slug).reviewPhase;
    expect(reviewPhase?.rounds).toHaveLength(1);
    expect(reviewPhase?.architect).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.sanity).toEqual({ treeSha, ok: true });
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
