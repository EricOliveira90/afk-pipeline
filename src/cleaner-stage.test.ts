/**
 * The cleaner stage as a unit, against real git trees and real gate processes,
 * with no pipeline spawned.
 *
 * `runCleanerStage` is a module with one orchestrator call site (#87 B-03), so
 * every stage-level claim is observable from here: a `makeRepo()` worktree, a
 * stub "cleaner" that writes whatever the round is supposed to have written, and
 * `node -e` clean gates whose verdict is a file's presence. That is the whole
 * apparatus — the expansion, the bound, the round shape, the four exit paths and
 * the escalation parse all read off it (`CLAUDE.md`, "Where a new assertion
 * goes": a spawned scenario is the last resort, and these need no orchestrator).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_CLEANER_ROUNDS } from "./bounds.js";
import {
  changedFilesForExpansion,
  cleanGateDeclarations,
  cleanerExhaustionReason,
  CLEANER_ESCALATION_FILENAME,
  CLEAN_GATE_STAGE,
  NO_CHANGED_FILES_DETAIL,
  parseCleanerEscalation,
  runCleanerStage,
  type CleanerDispatchInput,
  type CleanerRoundRecord,
  type CleanerStageContext,
  type CleanerStageInput,
  type CleanerStageResult,
} from "./cleaner-stage.js";
import { CHANGED_FILES_TOKEN, type GatePolicyClean } from "./gate-policy.js";
import {
  finalEvaluationFor,
  invalidateFinalEvaluationBaseline,
  loadRunState,
  recordFinalEvaluation,
} from "./run-state.js";
import { assertGateEvidenceReleasesEvaluation } from "./candidate-gate-phase.js";
import type { GateDeclaration, GateResult } from "./gate-runner.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(repo: string, path: string, contents: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf-8");
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--no-verify", "-m", message]);
}

/**
 * The production layout in miniature: a run root that owns the gate evidence and
 * the checkpoints, and a slice worktree under it whose feature base is `main` and
 * whose tip is the one approved candidate commit the accept seam hands the stage.
 *
 * Evidence lives *outside* the worktree on purpose. `runGates` restores its
 * candidate checkpoint with `git clean -fdxx`, which takes ignored files too, so
 * evidence written inside the gated tree is deleted mid-gate — the reason the
 * gauntlet slice put it in the orchestrator-owned run directory. The slice
 * artifact dir is tracked for the same reason: an untracked one would not
 * survive the first gate either.
 */
function makeRepo(): { root: string; repo: string; acceptedTreeId: string } {
  const root = mkdtempSync(join(tmpdir(), "afk-cleaner-stage-"));
  tempDirs.push(root);
  const repo = join(root, "worktree");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "afk@example.com"]);
  git(repo, ["config", "user.name", "AFK"]);
  write(repo, "README.md", "base\n");
  // The accepted contract pair a negotiated slice tree always carries, on the
  // feature base so the candidate is not diffed as having moved it: the round's
  // scope gate loads the manifest, and `feedback-integrity` reads the pair.
  write(repo, "slice/contract.md", "# contract\n");
  write(
    repo,
    "slice/acceptance-manifest.json",
    JSON.stringify({
      version: 2,
      fileScope: { kind: "paths", paths: ["src/thing.ts", "src/other.ts"] },
      migrationCount: 0,
      behaviors: [
        {
          id: "B-01",
          source: "cleaner stage fixture",
          given: "an accepted candidate",
          when: "the cleaner stage runs",
          then: "the declared clean gates decide the rounds",
          observableResult: "the stage outcome",
          preservation: false,
          gateIds: ["clean:format"],
        },
      ],
    }),
  );
  commitAll(repo, "base");
  git(repo, ["checkout", "-b", "slice-01"]);
  write(repo, "src/thing.ts", "export const thing = 1;\n");
  write(repo, "src/other.ts", "export const other = 2;\n");
  commitAll(repo, "feat(#87): the approved candidate");
  return { root, repo, acceptedTreeId: git(repo, ["rev-parse", "HEAD^{tree}"]) };
}

/**
 * A clean gate that passes exactly when `marker` exists in the gated tree. A
 * `node -e` script, per `finalEvaluationFixture`'s convention for a fake gate.
 */
function markerGate(
  id: string,
  marker: string,
  required = true,
): GatePolicyClean["gates"][number] {
  return {
    id,
    command: process.execPath,
    args: [
      "-e",
      `process.exit(require("fs").existsSync(${JSON.stringify(marker)}) ? 0 : 1)`,
    ],
    required,
    expectedCostMs: 500,
  };
}

