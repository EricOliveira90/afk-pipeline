import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CleanerStageResult } from "./cleaner-stage.js";
import {
  createCleanerOrchestrationSession,
  type CleanerOrchestrationSession,
} from "./cleaner-orchestration.js";
import type { FinalReviewFinding } from "./final-evaluation.js";
import { RunJournal } from "./run-journal.js";
import {
  finalEvaluationFor,
  loadRunState,
  recordFinalEvaluation,
} from "./run-state.js";

const runCleanerStageMock = vi.hoisted(() => vi.fn());

vi.mock("./cleaner-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cleaner-stage.js")>();
  return { ...actual, runCleanerStage: runCleanerStageMock };
});

const RUN_SLUG = "cleaner-orchestration-test";
const tempDirs: string[] = [];
const stageResults: CleanerStageResult[] = [];

beforeEach(() => {
  stageResults.length = 0;
  runCleanerStageMock.mockReset();
  runCleanerStageMock.mockImplementation(async () => {
    const result = stageResults.shift();
    if (!result) throw new Error("No queued cleaner-stage result");
    return result;
  });
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  commitTracked(repo, message);
}

function commitTracked(repo: string, message: string): void {
  git(repo, [
    "-c",
    "user.name=AFK",
    "-c",
    "user.email=afk@example.com",
    "commit",
    "-a",
    "--no-verify",
    "-m",
    message,
  ]);
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "afk-cleaner-orchestration-"));
  tempDirs.push(root);
  mkdirSync(join(root, "slice"), { recursive: true });
  return root;
}

function makeResetRepo(): {
  root: string;
  repo: string;
  acceptedCommit: string;
  acceptedTreeId: string;
  cleanerCommit: string;
  cleanerTreeId: string;
} {
  const root = makeTempRoot();
  const repo = join(root, "worktree");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "accepted.txt"), "accepted\n", "utf-8");
  commit(repo, "accepted");
  const [acceptedCommit, acceptedTreeId] = git(repo, [
    "rev-parse",
    "HEAD",
    "HEAD^{tree}",
  ]).split(/\r?\n/);

  writeFileSync(join(repo, "accepted.txt"), "cleaner output\n", "utf-8");
  commitTracked(repo, "cleaner");
  const [cleanerCommit, cleanerTreeId] = git(repo, [
    "rev-parse",
    "HEAD",
    "HEAD^{tree}",
  ]).split(/\r?\n/);
  writeFileSync(join(repo, "untracked.txt"), "discard me\n", "utf-8");

  return {
    root,
    repo,
    acceptedCommit: acceptedCommit!,
    acceptedTreeId: acceptedTreeId!,
    cleanerCommit: cleanerCommit!,
    cleanerTreeId: cleanerTreeId!,
  };
}

function makeSession(input: {
  root: string;
  repo: string;
  acceptedTreeId: string;
  acceptedCommit: string | null;
}): CleanerOrchestrationSession {
  const logger = new RunJournal(input.root, RUN_SLUG);
  return createCleanerOrchestrationSession({
    run: {
      repoRoot: input.root,
      runSlug: RUN_SLUG,
      prdSlug: "afk-v2-quality-loops",
      reviewArchiveDir: join(logger.runDir, "reviews"),
      logger,
    },
    slice: {
      ghIssue: "87",
      number: "01",
      tag: "s01",
      worktreeDir: input.repo,
      relSliceDir: "slice",
      absSliceDir: join(input.root, "slice"),
      featureRef: "main",
    },
    generatorRound: 1,
    accepted: {
      treeId: input.acceptedTreeId,
      commitSha: input.acceptedCommit,
    },
    invoke: async () => {
      throw new Error("The mocked cleaner stage must not invoke an agent");
    },
    invocationBounds: {},
    stageInput: {
      runPolicy: null,
      skipDetectors: [],
      testFileGlobs: [],
      waivers: [],
      acceptedPairIntact: true,
      regressionDeclarations: [],
      gatePhase: {
        repoRoot: input.root,
        ghIssue: "87",
        sliceNumber: "01",
        tag: "s01",
        round: 1,
        evidenceDir: join(input.root, ".afk", "evidence"),
        infrastructureRetries: 0,
        inactivityTimeoutMs: 30_000,
        wallClockTimeoutMs: 60_000,
        heartbeatIntervalMs: 30_000,
      },
    },
  });
}

const restoreFinding: FinalReviewFinding = {
  id: "F-RESTORE",
  class: "PRESERVATION",
  summary: "the approved behavior was removed by the cleaner",
  evidence: "src/thing.ts:1",
  expected: "the approved behavior remains",
  observed: "the behavior is absent",
  repair: "RESTORE",
};

