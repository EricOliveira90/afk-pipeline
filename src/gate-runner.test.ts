import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveBaseGateDeclarations } from "./base-gates.js";
import { runCandidateGatePhase } from "./candidate-gate-phase.js";
import {
  createCandidateCheckpoint,
  readGateEvidence,
  runGates,
  verifyGateEvidence,
  GATE_EVIDENCE_VERSION,
  type GateDeclaration,
  type GateFindings,
} from "./gate-runner.js";
import { rmDirWithRetry } from "./test-support.js";

const dirs: string[] = [];
const ordinaryInactivityTimeoutMs = 15_000;
const ordinaryWallClockTimeoutMs = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeCheckpoint(
  files: Record<string, string> = { "tracked.txt": "candidate" },
) {
  const root = mkdtempSync(join(tmpdir(), "afk-gates-"));
  dirs.push(root);
  const cwd = join(root, "checkpoint");
  mkdirSync(cwd);
  git(cwd, ["init", "--initial-branch=main"]);
  const hooksDir = join(cwd, ".git", "test-hooks");
  mkdirSync(hooksDir);
  git(cwd, ["config", "core.hooksPath", hooksDir]);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(cwd, name), content, "utf-8");
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "candidate"]);
  return {
    root,
    cwd,
    evidenceDir: join(root, "evidence"),
    treeId: git(cwd, ["rev-parse", "HEAD^{tree}"]),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmDirWithRetry(dir);
  }
});

describe("createCandidateCheckpoint", () => {
  it("captures generator output without advancing the source branch", () => {
    const { root, cwd } = makeCheckpoint();
    const sourceHead = git(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "tracked.txt"), "generated", "utf-8");
    writeFileSync(join(cwd, "untracked.txt"), "included", "utf-8");

    const checkpoint = createCandidateCheckpoint(
      cwd,
      join(root, "detached-checkpoint"),
    );

    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(checkpoint.commitSha).not.toBe(sourceHead);
    expect(checkpoint.treeId).toBe(
      git(checkpoint.worktreeDir, ["rev-parse", "HEAD^{tree}"]),
    );
    expect(
      readFileSync(join(checkpoint.worktreeDir, "tracked.txt"), "utf-8"),
    ).toBe("generated");
    expect(
      readFileSync(join(checkpoint.worktreeDir, "untracked.txt"), "utf-8"),
    ).toBe("included");

    writeFileSync(join(cwd, "tracked.txt"), "later mutation", "utf-8");
    expect(
      readFileSync(join(checkpoint.worktreeDir, "tracked.txt"), "utf-8"),
    ).toBe("generated");
  });

  it("identifies an immutable checkpoint without materializing a checkout", () => {
    const { root, cwd } = makeCheckpoint();
    writeFileSync(join(cwd, "tracked.txt"), "generated", "utf-8");
    const checkpointDir = join(root, "detached-checkpoint");

    const checkpoint = createCandidateCheckpoint(cwd, checkpointDir, {
      materialize: false,
    });

    expect(checkpoint.worktreeDir).toBeUndefined();
    expect(existsSync(checkpointDir)).toBe(false);
    expect(git(cwd, ["rev-parse", `${checkpoint.commitSha}^{tree}`])).toBe(
      checkpoint.treeId,
    );

    writeFileSync(join(cwd, "tracked.txt"), "later mutation", "utf-8");
    expect(git(cwd, ["rev-parse", `${checkpoint.commitSha}^{tree}`])).toBe(
      checkpoint.treeId,
    );
  });

  it.runIf(process.platform === "win32")(
    "captures an unmaterialized checkpoint with bounded Git process fanout",
    () => {
      const { root, cwd } = makeCheckpoint();
      writeFileSync(join(cwd, "tracked.txt"), "staged", "utf-8");
      git(cwd, ["add", "tracked.txt"]);
      writeFileSync(join(cwd, "tracked.txt"), "generated", "utf-8");
      writeFileSync(join(cwd, "untracked.txt"), "included", "utf-8");

      const invocationLog = join(root, "git-invocations.log");

      const originalTrace = process.env.GIT_TRACE2_EVENT;
      let checkpoint;
      try {
        process.env.GIT_TRACE2_EVENT = invocationLog;
        checkpoint = createCandidateCheckpoint(
          cwd,
          join(root, "detached-checkpoint"),
          { materialize: false },
        );
      } finally {
        if (originalTrace == null) {
          delete process.env.GIT_TRACE2_EVENT;
        } else {
          process.env.GIT_TRACE2_EVENT = originalTrace;
        }
      }

      const invocations = readFileSync(invocationLog, "utf-8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
        .filter((event) => event.event === "start")
        .map((event) => event.argv ?? []);
      expect(invocations).toHaveLength(4);
      expect(invocations.some((args) => args.includes("read-tree"))).toBe(false);
      expect(git(cwd, ["show", `${checkpoint.commitSha}:tracked.txt`])).toBe(
        "generated",
      );
      expect(git(cwd, ["show", `${checkpoint.commitSha}:untracked.txt`])).toBe(
        "included",
      );
      expect(git(cwd, ["show", ":tracked.txt"])).toBe("staged");
    },
  );
});