/** A regression gate the stage runs but does not own, red when told to be. */
function regressionGate(id: string, red: () => boolean): GateDeclaration {
  return {
    id,
    stage: "deterministic",
    required: true,
    run: () =>
      red()
        ? {
            status: "FAIL" as const,
            failureKind: "COMMAND" as const,
            detail: `${id} went red`,
          }
        : { status: "PASS" as const, failureKind: null },
  };
}

interface Harness {
  result: CleanerStageResult;
  dispatches: CleanerDispatchInput[];
  recorded: CleanerRoundRecord[];
  outcomes: { outcome: string; rounds: number }[];
  /** Every `onInfrastructureRetry` message the gate phase emitted. */
  retries: string[];
  head: () => string;
  headTree: () => string;
  log: () => string[];
}

/**
 * Run the stage once against a fixture repo. `onDispatch` is the stub cleaner:
 * it writes, or throws, or escalates — whatever the round under test does.
 */
async function runStage(options: {
  root: string;
  repo: string;
  acceptedTreeId: string;
  clean?: GatePolicyClean;
  regressionDeclarations?: readonly GateDeclaration[];
  onDispatch?: (input: CleanerDispatchInput, repo: string) => void;
  roundLimit?: number;
  roundsAlreadySpent?: number;
  sliceDir?: string;
  acceptedPairIntact?: boolean;
  infrastructureRetries?: number;
  archiveRound?: CleanerStageContext["archiveRound"];
}): Promise<Harness> {
  const { root, repo, acceptedTreeId } = options;
  const dispatches: CleanerDispatchInput[] = [];
  const recorded: CleanerRoundRecord[] = [];
  const outcomes: { outcome: string; rounds: number }[] = [];
  const retries: string[] = [];
  const lines: string[] = [];
  const evidenceDir = join(root, ".afk", "evidence");
  const absSliceDir = join(repo, options.sliceDir ?? "slice");
  mkdirSync(absSliceDir, { recursive: true });

  const ctx: CleanerStageContext = {
    repoRoot: root,
    worktreeDir: repo,
    ghIssue: "87",
    sliceNumber: "01",
    relSliceDir: options.sliceDir ?? "slice",
    absSliceDir,
    featureRef: "main",
    dispatch: async (input) => {
      dispatches.push(input);
      options.onDispatch?.(input, repo);
    },
    recordRound: (record) => recorded.push(record),
    recordOutcome: (outcome, rounds) => outcomes.push({ outcome, rounds }),
    log: (message) => lines.push(message),
    ...(options.archiveRound ? { archiveRound: options.archiveRound } : {}),
    ...(options.roundsAlreadySpent !== undefined
      ? { roundsAlreadySpent: options.roundsAlreadySpent }
      : {}),
  };
  const input: CleanerStageInput = {
    ...(options.clean ? { clean: options.clean } : {}),
    acceptedTreeId,
    runPolicy: null,
    // Declared, because both detector gates refuse a tree they were never told
    // how to read — an undeclared detector is a FAIL, not a silent PASS.
    skipDetectors: [
      {
        id: "vitest-skip",
        testGlobs: ["src/**/*.test.ts"],
        patterns: ["it\\.skip\\("],
      },
    ],
    testFileGlobs: ["src/**/*.test.ts"],
    waivers: [],
    // The orchestrator's proven verdict at the accept seam: the pair still holds
    // the accepted bytes, which is why the candidate was accepted at all.
    acceptedPairIntact: options.acceptedPairIntact ?? true,
    regressionDeclarations: options.regressionDeclarations ?? [],
    gatePhase: {
      repoRoot: root,
      ghIssue: "87",
      sliceNumber: "01",
      tag: "s01",
      round: 2,
      evidenceDir,
      infrastructureRetries: options.infrastructureRetries ?? 0,
      inactivityTimeoutMs: 30_000,
      wallClockTimeoutMs: 60_000,
      heartbeatIntervalMs: 30_000,
      onGateOutcome: () => {},
      onInfrastructureRetry: (message) => retries.push(message),
    },
    checkpointDirFor: (round) =>
      join(root, ".afk", "checkpoints", `cleaner-a${round}`),
    disposeCheckpoint: (dir) => {
      git(repo, ["worktree", "remove", "--force", dir]);
    },
    ...(options.roundLimit !== undefined
      ? { roundLimit: options.roundLimit }
      : {}),
  };
  const result = await runCleanerStage(ctx, 2, input);
  return {
    result,
    dispatches,
    recorded,
    outcomes,
    retries,
    head: () => git(repo, ["rev-parse", "HEAD"]),
    headTree: () => git(repo, ["rev-parse", "HEAD^{tree}"]),
    log: () => lines,
  };
}

