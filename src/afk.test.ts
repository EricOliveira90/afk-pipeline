import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRYPOINT = resolve("src", "afk.ts");
const TSX_LOADER = pathToFileURL(
  resolve("node_modules", "tsx", "dist", "loader.mjs"),
).href;
const tempDirs: string[] = [];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function invoke(repo: string, args: string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, ENTRYPOINT, ...args],
    {
      cwd: repo,
      encoding: "utf-8",
      env: process.env,
      timeout: 15_000,
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("afk entrypoint routing", () => {
  let repo: string;
  let prdDir: string;
  let runDir: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "afk-entrypoint-"));
    tempDirs.push(repo);

    const init = spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: repo,
      encoding: "utf-8",
    });
    if (init.status !== 0) throw new Error(init.stderr);

    prdDir = join(repo, ".kiro", "specs", "demo");
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, "prd.md"), "# Demo\n", "utf-8");
    writeFileSync(
      join(prdDir, "issues.md"),
      `# Issues

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #100 | Existing slice | AFK | - | 1 |
`,
      "utf-8",
    );

    const stateDir = join(repo, ".afk", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "demo.json"),
      JSON.stringify({
        version: 1,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        scope: {
          mode: "all-afk",
          slices: [{ number: "01", ghIssue: "100" }],
        },
        slices: {
          "100": {
            phase: "PASS",
            branch: "afk/demo-slice-01-existing-slice",
            mergedToFeature: true,
          },
        },
      }),
      "utf-8",
    );

    runDir = join(
      repo,
      ".afk",
      "logs",
      "demo",
      "run-20260828-120000",
    );
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "events.jsonl"),
      [
        { type: "header", version: 1, ts: "2026-08-28T12:00:00.000Z" },
        {
          type: "run-started",
          provider: "kiro",
          runSlug: "demo",
          ts: "2026-08-28T12:00:00.100Z",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf-8",
    );
  });

  afterAll(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("dispatches status and preserves its stdout and exit behavior", () => {
    const result = invoke(repo, ["status", "--run", runDir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Run: ${runDir}`);
    expect(result.stdout).toContain("run started (kiro)");
    expect(result.stdout).toContain("Present:");
    expect(result.stderr).toBe("");
  });

  it("dispatches stop and preserves its sentinel and unsuccessful output", () => {
    const result = invoke(repo, ["stop", "--run", runDir, "--wait-ms", "0"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Wrote stop sentinel");
    expect(result.stderr).toContain("Not waiting for an acknowledgement");
    expect(existsSync(join(runDir, "stop.request"))).toBe(true);
  });

  it("dispatches clean-failed with the Kiro provider", () => {
    const result = invoke(repo, [
      "clean-failed",
      "--prd-dir",
      prdDir,
      "--dry-run",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Cleaning failed-slice debris for demo (dry run)",
    );
    expect(result.stdout).toContain("Worktrees to remove: 0");
    expect(result.stderr).toBe("");
  });

  it("dispatches a dry-run pipeline through the Kiro run-state namespace", () => {
    const result = invoke(repo, [
      "--prd-dir",
      prdDir,
      "--dry-run",
      "--only-failed",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("AFK Pipeline");
    expect(result.stdout).toContain(
      "Requested slices: --only-failed \u2192 none",
    );
    expect(result.stdout).toContain("Dry run complete. No changes made.");
    expect(result.stderr).toBe("");
  });

  it("preserves help output and exit behavior while listing adopt", () => {
    const result = invoke(repo, ["--help"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: afk --prd-dir");
    expect(result.stderr).toContain("afk status");
    expect(result.stderr).toContain("afk stop");
    expect(result.stderr).toContain("afk clean-failed");
    expect(result.stderr).toContain("afk adopt");
  });

  it("dispatches adopt without adding provider-specific aliases", () => {
    const result = invoke(repo, ["adopt", "demo", "100"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Usage: afk adopt <prd-slug> <slice>",
    );
  });
});