describe("runGates", () => {
  it("starts every gate from the exact candidate tree", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint({
      "candidate.txt": "candidate",
    });

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "mutating-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "require('fs').writeFileSync('candidate.txt', 'mutated')",
          ],
        },
        {
          id: "observing-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').readFileSync('candidate.txt','utf8') === 'candidate' ? 0 : 23)",
          ],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
    ]);
    expect(readFileSync(join(cwd, "candidate.txt"), "utf-8")).toBe(
      "candidate",
    );
  });

  it("removes ignored output before the next gate starts", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint({
      ".gitignore": "ignored-output.txt\n",
    });

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "producing-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "require('fs').writeFileSync('ignored-output.txt', 'generated')",
          ],
        },
        {
          id: "observing-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').existsSync('ignored-output.txt') ? 23 : 0)",
          ],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
    ]);
  });

  it("prepares the toolchain once and keeps it across every gate", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          "require('fs').mkdirSync('node_modules/.bin', { recursive: true });" +
            "require('fs').writeFileSync('node_modules/.bin/tool', 'installed')",
        ],
      },
      declarations: [
        {
          id: "first-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').existsSync('node_modules/.bin/tool') ? 0 : 23)",
          ],
        },
        {
          id: "second-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').existsSync('node_modules/.bin/tool') ? 0 : 23)",
          ],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
    ]);
  });

  it("reports an unpreparable environment as infrastructure, not a red gate", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        // Exit 1 is the package manager's own error code, the one exit code
        // that is not read as a candidate-owned lifecycle failure (ADR 0041).
        args: ["-e", "process.exit(1)"],
      },
      declarations: [
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results).toHaveLength(1);
    const [gate] = result.evidence.results;
    expect(gate?.status).toBe("INFRASTRUCTURE");
    expect(gate?.failureKind).toBeNull();
    expect(gate?.detail).toContain("Gate environment preparation failed");
    verifyGateEvidence(result.artifact);
  });

  it("routes a lockfile drift in the candidate to the generator as a gate FAIL", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          "console.error('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with package.json');" +
            "process.exit(1)",
        ],
      },
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    // Deterministic, candidate-caused: every declaration carries the FAIL so
    // the failure routes to the generator, never the infrastructure retry.
    expect(
      result.evidence.results.map(({ gateId, status, failureKind }) => ({
        gateId,
        status,
        failureKind,
      })),
    ).toEqual([
      { gateId: "typecheck", status: "FAIL", failureKind: "CONFIGURATION" },
      { gateId: "tests", status: "FAIL", failureKind: "CONFIGURATION" },
    ]);
    for (const gate of result.evidence.results) {
      expect(gate.detail).toContain("Gate environment preparation failed");
      expect(gate.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    }
    verifyGateEvidence(result.artifact);
  });

  // #120: the candidate's `prepare` script ran the project's compiler, the
  // compiler found errors the candidate had introduced, and the install
  // exited with the compiler's code. Classifying that as INFRASTRUCTURE
  // spent both retries on byte-identical attempts and killed the slice.
  it("routes a failing lifecycle script in the candidate to the generator as a gate FAIL", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          // What `pnpm install` prints when the root `prepare` script runs
          // `tsc` and the candidate does not compile: the compiler's
          // diagnostics, then pnpm propagating the script's exit code.
          "console.error('src/run-events.ts(51,7): error TS2820: Type \\\"qa-review-archive-failed\\\" is not assignable.');" +
            "console.error(' ELIFECYCLE  Command failed with exit code 2.');" +
            "process.exit(2)",
        ],
      },
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(
      result.evidence.results.map(({ gateId, status, failureKind }) => ({
        gateId,
        status,
        failureKind,
      })),
    ).toEqual([
      { gateId: "typecheck", status: "FAIL", failureKind: "CONFIGURATION" },
      { gateId: "tests", status: "FAIL", failureKind: "CONFIGURATION" },
    ]);
    for (const gate of result.evidence.results) {
      expect(gate.detail).toContain("lifecycle script in the candidate");
      // The round that has to fix it needs to see the compiler errors, not
      // just the exit code (#120).
      expect(gate.detail).toContain("TS2820");
    }
    verifyGateEvidence(result.artifact);
  });

  it("keeps a package manager's own install error as infrastructure", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          // A registry that cannot be reached fails before any lifecycle
          // script runs, and pnpm reports it with its own exit code 1. A
          // retry can genuinely succeed, so this must stay INFRASTRUCTURE.
          "console.error(' ERR_PNPM_META_FETCH_FAIL  GET https://registry.example/left-pad: ECONNREFUSED');" +
            "process.exit(1)",
        ],
      },
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results).toHaveLength(1);
    const [gate] = result.evidence.results;
    expect(gate?.gateId).toBe("typecheck");
    expect(gate?.status).toBe("INFRASTRUCTURE");
    expect(gate?.failureKind).toBeNull();
    expect(gate?.detail).toContain("Gate environment preparation failed");
    verifyGateEvidence(result.artifact);
  });

  it("keeps a missing package manager as infrastructure, not a candidate failure", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: "afk-executable-that-does-not-exist",
      },
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results).toHaveLength(1);
    const [gate] = result.evidence.results;
    expect(gate?.gateId).toBe("typecheck");
    expect(gate?.status).toBe("INFRASTRUCTURE");
    expect(gate?.failureKind).toBeNull();
    expect(gate?.detail).toContain("Gate environment preparation failed");
    verifyGateEvidence(result.artifact);
  });

  it("removes an untracked nested repository before the next gate starts", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const nestedRepository = "nested-output";

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "producing-gate",
          stage: "base",
          required: true,
          command: "git",
          args: ["init", nestedRepository],
        },
        {
          id: "observing-gate",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            `process.exit(require('node:fs').existsSync(${JSON.stringify(nestedRepository)}) ? 23 : 0)`,
          ],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
    ]);
    expect(existsSync(join(cwd, nestedRepository))).toBe(false);
  });

  it("runs declarations in order and preserves structured evidence and logs", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const output: string[] = [];
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('type-out'); process.stderr.write('type-err')",
          ],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.stdout.write('test-out'); process.exit(23)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      onOutput: (gateId, text) => output.push(`${gateId}:${text}`),
    });

    // B-04: a fresh document stamps the current version, now 3.
    expect(result.evidence.version).toBe(3);
    expect(result.evidence.results.map(({ gateId }) => gateId)).toEqual([
      "typecheck",
      "tests",
    ]);
    expect(result.evidence.results[0]).toMatchObject({
      gateId: "typecheck",
      stage: "base",
      status: "PASS",
      failureKind: null,
      exitCode: 0,
      treeId,
    });
    expect(result.evidence.results[1]).toMatchObject({
      gateId: "tests",
      stage: "base",
      status: "FAIL",
      failureKind: "COMMAND",
      exitCode: 23,
    });
    for (const gate of result.evidence.results) {
      expect(gate.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(gate.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(gate.durationMs).toBeGreaterThanOrEqual(0);
      expect(readFileSync(join(evidenceDir, gate.logArtifactId), "utf-8"))
        .not.toBe("");
    }
    expect(output.join("")).toContain("typecheck:type-out");
    expect(output.join("")).toContain("typecheck:type-err");
    expect(output.join("")).toContain("tests:test-out");
    expect(
      JSON.parse(readFileSync(result.evidencePath, "utf-8")),
    ).toEqual(result.evidence);
  });

  it("classifies missing and invalid declarations without hiding later gates", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "missing-tool",
          stage: "base",
          required: true,
          command: "afk-executable-that-does-not-exist",
        },
        {
          id: "optional-lint",
          stage: "base",
          required: false,
        },
        {
          id: "",
          stage: "base",
          required: true,
          command: process.execPath,
        },
        {
          id: "independent",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map((gate) => gate.status)).toEqual([
      "FAIL",
      "SKIPPED",
      "FAIL",
      "PASS",
    ]);
    expect(result.evidence.results[0]).toMatchObject({
      failureKind: "CONFIGURATION",
      exitCode: null,
    });
    expect(result.evidence.results[1]).toMatchObject({
      failureKind: null,
      exitCode: null,
    });
    expect(result.evidence.results[2]).toMatchObject({
      failureKind: "CONFIGURATION",
      exitCode: null,
    });
  });

  it("B-01: awaits an in-process run ahead of the cwd, prepare and restore branches", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const inProcess: GateDeclaration = {
      id: "scope",
      stage: "deterministic",
      required: true,
      run: () => ({
        status: "FAIL",
        failureKind: "COMMAND",
        detail: "1 changed path(s) are outside the accepted file scope: src/x.ts",
        findings: { outOfScopePaths: ["src/x.ts"] },
      }),
    };
    const commandGate: GateDeclaration = {
      id: "tests",
      stage: "base",
      required: true,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    };
    const shared = {
      treeId,
      evidenceDir,
      declarations: [inProcess, commandGate],
      // A prepare the candidate broke: every *command* declaration carries its
      // FAIL/CONFIGURATION, and the in-process gate must still report its own
      // answer, because no toolchain was ever needed to reach it.
      prepare: {
        id: "install",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          "console.error('ERR_PNPM_OUTDATED_LOCKFILE lockfile is not up to date');" +
            "process.exit(1)",
        ],
      },
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    } as const;

    const withPrepare = await runGates({ ...shared, cwd });

    expect(withPrepare.evidence.results[0]).toMatchObject({
      gateId: "scope",
      stage: "deterministic",
      status: "FAIL",
      failureKind: "COMMAND",
      // Never a command's exit code, and never a substituted tree id.
      exitCode: null,
      treeId,
      findings: { outOfScopePaths: ["src/x.ts"] },
    });
    expect(withPrepare.evidence.results[0]!.detail).toContain("src/x.ts");
    expect(withPrepare.evidence.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(withPrepare.evidence.results[0]!.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect(withPrepare.evidence.results[0]!.endedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect(withPrepare.evidence.results[1]).toMatchObject({
      gateId: "tests",
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    // The paths a red gate names travel in the log, because the repair round
    // reads the log rather than the JSON.
    expect(
      readFileSync(
        join(evidenceDir, withPrepare.evidence.results[0]!.logArtifactId),
        "utf-8",
      ),
    ).toContain("src/x.ts");

    // An unmaterialized post-QA checkpoint has no directory at all. The
    // command gate is INFRASTRUCTURE for that; the in-process gate is not.
    const missing = await runGates({
      ...shared,
      cwd: join(cwd, "..", "never-materialized"),
    });

    expect(
      missing.evidence.results.map(({ gateId, status }) => ({ gateId, status })),
    ).toEqual([
      { gateId: "scope", status: "FAIL" },
      { gateId: "tests", status: "INFRASTRUCTURE" },
    ]);
  });

  it("B-01: records nothing for an in-process gate once the run is cancelled", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const controller = new AbortController();
    controller.abort();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "scope",
          stage: "deterministic",
          required: true,
          run: () => {
            throw new Error("must not run after cancellation");
          },
        },
      ],
      signal: controller.signal,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    // Same rule as the command path: a cancelled run records no result rather
    // than inventing one.
    expect(result.evidence.results).toEqual([]);
  });

  it("B-02: records a throwing and a rejecting run as infrastructure and keeps going", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const declarations: GateDeclaration[] = [
      {
        id: "throws",
        stage: "deterministic",
        required: true,
        run: () => {
          throw new Error("tree 0000 could not be diffed");
        },
      },
      {
        id: "rejects",
        stage: "deterministic",
        required: true,
        run: () => Promise.reject(new Error("acceptance-manifest.json is missing")),
      },
      {
        id: "still-runs",
        stage: "deterministic",
        required: true,
        run: () => ({ status: "PASS", failureKind: null }),
      },
    ];

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    // INFRASTRUCTURE, not FAIL: a check that could not read the world is the
    // branch no generator edit repairs (ADR 0041).
    expect(
      result.evidence.results.map(({ gateId, status, failureKind, detail }) => ({
        gateId,
        status,
        failureKind,
        detail,
      })),
    ).toEqual([
      {
        gateId: "throws",
        status: "INFRASTRUCTURE",
        failureKind: null,
        detail: "tree 0000 could not be diffed",
      },
      {
        gateId: "rejects",
        status: "INFRASTRUCTURE",
        failureKind: null,
        detail: "acceptance-manifest.json is missing",
      },
      {
        gateId: "still-runs",
        status: "PASS",
        failureKind: null,
        detail: undefined,
      },
    ]);
    // The evidence document is still written, and every declaration still
    // binds to exactly one result — the check `assertGateEvidenceReleasesEvaluation`
    // makes positionally.
    expect(existsSync(result.evidencePath)).toBe(true);
    expect(result.evidence.results).toHaveLength(declarations.length);
    expect(verifyGateEvidence(result.artifact)).toEqual(result.evidence);
  });

  it("B-03: round-trips a findings payload through the evidence document", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    // All four D5 members, so `pnpm typecheck` proves the shape and the reader
    // proves it survives a JSON round trip. Only `outOfScopePaths` is
    // populated by a gate this slice ships; the rest belong to later slices.
    const findings: GateFindings = {
      outOfScopePaths: ["src/undeclared.ts"],
      deletedTests: [],
      protectedChanges: [],
      appliedWaivers: [
        {
          riskClass: "deleted-test",
          path: "src/legacy.test.ts",
          author: "operator",
          reason: "superseded by src/legacy-split.test.ts",
        },
      ],
    };

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "scope",
          stage: "deterministic",
          required: true,
          run: () => ({ status: "FAIL", failureKind: "COMMAND", findings }),
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]!.findings).toEqual(findings);
    expect(readGateEvidence(result.evidencePath)).toEqual(result.evidence);
  });

  it("B-04: accepts version 1, 2 and 3 evidence, refuses version 4 and findings under version 1", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "scope",
          stage: "deterministic",
          required: true,
          run: () => ({
            status: "FAIL",
            failureKind: "COMMAND",
            findings: { outOfScopePaths: ["src/undeclared.ts"] },
          }),
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(GATE_EVIDENCE_VERSION).toBe(3);
    expect(result.evidence.version).toBe(3);
    expect(readGateEvidence(result.evidencePath)).toEqual(result.evidence);

    // A version-2 document — the shape every run between #195 and #86 wrote —
    // still reads: version 3 only added optional markers.
    const v2Path = join(evidenceDir, "version-2.json");
    writeFileSync(
      v2Path,
      JSON.stringify({ ...result.evidence, version: 2 }),
      "utf-8",
    );
    expect(readGateEvidence(v2Path).version).toBe(2);

    // A version-1 document a run before this slice wrote still reads: an
    // evidence version bump that stranded the journals mid-run would make an
    // in-flight resume unreadable.
    const [scope, ...rest] = result.evidence.results;
    const legacy = {
      ...result.evidence,
      version: 1,
      results: [{ ...scope!, findings: undefined }, ...rest],
    };
    const legacyPath = join(evidenceDir, "version-1.json");
    writeFileSync(legacyPath, JSON.stringify(legacy), "utf-8");
    expect(readGateEvidence(legacyPath).version).toBe(1);

    // But a version-1 document carrying findings is not a document any
    // version of this code wrote, so it is refused rather than read
    // optimistically.
    const legacyWithFindings = join(evidenceDir, "version-1-findings.json");
    writeFileSync(
      legacyWithFindings,
      JSON.stringify({ ...result.evidence, version: 1 }),
      "utf-8",
    );
    expect(() => readGateEvidence(legacyWithFindings)).toThrow(
      /version 1 cannot carry findings/i,
    );

    const future = join(evidenceDir, "version-4.json");
    writeFileSync(
      future,
      JSON.stringify({ ...result.evidence, version: 4 }),
      "utf-8",
    );
    expect(() => readGateEvidence(future)).toThrow(
      /unsupported gate evidence version: 4/i,
    );
  });

  it("[behavior:B-03] reuses a cached PASS for an identical tree and says so in the evidence and the log", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    const cache = { path: join(root, "gate-cache.json"), enabled: true };
    // A gate that appends a line per run, so a reused answer is provable by the
    // command *not* having happened rather than by its status alone.
    const marker = join(root, "ran.txt");
    const declarations: GateDeclaration[] = [
      {
        id: "typecheck",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          `require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
        ],
      },
    ];
    const common = {
      treeId,
      cwd,
      declarations,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      cache,
    };

    const first = await runGates({ ...common, evidenceDir });
    expect(first.evidence.results[0]).toMatchObject({ status: "PASS" });
    expect(first.evidence.results[0]!.cacheReused).toBeUndefined();
    expect(readFileSync(marker, "utf-8")).toBe("x");

    const output: string[] = [];
    const second = await runGates({
      ...common,
      evidenceDir: join(root, "evidence-2"),
      onOutput: (gateId, text) => output.push(`${gateId}:${text}`),
    });
    // Same tree, same command: the answer is reused and the command never ran
    // a second time.
    expect(readFileSync(marker, "utf-8")).toBe("x");
    expect(second.evidence.results[0]).toMatchObject({
      status: "PASS",
      failureKind: null,
      exitCode: 0,
      cacheReused: true,
    });
    // Reuse is explicit wherever the result is read, not inferable only from a
    // suspiciously short duration.
    expect(second.evidence.results[0]!.detail).toContain("cached PASS");
    expect(output.join("")).toContain("cache reuse");
    expect(
      readFileSync(
        join(root, "evidence-2", second.evidence.results[0]!.logArtifactId),
        "utf-8",
      ),
    ).toContain("cached PASS");
  });

  it("[behavior:B-04] runs the gate again when the tree changed, and when the cache document is unreadable", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    const cachePath = join(root, "gate-cache.json");
    const marker = join(root, "ran.txt");
    const declarations: GateDeclaration[] = [
      {
        id: "typecheck",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          `require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
        ],
      },
    ];
    const common = {
      cwd,
      declarations,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      cache: { path: cachePath, enabled: true },
    };

    await runGates({ ...common, treeId, evidenceDir });
    expect(readFileSync(marker, "utf-8")).toBe("x");

    // A different tree is a different question, so the gate is paid again.
    writeFileSync(join(cwd, "tracked.txt"), "edited", "utf-8");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "edit"]);
    const editedTreeId = git(cwd, ["rev-parse", "HEAD^{tree}"]);
    expect(editedTreeId).not.toBe(treeId);
    const other = await runGates({
      ...common,
      treeId: editedTreeId,
      evidenceDir: join(root, "evidence-2"),
    });
    expect(other.evidence.results[0]).toMatchObject({ status: "PASS" });
    expect(other.evidence.results[0]!.cacheReused).toBeUndefined();
    expect(readFileSync(marker, "utf-8")).toBe("xx");

    // A corrupt document is a miss, never a throw: a cache can make a run
    // cheaper, and must not be able to make it redder.
    writeFileSync(cachePath, "{ not json", "utf-8");
    const corrupt = await runGates({
      ...common,
      treeId: editedTreeId,
      evidenceDir: join(root, "evidence-3"),
    });
    expect(corrupt.evidence.results[0]).toMatchObject({ status: "PASS" });
    expect(corrupt.evidence.results[0]!.cacheReused).toBeUndefined();
    expect(readFileSync(marker, "utf-8")).toBe("xxx");

    // With no cache options at all the runner behaves exactly as it did before
    // this slice.
    const uncached = await runGates({
      ...common,
      cache: undefined,
      treeId: editedTreeId,
      evidenceDir: join(root, "evidence-4"),
    });
    expect(uncached.evidence.results[0]).toMatchObject({ status: "PASS" });
    expect(readFileSync(marker, "utf-8")).toBe("xxxx");
  });

  it("[behavior:B-04] never caches a FAIL, an INFRASTRUCTURE result or an in-process PASS it cannot key", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    const cache = { path: join(root, "gate-cache.json"), enabled: true };
    const marker = join(root, "ran.txt");
    const common = {
      treeId,
      cwd,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      cache,
    };
    const failing: GateDeclaration[] = [
      {
        id: "tests",
        stage: "base",
        required: true,
        command: process.execPath,
        args: [
          "-e",
          `require("fs").appendFileSync(${JSON.stringify(marker)}, "x");` +
            `process.exit(1)`,
        ],
      },
    ];

    const first = await runGates({
      ...common,
      declarations: failing,
      evidenceDir,
    });
    expect(first.evidence.results[0]).toMatchObject({
      status: "FAIL",
      failureKind: "COMMAND",
    });
    const second = await runGates({
      ...common,
      declarations: failing,
      evidenceDir: join(root, "evidence-2"),
    });
    // The next round exists to change this tree, so a red answer is re-earned.
    expect(second.evidence.results[0]!.status).toBe("FAIL");
    expect(second.evidence.results[0]!.cacheReused).toBeUndefined();
    expect(readFileSync(marker, "utf-8")).toBe("xx");

    // An in-process gate has no command to key a cache entry on, so it is
    // simply never consulted and never recorded.
    let runs = 0;
    const inProcess: GateDeclaration[] = [
      {
        id: "scope",
        stage: "deterministic",
        required: true,
        run: () => {
          runs += 1;
          return { status: "PASS", failureKind: null, detail: "clean" };
        },
      },
    ];
    await runGates({ ...common, declarations: inProcess, evidenceDir: join(root, "e3") });
    const repeat = await runGates({
      ...common,
      declarations: inProcess,
      evidenceDir: join(root, "e4"),
    });
    expect(runs).toBe(2);
    expect(repeat.evidence.results[0]!.cacheReused).toBeUndefined();
  });

  it("[behavior:B-07] skips a dependent whose prerequisite failed, naming it, and leaves independent gates alone", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    const marker = join(root, "ran.txt");
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(2)"],
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            `require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
          ],
          prerequisiteGateIds: ["typecheck"],
        },
        {
          id: "lint",
          stage: "base",
          required: false,
          command: process.execPath,
          args: ["-e", "process.exit(3)"],
        },
        {
          // A prerequisite that is not part of this phase is not a failure: the
          // gate cannot be held responsible for a declaration it never saw.
          id: "docs",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          prerequisiteGateIds: ["acceptance:behaviors"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results.map((gate) => gate.status)).toEqual([
      "FAIL",
      "SKIPPED",
      "FAIL",
      "PASS",
    ]);
    // The skip is not a red gate and not a silent absence: it names what has
    // to go green first.
    expect(result.evidence.results[1]).toMatchObject({
      gateId: "tests",
      status: "SKIPPED",
      failureKind: null,
      exitCode: null,
      prerequisiteSkipped: "typecheck",
    });
    expect(result.evidence.results[1]!.detail).toContain("typecheck");
    expect(existsSync(marker)).toBe(false);
    // `lint` declared no prerequisite, so its own failure still arrives in the
    // same round as `typecheck`'s rather than being deferred behind it.
    expect(result.evidence.results[2]).toMatchObject({
      gateId: "lint",
      status: "FAIL",
      failureKind: "COMMAND",
    });
    expect(result.evidence.results[3]!.prerequisiteSkipped).toBeUndefined();
  });

  it("[behavior:B-02] carries a declared environmentSensitive marker into every result that names it", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        {
          id: "test:budgets",
          stage: "base",
          required: false,
          environmentSensitive: true,
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          prerequisiteGateIds: ["tests"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]!.environmentSensitive).toBeUndefined();
    expect(result.evidence.results[1]).toMatchObject({
      gateId: "test:budgets",
      status: "FAIL",
      environmentSensitive: true,
    });
    // The marker survives the round trip, so the summary and PR body readers
    // can tell an advisory red row from a blocking one.
    expect(
      readGateEvidence(result.evidencePath).results[1]!.environmentSensitive,
    ).toBe(true);
  });

  it("B-08: classifies every either-or declaration shape, the derived lint gate included", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    // A project with a test script and no lint script, so the derived lint
    // declaration is the real commandless optional gate rather than a
    // hand-written stand-in for one (P-05).
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "either-or-fixture",
        private: true,
        scripts: { "test:run": "node -e \"process.exit(0)\"" },
      }),
      "utf-8",
    );
    const derivedLint = resolveBaseGateDeclarations(cwd).find(
      (gate) => gate.id === "lint",
    );

    expect(derivedLint).toMatchObject({ required: false });
    expect(derivedLint?.command).toBeUndefined();
    expect(derivedLint?.run).toBeUndefined();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        { id: "required-neither", stage: "base", required: true },
        { id: "optional-neither", stage: "base", required: false },
        {
          id: "both-supplied",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          run: () => ({ status: "PASS", failureKind: null }),
        },
        derivedLint!,
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(
      result.evidence.results.map(({ gateId, status, failureKind, detail }) => ({
        gateId,
        status,
        failureKind,
        detail,
      })),
    ).toEqual([
      {
        gateId: "required-neither",
        status: "FAIL",
        failureKind: "CONFIGURATION",
        detail: "Invalid required gate declaration",
      },
      {
        gateId: "optional-neither",
        status: "SKIPPED",
        failureKind: null,
        detail: "Optional gate has no command",
      },
      // Both is a declaration bug, not a preference: silently picking one
      // would run a check nobody declared.
      {
        gateId: "both-supplied",
        status: "FAIL",
        failureKind: "CONFIGURATION",
        detail: "Invalid required gate declaration",
      },
      {
        gateId: "lint",
        status: "SKIPPED",
        failureKind: null,
        detail: "Optional gate has no command",
      },
    ]);
  });

  it("P-05: leaves the derived declarations for a project with no lint script alone", () => {
    const { cwd } = makeCheckpoint();
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "no-lint-fixture",
        private: true,
        scripts: { typecheck: "tsc --noEmit", "test:run": "vitest run" },
      }),
      "utf-8",
    );

    expect(
      resolveBaseGateDeclarations(cwd).map(
        ({ id, stage, required, command }) => ({ id, stage, required, command }),
      ),
    ).toEqual([
      { id: "typecheck", stage: "base", required: true, command: "pnpm" },
      // Still commandless and still optional: the either-or rule in `runGates`
      // did not turn an absent script into a required declaration.
      { id: "lint", stage: "base", required: false, command: undefined },
      { id: "tests", stage: "base", required: true, command: "pnpm" },
    ]);
  });

  it("P-01: keeps every command-path branch, detail string and evidence write intact", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const options = {
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "empty-command",
          stage: "base",
          required: true,
          command: "   ",
        },
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.stdout.write('ran'); process.exit(7)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    } as const;

    const first = await runGates(options);

    expect(
      first.evidence.results.map(
        ({ gateId, status, failureKind, exitCode, detail, findings }) => ({
          gateId,
          status,
          failureKind,
          exitCode,
          detail,
          findings,
        }),
      ),
    ).toEqual([
      {
        gateId: "empty-command",
        status: "FAIL",
        failureKind: "CONFIGURATION",
        exitCode: null,
        detail: "Invalid required gate declaration",
        // A command gate carries no findings, so nothing changed for a
        // consumer that reads a command result.
        findings: undefined,
      },
      {
        gateId: "tests",
        status: "FAIL",
        failureKind: "COMMAND",
        exitCode: 7,
        detail: undefined,
        findings: undefined,
      },
    ]);
    // The `wx` write and the per-log hash: a second attempt cannot overwrite
    // the first, and the artifact still verifies both.
    const second = await runGates(options);
    expect(second.evidencePath).not.toBe(first.evidencePath);
    expect(verifyGateEvidence(first.artifact)).toEqual(first.evidence);
    expect(verifyGateEvidence(second.artifact)).toEqual(second.evidence);
  });

  it("P-06: retries an in-process infrastructure result through the unedited candidate gate phase", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    let runs = 0;
    const retries: string[] = [];

    const phase = await runCandidateGatePhase({
      repoRoot: root,
      ghIssue: "195",
      sliceNumber: "08",
      tag: "#195 slice 08",
      round: 1,
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "scope",
          stage: "deterministic",
          required: true,
          run: () => {
            runs++;
            return { status: "INFRASTRUCTURE", failureKind: null, detail: "probe failed" };
          },
        },
      ],
      label: "post-QA gates",
      infrastructureRetries: 1,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      onGateOutcome: () => {},
      onInfrastructureRetry: (message) => retries.push(message),
    });

    // The bounded retry treats an in-process INFRASTRUCTURE result exactly as
    // it treats a command one, with no edit to `src/candidate-gate-phase.ts`.
    expect(runs).toBe(2);
    expect(phase.attempts).toHaveLength(2);
    expect(retries).toEqual(["#195 slice 08: post-QA gates infrastructure retry 1/1"]);
    expect(phase.evidence.results[0]).toMatchObject({
      gateId: "scope",
      status: "INFRASTRUCTURE",
      failureKind: null,
    });
    // Still one result per declaration, and still the repo-relative evidence
    // path the run journal records.
    expect(phase.evidence.results).toHaveLength(1);
    expect(relative(root, phase.evidencePath).replace(/\\/g, "/")).not.toMatch(
      /^\.\./,
    );
  });

  it("retains a partial log without inventing a result on cancellation", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const controller = new AbortController();
    const starts: string[] = [];
    setTimeout(() => controller.abort(), 100);

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "long-running",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        },
        {
          id: "must-not-start",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      signal: controller.signal,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      onOutput: (gateId, text) => {
        if (text.includes("START")) starts.push(gateId);
      },
    });

    expect(starts).toEqual(["long-running"]);
    expect(result.evidence.results).toEqual([]);
    const partialLogs = readdirSync(join(evidenceDir, "gate-logs"));
    expect(partialLogs).toHaveLength(1);
    expect(
      readFileSync(join(evidenceDir, "gate-logs", partialLogs[0]!), "utf-8"),
    ).toContain("[gate:long-running] START");
  });

  it("omits a cancelled result even when checkpoint restoration fails", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const controller = new AbortController();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "destructive-cancel",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').rmSync('.git', { recursive: true, force: true }); process.stdout.write('metadata-removed'); setInterval(() => {}, 1000)",
          ],
        },
      ],
      signal: controller.signal,
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
      onOutput: (_gateId, text) => {
        if (text.includes("metadata-removed")) controller.abort();
      },
    });

    expect(result.evidence.results).toEqual([]);
    const partialLogs = readdirSync(join(evidenceDir, "gate-logs"));
    expect(partialLogs).toHaveLength(1);
    expect(
      readFileSync(join(evidenceDir, "gate-logs", partialLogs[0]!), "utf-8"),
    ).toContain("metadata-removed");
  });

  it("retains the command exit code when checkpoint restoration fails", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "destructive-failure",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').rmSync('.git', { recursive: true, force: true }); process.exit(23)",
          ],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]).toMatchObject({
      gateId: "destructive-failure",
      status: "INFRASTRUCTURE",
      failureKind: null,
      exitCode: 23,
    });
  });

  it("preserves distinct attempts and rejects unversioned evidence", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const options = {
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.stdout.write('retained')"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    } as const;

    const first = await runGates(options);
    const firstEvidenceBytes = readFileSync(first.evidencePath, "utf-8");
    const firstLogPath = join(
      evidenceDir,
      first.evidence.results[0]!.logArtifactId,
    );
    const firstLogBytes = readFileSync(firstLogPath, "utf-8");
    const second = await runGates(options);

    expect(second.evidencePath).not.toBe(first.evidencePath);
    expect(second.evidence.results[0]!.logArtifactId).not.toBe(
      first.evidence.results[0]!.logArtifactId,
    );
    expect(readFileSync(first.evidencePath, "utf-8")).toBe(firstEvidenceBytes);
    expect(readFileSync(firstLogPath, "utf-8")).toBe(firstLogBytes);
    expect(readGateEvidence(first.evidencePath)).toEqual(first.evidence);

    const missingVersionPath = join(evidenceDir, "missing-version.json");
    writeFileSync(
      missingVersionPath,
      JSON.stringify({ ...first.evidence, version: undefined }),
      "utf-8",
    );
    expect(() => readGateEvidence(missingVersionPath)).toThrow(
      /missing gate evidence version/i,
    );

    const unsupportedVersionPath = join(evidenceDir, "future-version.json");
    writeFileSync(
      unsupportedVersionPath,
      JSON.stringify({ ...first.evidence, version: 4 }),
      "utf-8",
    );
    expect(() => readGateEvidence(unsupportedVersionPath)).toThrow(
      /unsupported gate evidence version: 4/i,
    );
  });

  it("detects later changes to evidence and retained gate logs", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "tests",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.stdout.write('retained')"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });
    const evidenceBytes = readFileSync(result.evidencePath, "utf-8");
    const logPath = join(
      evidenceDir,
      result.evidence.results[0]!.logArtifactId,
    );
    const logBytes = readFileSync(logPath, "utf-8");

    expect(verifyGateEvidence(result.artifact)).toEqual(result.evidence);

    writeFileSync(
      result.evidencePath,
      JSON.stringify({ ...result.evidence, results: [] }),
      "utf-8",
    );
    expect(() => verifyGateEvidence(result.artifact)).toThrow(
      /gate evidence integrity/i,
    );

    writeFileSync(result.evidencePath, evidenceBytes, "utf-8");
    writeFileSync(logPath, "changed later", "utf-8");
    expect(() => verifyGateEvidence(result.artifact)).toThrow(
      /gate log integrity/i,
    );
    writeFileSync(logPath, logBytes, "utf-8");
  });

  it("seals a gate log only after inherited output handles close", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const delayedWriter = [
      "setTimeout(() => {",
      "  process.stdout.write('delayed-output');",
      "}, 200);",
    ].join("\n");
    const command = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(delayedWriter)}], {`,
      "  detached: true,",
      "  stdio: ['ignore', process.stdout, process.stderr],",
      "});",
      "child.unref();",
    ].join("\n");

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "delayed-output",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", command],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });
    const logPath = join(
      evidenceDir,
      result.evidence.results[0]!.logArtifactId,
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(readFileSync(logPath, "utf-8")).toContain("delayed-output");
    expect(verifyGateEvidence(result.artifact)).toEqual(result.evidence);
  });

  it("classifies an unavailable working directory as infrastructure", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-gates-"));
    dirs.push(root);
    const result = await runGates({
      treeId: "cccccccccccccccccccccccccccccccccccccccc",
      cwd: join(root, "missing-checkout"),
      evidenceDir: join(root, "evidence"),
      declarations: [
        {
          id: "typecheck",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      ],
      inactivityTimeoutMs: ordinaryInactivityTimeoutMs,
      wallClockTimeoutMs: ordinaryWallClockTimeoutMs,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]).toMatchObject({
      status: "INFRASTRUCTURE",
      failureKind: null,
      exitCode: null,
    });
  });

  it("terminates a silent command tree on inactivity", async () => {
    const { root, cwd, evidenceDir, treeId } = makeCheckpoint();
    const childPidPath = join(root, "child.pid");
    const command = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "silent",
          stage: "base",
          required: true,
          command: process.execPath,
          args: ["-e", command],
        },
      ],
      inactivityTimeoutMs: 100,
      wallClockTimeoutMs: 2_000,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]).toMatchObject({
      status: "FAIL",
      failureKind: "COMMAND",
      exitCode: null,
    });
    const childPid = Number(readFileSync(childPidPath, "utf-8"));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 30_000);

  it("enforces the wall-clock limit despite continuous output", async () => {
    const { cwd, evidenceDir, treeId } = makeCheckpoint();
    const result = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations: [
        {
          id: "continuous",
          stage: "base",
          required: true,
          command: process.execPath,
          args: [
            "-e",
            "setInterval(() => process.stdout.write('beat\\n'), 20)",
          ],
        },
      ],
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 150,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]).toMatchObject({
      status: "FAIL",
      failureKind: "COMMAND",
      exitCode: null,
    });
  }, 30_000);
});