describe("cleanGateDeclarations", () => {
  it("[behavior:#87:B-02] expands {changedFiles} to one repo-relative argument per changed path", () => {
    const { repo } = makeRepo();
    const changedFiles = changedFilesForExpansion({
      cwd: repo,
      featureRef: "main",
    });
    expect(changedFiles).toEqual(["src/other.ts", "src/thing.ts"]);

    const [declaration] = cleanGateDeclarations({
      gates: [
        {
          id: "clean:format",
          command: "prettier",
          args: ["--check", CHANGED_FILES_TOKEN],
          required: true,
          expectedCostMs: 500,
        },
      ],
      changedFiles,
    });
    expect(declaration?.args).toEqual([
      "--check",
      "src/other.ts",
      "src/thing.ts",
    ]);
    expect(declaration?.stage).toBe(CLEAN_GATE_STAGE);
    expect(declaration?.command).toBe("prettier");
  });

  it(`[behavior:#87:B-02] records SKIPPED with detail "${NO_CHANGED_FILES_DETAIL}" when the expansion is empty`, async () => {
    const [declaration] = cleanGateDeclarations({
      gates: [
        {
          id: "clean:format",
          command: "prettier",
          args: ["--check", CHANGED_FILES_TOKEN],
          required: true,
          expectedCostMs: 500,
        },
      ],
      changedFiles: [],
    });
    // No command at all: a gate with nothing to read must not spawn a process
    // that would then be told to check the whole repository.
    expect(declaration?.command).toBeUndefined();
    expect(await declaration?.run?.({ treeId: "t", cwd: "." })).toEqual({
      status: "SKIPPED",
      failureKind: null,
      detail: NO_CHANGED_FILES_DETAIL,
    });
  });

  it("[behavior:#87:B-02] leaves an argument that merely contains the token alone", () => {
    const [declaration] = cleanGateDeclarations({
      gates: [
        {
          id: "clean:format",
          command: "prettier",
          args: [`--files=${CHANGED_FILES_TOKEN}`],
          required: true,
          expectedCostMs: 500,
        },
      ],
      changedFiles: ["src/thing.ts"],
    });
    expect(declaration?.args).toEqual([`--files=${CHANGED_FILES_TOKEN}`]);
  });
});

describe("runCleanerStage with no clean policy", () => {
  it("[behavior:#87:P-01] returns a disabled stage and dispatches nothing", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({ root, repo, acceptedTreeId });
    expect(harness.result).toEqual({
      ran: false,
      outcome: "DISABLED",
      inputTreeId: acceptedTreeId,
      outputTreeId: acceptedTreeId,
      roundsSpent: 0,
    });
    expect(harness.dispatches).toEqual([]);
    // No stage entry is written either: the seam is never called, so a
    // `clean`-less run's run state gains no `qualityStages` member.
    expect(harness.outcomes).toEqual([]);
    expect(harness.recorded).toEqual([]);
  });

  it("[behavior:#87:B-03] returns exactly the five fields that describe a stage, ran or not", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const disabled = await runStage({ root, repo, acceptedTreeId });
    const ran = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: {
        gates: [markerGate("clean:format", "README.md")],
        additionalWriteScope: ["notes.md"],
        suppressionDetectors: [
      { id: "ts-ignore", globs: ["src/**/*.ts"], patterns: ["@ts-ignore"] },
    ],
      },
    });
    expect(Object.keys(disabled.result).sort()).toEqual([
      "inputTreeId",
      "outcome",
      "outputTreeId",
      "ran",
      "roundsSpent",
    ]);
    expect(Object.keys(ran.result).sort()).toEqual([
      "inputTreeId",
      "outcome",
      "outputTreeId",
      "ran",
      "roundsSpent",
    ]);
    expect(disabled.result.ran).toBe(false);
    expect(ran.result.ran).toBe(true);
  });
});