describe("createCleanerOrchestrationSession terminal RESTORE policy", () => {
  it("[behavior:#87:B-08] returns STUCK with still-red gate evidence when a RESTORE exhausts the cleaner", async () => {
    const root = makeTempRoot();
    const acceptedTreeId = "accepted-tree";
    const cleanerTreeId = "cleaner-tree";
    const exhaustedTreeId = "restore-exhausted-tree";
    const remainingFailure = {
      gateId: "clean:format",
      status: "FAIL" as const,
      detail: "formatter still rejects src/thing.ts",
      logArtifactId: ".afk/evidence/clean-format.log",
      required: true,
    };
    stageResults.push(
      {
        ran: true,
        outcome: "PASS",
        inputTreeId: acceptedTreeId,
        outputTreeId: cleanerTreeId,
        roundsSpent: 2,
      },
      {
        ran: true,
        outcome: "EXHAUSTED",
        inputTreeId: cleanerTreeId,
        outputTreeId: exhaustedTreeId,
        roundsSpent: 3,
        remainingFailures: [remainingFailure],
      },
    );
    const session = makeSession({
      root,
      repo: root,
      acceptedTreeId,
      acceptedCommit: null,
    });

    expect((await session.advance({ kind: "INITIAL" })).kind).toBe("PROCEED");
    const decision = await session.advance({
      kind: "RESTORE",
      findings: [restoreFinding],
      discardArtifacts: [],
    });

    expect(decision).toEqual({
      kind: "STUCK",
      result: {
        ran: true,
        outcome: "EXHAUSTED",
        inputTreeId: acceptedTreeId,
        outputTreeId: exhaustedTreeId,
        roundsSpent: 3,
        remainingFailures: [remainingFailure],
      },
      reason:
        "The cleaner stage for slice #87 spent all 3 round(s) with required " +
        "clean gate(s) still red on restore-exhausted-tree: clean:format " +
        "(FAIL): formatter still rejects src/thing.ts " +
        "[log: .afk/evidence/clean-format.log] The last checkpoint is preserved.",
      artifactReferences: [".afk/evidence/clean-format.log"],
    });
  });

  it("[behavior:#87:B-13] returns the generator failure set after a RESTORE escalation and resets the accepted range", async () => {
    const fixture = makeResetRepo();
    const escalationArtifactId =
      ".afk/logs/quality/reviews/cleaner-review-r1-a3.json";
    stageResults.push(
      {
        ran: true,
        outcome: "PASS",
        inputTreeId: fixture.acceptedTreeId,
        outputTreeId: fixture.cleanerTreeId,
        roundsSpent: 2,
      },
      {
        ran: true,
        outcome: "ESCALATED",
        inputTreeId: fixture.cleanerTreeId,
        outputTreeId: fixture.cleanerTreeId,
        roundsSpent: 3,
        escalation: {
          version: 1,
          class: "BASELINE_IS_WRONG",
          id: "CL-RESTORE",
          summary: "the accepted candidate conflicts with the clean policy",
          evidence: "clean:format output",
          expected: "the formatter-approved shape",
          observed: "the accepted shape",
        },
        escalationArtifactId,
      },
    );
    recordFinalEvaluation(fixture.root, RUN_SLUG, "87", {
      decision: "evaluate",
      finalTreeId: fixture.cleanerTreeId,
      baselineTreeId: fixture.acceptedTreeId,
      baselineArtifactPath: "slice/approved-baseline.json",
      attempts: [],
      invalidatedCandidateTreeIds: [],
    });
    const session = makeSession({
      root: fixture.root,
      repo: fixture.repo,
      acceptedTreeId: fixture.acceptedTreeId,
      acceptedCommit: fixture.acceptedCommit,
    });

    expect((await session.advance({ kind: "INITIAL" })).kind).toBe("PROCEED");
    const decision = await session.advance({
      kind: "RESTORE",
      findings: [restoreFinding],
      discardArtifacts: [],
    });

    expect(decision.kind).toBe("RETURN_TO_GENERATOR");
    if (decision.kind !== "RETURN_TO_GENERATOR") return;
    expect(decision.failureSet).toEqual({
      findings: [
        {
          id: "CL-RESTORE",
          clearCondition: "the formatter-approved shape",
          artifactReferences: [escalationArtifactId],
        },
      ],
      gates: [],
    });
    expect(decision.retryNote).toBe(
      "The cleaner escalated the approved baseline: CL-RESTORE: the accepted " +
        "candidate conflicts with the clean policy Expected: the " +
        "formatter-approved shape Observed: the accepted shape",
    );
    const finalEvaluation = finalEvaluationFor(
      loadRunState(fixture.root, RUN_SLUG),
      "87",
    );
    expect(finalEvaluation?.baselineTreeId).toBeUndefined();
    expect(finalEvaluation?.invalidatedCandidateTreeIds).toEqual([
      fixture.acceptedTreeId,
    ]);
    expect(fixture.cleanerCommit).not.toBe(fixture.acceptedCommit);
    expect(
      git(fixture.repo, ["rev-parse", "HEAD", "HEAD^{tree}"]).split(/\r?\n/),
    ).toEqual([fixture.acceptedCommit, fixture.acceptedTreeId]);
    expect(readFileSync(join(fixture.repo, "accepted.txt"), "utf-8")).toBe(
      "accepted\n",
    );
    expect(existsSync(join(fixture.repo, "untracked.txt"))).toBe(false);
  });
});
