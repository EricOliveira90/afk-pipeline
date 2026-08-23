import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGateEvidence, runGates } from "./gate-runner.js";

const dirs: string[] = [];

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
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
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
    rmSync(dir, { recursive: true, force: true });
  }
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
      heartbeatIntervalMs: 20,
      onOutput: (gateId, text) => output.push(`${gateId}:${text}`),
    });

    expect(result.evidence.version).toBe(1);
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
      failureKind: "IMPLEMENTATION",
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
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

  it("records cancellation as infrastructure and starts no later gate", async () => {
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
      heartbeatIntervalMs: 20,
      onOutput: (gateId, text) => {
        if (text.includes("START")) starts.push(gateId);
      },
    });

    expect(starts).toEqual(["long-running"]);
    expect(result.evidence.results).toHaveLength(1);
    expect(result.evidence.results[0]).toMatchObject({
      status: "INFRASTRUCTURE",
      failureKind: null,
      exitCode: null,
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
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
      JSON.stringify({ ...first.evidence, version: 2 }),
      "utf-8",
    );
    expect(() => readGateEvidence(unsupportedVersionPath)).toThrow(
      /unsupported gate evidence version: 2/i,
    );
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
      inactivityTimeoutMs: 1_000,
      wallClockTimeoutMs: 2_000,
      heartbeatIntervalMs: 20,
    });

    expect(result.evidence.results[0]).toMatchObject({
      status: "INFRASTRUCTURE",
      failureKind: null,
      exitCode: null,
    });
  });
});