describe("runCleanerStage round 0", () => {
  it("[behavior:#87:B-04] releases the accepted tree with zero invocations when the clean gate passes", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: {
        // Passes: `README.md` exists in the accepted tree.
        gates: [markerGate("clean:format", "README.md")],
        additionalWriteScope: ["notes.md"],
        suppressionDetectors: [
      { id: "ts-ignore", globs: ["src/**/*.ts"], patterns: ["@ts-ignore"] },
    ],
      },
    });
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.result.roundsSpent).toBe(0);
    expect(harness.result.inputTreeId).toBe(harness.result.outputTreeId);
    expect(harness.dispatches).toEqual([]);
    expect(harness.outcomes).toEqual([{ outcome: "PASS", rounds: 0 }]);
  });

  it("[behavior:#87:B-04] treats a required gate's empty-expansion SKIPPED as a release", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    // The candidate commit is reverted, so the tree matches the feature base and
    // `{changedFiles}` expands to nothing.
    git(repo, ["reset", "--hard", "HEAD~1"]);
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId: git(repo, ["rev-parse", "HEAD^{tree}"]),
      clean: {
        gates: [
          {
            id: "clean:format",
            command: "definitely-not-a-command",
            args: [CHANGED_FILES_TOKEN],
            required: true,
            expectedCostMs: 500,
          },
        ],
        additionalWriteScope: ["notes.md"],
        suppressionDetectors: [
      { id: "ts-ignore", globs: ["src/**/*.ts"], patterns: ["@ts-ignore"] },
    ],
      },
    });
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.result.roundsSpent).toBe(0);
    expect(harness.dispatches).toEqual([]);
  });
});

