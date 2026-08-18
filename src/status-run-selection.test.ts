/**
 * `afk status` run selection (#31) — `--run <dir>` post-mortem
 * selection and zero-arg auto-detect, tested at the filesystem
 * contract: fixture run directories in, rendered text / `--json` out.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "./status.js";
import { lifecycle } from "./slice-lifecycle.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-status-run-"));
  tempDirs.push(dir);
  return dir;
}

const PROGRESS = { genRounds: 1, evalRounds: 1 };

/** Write a run directory fixture with an events.jsonl shaped like the tee's output. */
function writeRunDir(
  root: string,
  slug: string,
  runName: string,
  events: Array<Record<string, unknown>>,
): string {
  const runDir = join(root, ".afk", "logs", slug, runName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
  return runDir;
}

function eventsFor(ghIssue: string, title: string): Array<Record<string, unknown>> {
  return [
    { type: "header", version: 1, ts: "2026-08-18T10:00:00.000Z" },
    {
      type: "run-started",
      provider: "stub",
      runSlug: "demo-stub",
      ts: "2026-08-18T10:00:00.100Z",
    },
    {
      type: "slice-outcome",
      slice: lifecycle.pass(
        { ghIssue, title, branch: `afk/${ghIssue}` },
        PROGRESS,
        true,
      ),
      ts: "2026-08-18T10:05:00.000Z",
    },
  ];
}

describe("afk status --run <dir> (#31)", () => {
  it("renders the given run by absolute path, bypassing auto-detect", () => {
    const root = makeRoot();
    const older = writeRunDir(
      root,
      "demo-stub",
      "run-20260810-090000",
      eventsFor("1111", "Older"),
    );
    // A newer run exists — auto-detect would pick it; --run must not.
    writeRunDir(
      root,
      "demo-stub",
      "run-20260818-110000",
      eventsFor("2222", "Newest"),
    );

    const { output, exitCode } = runStatus(["--run", older], root);

    expect(exitCode).toBe(0);
    expect(output).toContain("#1111");
    expect(output).not.toContain("#2222");
    // Auto-detect was bypassed: no auto-detect announcement.
    expect(output).not.toMatch(/auto-detect/i);
  });

  it("resolves a repo-relative --run path against repoRoot", () => {
    const root = makeRoot();
    writeRunDir(
      root,
      "demo-stub",
      "run-20260810-090000",
      eventsFor("3333", "Relative"),
    );
    // A newer run exists — auto-detect would pick it; --run must not.
    writeRunDir(
      root,
      "demo-stub",
      "run-20260818-110000",
      eventsFor("2222", "Newest"),
    );

    const relative = join(".afk", "logs", "demo-stub", "run-20260810-090000");
    const { output, exitCode } = runStatus(["--run", relative], root);

    expect(exitCode).toBe(0);
    expect(output).toContain("#3333");
    expect(output).not.toContain("#2222");
  });

  it("fails clearly when the run dir predates events.jsonl", () => {
    const root = makeRoot();
    const runDir = join(root, ".afk", "logs", "demo-stub", "run-20260801-080000");
    mkdirSync(runDir, { recursive: true });
    // Directory exists but has no events.jsonl. A valid newer run
    // exists — auto-detect would succeed; --run must still fail.
    writeRunDir(
      root,
      "demo-stub",
      "run-20260818-110000",
      eventsFor("2222", "Newest"),
    );

    const { output, exitCode } = runStatus(["--run", runDir], root);

    expect(exitCode).not.toBe(0);
    expect(output).toContain("predates events.jsonl");
  });

  it("fails helpfully when the run dir does not exist", () => {
    const root = makeRoot();

    const { output, exitCode } = runStatus(
      ["--run", join(root, "no", "such", "run")],
      root,
    );

    expect(exitCode).not.toBe(0);
    expect(output.toLowerCase()).toContain("not found");
    // The offending path is identifiable in the message.
    expect(output).toContain("such");
  });

  it("fails when --run is given without a value", () => {
    const root = makeRoot();
    writeRunDir(root, "demo-stub", "run-20260810-090000", eventsFor("1111", "X"));

    const { output, exitCode } = runStatus(["--run"], root);

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/--run/);
  });
});

describe("afk status zero-arg auto-detect (#31)", () => {
  it("prints which run it auto-detected before the rendered view", () => {
    const root = makeRoot();
    const latest = writeRunDir(
      root,
      "demo-stub",
      "run-20260818-110000",
      eventsFor("4444", "Latest"),
    );

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    const announceIdx = output.search(/auto-detected latest run/i);
    expect(announceIdx).toBeGreaterThan(-1);
    // The announcement names the picked run dir and precedes the view.
    const firstLine = output.slice(0, output.indexOf("\n"));
    expect(firstLine).toContain(latest.split(/[\\/]/).pop()!);
    expect(announceIdx).toBeLessThan(output.indexOf("Run:"));
  });

  it("fails with a helpful message when .afk/logs does not exist", () => {
    const root = makeRoot();

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).not.toBe(0);
    expect(output.toLowerCase()).toContain("no");
  });

  it("--json stays a single valid JSON document (no prose line)", () => {
    const root = makeRoot();
    writeRunDir(
      root,
      "demo-stub",
      "run-20260818-110000",
      eventsFor("5555", "JsonRun"),
    );

    const { output, exitCode } = runStatus(["--json"], root);

    expect(exitCode).toBe(0);
    const model = JSON.parse(output); // throws if prose corrupted the doc
    expect(model.schemaVersion).toBe(1);
    expect(model.runDir).toContain("run-20260818-110000");
  });
});