describe("runCleanerStage rounds", () => {
  const cleanPolicy = (required = true): GatePolicyClean => ({
    gates: [markerGate("clean:format", "cleaned.txt", required)],
    additionalWriteScope: ["cleaned.txt", "notes.md", "round-1.txt"],
    suppressionDetectors: [
      { id: "ts-ignore", globs: ["src/**/*.ts"], patterns: ["@ts-ignore"] },
    ],
  });

  it("[behavior:#87:B-06] dispatches with the failure detail, sweeps the round into a commit, and passes on the repaired tree", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const regression = regressionGate("tests:sanity", () => false);
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      regressionDeclarations: [regression],
      onDispatch: (_input, cwd) => write(cwd, "cleaned.txt", "clean\n"),
    });
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.result.roundsSpent).toBe(1);
    expect(harness.dispatches).toHaveLength(1);
    const [dispatch] = harness.dispatches;
    expect(dispatch?.round).toBe(1);
    expect(dispatch?.roundLimit).toBe(MAX_CLEANER_ROUNDS);
    expect(dispatch?.baselineTreeId).toBe(acceptedTreeId);
    expect(dispatch?.inputTreeId).toBe(acceptedTreeId);
    expect(dispatch?.regressionNote).toBe("");
    expect(dispatch?.qualityFailures.map((f) => f.gateId)).toEqual([
      "clean:format",
    ]);
    expect(dispatch?.qualityFailures[0]?.status).toBe("FAIL");
    expect(dispatch?.qualityFailures[0]?.logArtifactId).toMatch(
      /clean:format|clean-format|\.log$/,
    );
    // The sweep commit: the gate has to be about a committed tree.
    expect(git(repo, ["log", "--format=%s", "-1"])).toBe(
      "chore(#87): cleaner round 1",
    );
    // Every gate the round ran, in the order the module declares them.
    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]?.gateIds).toEqual([
      "clean:format",
      "scope",
      "feedback-integrity",
      "tests:skipped",
      "suppressions",
      "tests:sanity",
    ]);
    expect(harness.recorded[0]?.outcome).toBe("PASS");
    expect(harness.recorded[0]?.attempt).toBe(2);
    expect(harness.result.outputTreeId).not.toBe(acceptedTreeId);
  });

  it("[behavior:#87:B-07] reverts a round that reddens the regression bundle and carries a regression note into the next round", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    let round = 0;
    // Red on round 1's checkpoint only, so round 2 can proceed from the input.
    const regression = regressionGate("tests:sanity", () => round === 1);
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      regressionDeclarations: [regression],
      onDispatch: (input, cwd) => {
        round = input.round;
        write(cwd, "cleaned.txt", `round ${input.round}\n`);
      },
    });
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.recorded[0]?.outcome).toBe("REVERTED");
    expect(harness.recorded[0]?.gateIds).toContain("tests:sanity");
    // One reset target, one recorded outcome: the round's writes are gone.
    expect(harness.dispatches[1]?.inputTreeId).toBe(acceptedTreeId);
    expect(harness.dispatches[1]?.regressionNote).toContain("tests:sanity");
    expect(harness.dispatches[1]?.regressionNote).toContain(
      "git reset --hard",
    );
    expect(harness.dispatches[1]?.regressionNote).toContain(acceptedTreeId);
  });

  it("[behavior:#87:B-07] resets to the round's input checkpoint and records FAIL when the dispatch throws", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const acceptedCommit = git(repo, ["rev-parse", "HEAD"]);
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      roundLimit: 1,
      onDispatch: (_input, cwd) => {
        write(cwd, "half-finished.txt", "the round died here\n");
        throw new Error("the provider died");
      },
    });
    expect(harness.head()).toBe(acceptedCommit);
    expect(existsSync(join(repo, "half-finished.txt"))).toBe(false);
    expect(harness.recorded).toEqual([
      {
        round: 1,
        attempt: 2,
        inputTreeId: acceptedTreeId,
        gateIds: [],
        outcome: "FAIL",
      },
    ]);
    // A dispatch that died still spends its round: a free retry is how a broken
    // dispatch loops forever.
    expect(harness.result.roundsSpent).toBe(1);
    expect(harness.result.outcome).toBe("EXHAUSTED");
  });

  it("[behavior:#87:B-07] resets to the round's input checkpoint, records ESCALATION_MALFORMED and gates nothing when the escalation is malformed", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const acceptedCommit = git(repo, ["rev-parse", "HEAD"]);
    let gateRuns = 0;
    const regression: GateDeclaration = {
      id: "tests:sanity",
      stage: "deterministic",
      required: true,
      run: () => {
        gateRuns++;
        return { status: "PASS" as const, failureKind: null };
      },
    };
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      regressionDeclarations: [regression],
      roundLimit: 1,
      onDispatch: (_input, cwd) => {
        write(
          cwd,
          `slice/${CLEANER_ESCALATION_FILENAME}`,
          `${JSON.stringify({
            version: 1,
            class: "BASELINE_IS_WRONG",
            id: "CL-01",
            summary: "",
            evidence: "e",
            expected: "x",
            observed: "o",
          })}\n`,
        );
      },
    });
    expect(harness.head()).toBe(acceptedCommit);
    expect(harness.recorded).toEqual([
      {
        round: 1,
        attempt: 2,
        inputTreeId: acceptedTreeId,
        gateIds: [],
        outcome: "ESCALATION_MALFORMED",
      },
    ]);
    // The discarded checkpoint is never gated, so no second outcome exists.
    expect(gateRuns).toBe(0);
    expect(harness.result.outcome).toBe("EXHAUSTED");
  });

  it("[behavior:#87:B-13] resets to the accepted tree — not round 1's output — when round 2 escalates", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const acceptedCommit = git(repo, ["rev-parse", "HEAD"]);
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      onDispatch: (input, cwd) => {
        if (input.round === 1) {
          // A real round-1 commit the stage keeps, so the round-2 reset has two
          // candidate targets and has to pick the accepted one.
          write(cwd, "round-1.txt", "partial clean-up\n");
          return;
        }
        write(
          cwd,
          `slice/${CLEANER_ESCALATION_FILENAME}`,
          `${JSON.stringify({
            version: 1,
            class: "BASELINE_IS_WRONG",
            id: "CL-01",
            summary: "the approved candidate formats its own output",
            evidence: "clean:format output",
            expected: "the formatter's shape",
            observed: "the approved shape",
          })}\n`,
        );
      },
    });
    expect(harness.dispatches).toHaveLength(2);
    expect(harness.dispatches[1]?.inputTreeId).not.toBe(acceptedTreeId);
    expect(harness.head()).toBe(acceptedCommit);
    expect(harness.headTree()).toBe(acceptedTreeId);
    expect(existsSync(join(repo, "round-1.txt"))).toBe(false);
    expect(harness.result.outcome).toBe("ESCALATED");
    expect(harness.result.outputTreeId).toBe(acceptedTreeId);
    expect(harness.result.escalation?.id).toBe("CL-01");
    expect(harness.recorded[1]?.outcome).toBe("ESCALATED");
    expect(harness.outcomes).toEqual([{ outcome: "ESCALATED", rounds: 2 }]);
  });

  it("[behavior:#87:B-13] carries the archived escalation as the finding's artifactReference, and invalidates the accepted tree's baseline citation", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const archived = "runs/run-1/reviews/cleaner-review-r2-a2.json";
    const archiveCalls: { round: number; hasEscalation: boolean }[] = [];
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      archiveRound: (call) => {
        archiveCalls.push(call);
        return call.hasEscalation ? { escalationArtifactId: archived } : {};
      },
      onDispatch: (input, cwd) => {
        if (input.round === 1) {
          write(cwd, "round-1.txt", "partial clean-up\n");
          return;
        }
        write(
          cwd,
          `slice/${CLEANER_ESCALATION_FILENAME}`,
          `${JSON.stringify({
            version: 1,
            class: "BASELINE_IS_WRONG",
            id: "CL-02",
            summary: "the approved candidate formats its own output",
            evidence: "clean:format output",
            expected: "the formatter's shape",
            observed: "the approved shape",
          })}\n`,
        );
      },
    });
    // The round is archived before anything resets it, and the escalating round
    // is the only one that names an escalation.
    expect(archiveCalls).toEqual([
      { round: 1, hasEscalation: false },
      { round: 2, hasEscalation: true },
    ]);
    expect(harness.result.outcome).toBe("ESCALATED");
    expect(harness.result.escalationArtifactId).toBe(archived);

    // The generator failure set the orchestrator builds from this result: the
    // finding is the escalation, and its one artifact reference is the archived
    // copy — the round's own file is gone with the reset, so citing the live
    // path would point the generator at nothing.
    const finding = {
      id: harness.result.escalation!.id,
      clearCondition: harness.result.escalation!.expected,
      artifactReferences: harness.result.escalationArtifactId
        ? [harness.result.escalationArtifactId]
        : [`slice/${CLEANER_ESCALATION_FILENAME}`],
    };
    expect(finding).toEqual({
      id: "CL-02",
      clearCondition: "the formatter's shape",
      artifactReferences: [archived],
    });
    expect(existsSync(join(repo, "slice", CLEANER_ESCALATION_FILENAME))).toBe(
      false,
    );

    // And the accepted tree's baseline citation is invalidated, exactly as a
    // final-evaluation RETURN_TO_GENERATOR invalidates the tree it graded. The
    // orchestrator's own call site is read off the spawned "a clean policy
    // escalates, then repairs the re-approved tree" scenario; what is asserted
    // here is that the stage's accepted tree is the right argument for it.
    const slug = "afk-v2-quality-loops";
    recordFinalEvaluation(root, slug, "87", {
      decision: "evaluate",
      finalTreeId: acceptedTreeId,
      baselineTreeId: acceptedTreeId,
      attempts: [
        {
          attempt: 1,
          candidateTreeId: acceptedTreeId,
          verdict: "PASS",
          outcome: "GRADED",
        },
      ],
      invalidatedCandidateTreeIds: [],
    });
    invalidateFinalEvaluationBaseline(
      root,
      slug,
      "87",
      harness.result.outputTreeId,
    );
    const view = finalEvaluationFor(loadRunState(root, slug), "87");
    expect(view?.invalidatedCandidateTreeIds).toEqual([acceptedTreeId]);
    // The attempt that graded that tree survives, marked invalidated: what the
    // return changes is what the tree means, not whether it was graded.
    expect(view?.attempts).toEqual([
      {
        attempt: 1,
        candidateTreeId: acceptedTreeId,
        verdict: "PASS",
        outcome: "GRADED",
        invalidated: true,
      },
    ]);
  });

  it("[behavior:#87:B-05] grants exactly MAX_CLEANER_ROUNDS rounds and compares against the remainder", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      // The stub never writes the marker, so the gate stays red throughout.
      onDispatch: (_input, cwd) => write(cwd, "notes.md", `${Date.now()}\n`),
    });
    expect(harness.dispatches.map((d) => d.round)).toEqual([1, 2, 3]);
    expect(MAX_CLEANER_ROUNDS).toBe(3);
    expect(harness.result.roundsSpent).toBe(MAX_CLEANER_ROUNDS);
    expect(harness.result.outcome).toBe("EXHAUSTED");
  });

  it("[behavior:#87:B-05] spends no round on an INFRASTRUCTURE retry: the dispatch count is unchanged", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    let sanityRuns = 0;
    // Red the way a machine is red, not the way a tree is: the first run of the
    // round's regression bundle reports INFRASTRUCTURE, which
    // `runCandidateGatePhase` retries in place. The retry is a second *gate*
    // attempt, never a second cleaner round — a round is what a dispatch costs.
    const flaky: GateDeclaration = {
      id: "tests:sanity",
      stage: "deterministic",
      required: true,
      run: () => {
        sanityRuns++;
        return sanityRuns === 1
          ? {
              // `null`, because only a FAIL carries a failure kind: an
              // INFRASTRUCTURE status is a report about the machine, and
              // `isGateResult` refuses evidence that says otherwise.
              status: "INFRASTRUCTURE" as const,
              failureKind: null,
              detail: "the runner could not read the world",
            }
          : { status: "PASS" as const, failureKind: null };
      },
    };
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      regressionDeclarations: [flaky],
      infrastructureRetries: 1,
      onDispatch: (_input, cwd) => write(cwd, "cleaned.txt", "clean\n"),
    });
    expect(sanityRuns).toBe(2);
    expect(harness.retries).toHaveLength(1);
    // One dispatch, one spent round, and the retried attempt's PASS is what the
    // round is decided on — an INFRASTRUCTURE status never reverts the round.
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.result.roundsSpent).toBe(1);
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]?.outcome).toBe("PASS");
  });

  it("[behavior:#87:B-08] runs the next round from the previous round's output tree when a required clean gate is still red", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      regressionDeclarations: [regressionGate("tests:sanity", () => false)],
      onDispatch: (input, cwd) => {
        // Round 1 writes something real but does not clear the gate; round 2
        // clears it. The regression bundle is green throughout, so round 1's
        // checkpoint stands even though its clean gate stayed red.
        if (input.round === 1) {
          write(cwd, "round-1.txt", "partial clean-up\n");
          return;
        }
        write(cwd, "cleaned.txt", "clean\n");
      },
    });
    expect(harness.dispatches).toHaveLength(2);
    const round1Output = harness.recorded[0]?.outputTreeId;
    expect(harness.recorded[0]?.outcome).toBe("FAIL");
    expect(round1Output).toBeDefined();
    expect(round1Output).not.toBe(acceptedTreeId);
    // The next round starts from that tree, not from the accepted one: a green
    // bundle means nothing was reverted, so the partial clean-up is kept.
    expect(harness.dispatches[1]?.inputTreeId).toBe(round1Output);
    expect(harness.dispatches[1]?.baselineTreeId).toBe(acceptedTreeId);
    expect(harness.dispatches[1]?.regressionNote).toBe("");
    expect(existsSync(join(repo, "round-1.txt"))).toBe(true);
    expect(harness.result.outcome).toBe("PASS");
    expect(harness.result.roundsSpent).toBe(2);
    expect(harness.result.outputTreeId).toBe(harness.recorded[1]?.outputTreeId);
  });

  it("[behavior:#87:B-05] grants no round at all when the run state says the budget is spent", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      roundsAlreadySpent: MAX_CLEANER_ROUNDS,
      onDispatch: (_input, cwd) => write(cwd, "cleaned.txt", "clean\n"),
    });
    // The continuation is a comparison against the remainder, not an
    // incremented counter, so a resumed run cannot buy a fourth round.
    expect(harness.dispatches).toEqual([]);
    expect(harness.result.outcome).toBe("EXHAUSTED");
    expect(harness.result.roundsSpent).toBe(MAX_CLEANER_ROUNDS);
  });

  it("[behavior:#87:B-08] returns EXHAUSTED naming every remaining red gate with its detail and log artifact id", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    const harness = await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: {
        gates: [
          markerGate("clean:format", "cleaned.txt"),
          // Optional and red throughout: it never blocks and never appears in
          // the blocking set.
          markerGate("clean:lint", "linted.txt", false),
        ],
        additionalWriteScope: ["notes.md"],
        suppressionDetectors: [
      { id: "ts-ignore", globs: ["src/**/*.ts"], patterns: ["@ts-ignore"] },
    ],
      },
      onDispatch: (_input, cwd) => write(cwd, "notes.md", `${Date.now()}\n`),
    });
    expect(harness.dispatches).toHaveLength(3);
    expect(harness.result.outcome).toBe("EXHAUSTED");
    const remaining = harness.result.remainingFailures ?? [];
    expect(remaining.map((failure) => failure.gateId)).toEqual([
      "clean:format",
    ]);
    expect(remaining[0]?.detail).not.toBe("");
    expect(remaining[0]?.logArtifactId).toMatch(/\.log$/);
    // The optional gate is recorded as a round gate id and nothing more.
    expect(harness.recorded[2]?.gateIds).toContain("clean:lint");
    expect(harness.outcomes).toEqual([{ outcome: "EXHAUSTED", rounds: 3 }]);

    const reason = cleanerExhaustionReason({
      ghIssue: "87",
      roundsSpent: harness.result.roundsSpent,
      failures: remaining,
      treeId: harness.result.outputTreeId,
    });
    expect(reason).toContain("clean:format");
    expect(reason).toContain(remaining[0]!.logArtifactId);
    expect(reason).toContain("The last checkpoint is preserved.");
  });

  it("[behavior:#87:P-08] writes no approved-baseline.json of its own", async () => {
    const { root, repo, acceptedTreeId } = makeRepo();
    await runStage({
      root,
      repo,
      acceptedTreeId,
      clean: cleanPolicy(),
      onDispatch: (_input, cwd) => write(cwd, "cleaned.txt", "clean\n"),
    });
    expect(existsSync(join(repo, "slice", "approved-baseline.json"))).toBe(
      false,
    );
    expect(git(repo, ["log", "--format=%s"])).not.toContain(
      "approved-baseline",
    );
  });

  it("[behavior:#87:P-04] leaves assertGateEvidenceReleasesEvaluation's verdicts untouched and does not route a round through it", async () => {
    // The helper is not in this slice's file scope; this pins the behavior the
    // cleaner deliberately does not reuse — its round decision is computed from
    // the round's own gate results.
    const result: GateResult = {
      gateId: "clean:format",
      stage: CLEAN_GATE_STAGE,
      status: "SKIPPED",
      failureKind: null,
      startedAt: "2026-09-13T00:00:00.000Z",
      endedAt: "2026-09-13T00:00:00.000Z",
      durationMs: 0,
      exitCode: null,
      treeId: "t1",
      logArtifactId: "clean-format.log",
    };
    const declaration: GateDeclaration = {
      id: "clean:format",
      stage: CLEAN_GATE_STAGE,
      required: true,
      command: "prettier",
    };
    const evidence = {
      version: 4 as const,
      attemptId: "a1",
      treeId: "t1",
      results: [result],
    };
    // A required SKIPPED does not release an *evaluation*. The cleaner's round 0
    // releases on exactly that (B-04, the empty `{changedFiles}` expansion), so
    // it cannot be routed through this helper — and this helper's verdict must
    // stay as it was for the paths that do use it.
    expect(() =>
      assertGateEvidenceReleasesEvaluation(evidence, [declaration], "t1"),
    ).toThrow(/does not release evaluation/);
    expect(() =>
      assertGateEvidenceReleasesEvaluation(
        { ...evidence, results: [{ ...result, status: "PASS" }] },
        [declaration],
        "t1",
      ),
    ).not.toThrow();
    expect(() =>
      assertGateEvidenceReleasesEvaluation(
        { ...evidence, results: [{ ...result, status: "FAIL" }] },
        [{ ...declaration, required: false }],
        "t1",
      ),
    ).not.toThrow();
  });
});

describe("parseCleanerEscalation", () => {
  const valid = {
    version: 1,
    class: "BASELINE_IS_WRONG",
    id: "CL-01",
    summary: "the approved candidate has to change",
    evidence: "clean:format output",
    expected: "what the clean gate requires",
    observed: "what the approved tree does",
  };

  it("[behavior:#87:B-13] accepts a well-formed escalation", () => {
    expect(parseCleanerEscalation(JSON.stringify(valid))).toEqual(valid);
  });

  it("[behavior:#87:B-13] refuses an unknown key, the wrong class, a blank field and a duplicate key", () => {
    expect(() =>
      parseCleanerEscalation(JSON.stringify({ ...valid, extra: 1 })),
    ).toThrow(/must contain exactly/);
    expect(() =>
      parseCleanerEscalation(JSON.stringify({ ...valid, class: "OTHER" })),
    ).toThrow(/BASELINE_IS_WRONG/);
    expect(() =>
      parseCleanerEscalation(JSON.stringify({ ...valid, observed: "  " })),
    ).toThrow(/observed/);
    expect(() =>
      parseCleanerEscalation(JSON.stringify({ ...valid, version: 2 })),
    ).toThrow(/version/);
    expect(() =>
      parseCleanerEscalation(
        `{"version":1,"version":1,"class":"BASELINE_IS_WRONG","id":"CL-01",` +
          `"summary":"s","evidence":"e","expected":"x","observed":"o"}`,
      ),
    ).toThrow(/twice/);
    expect(() => parseCleanerEscalation("not json")).toThrow(/valid JSON/);
  });
});
