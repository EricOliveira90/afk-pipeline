import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreShipSanity } from "./orchestrator.js";

/**
 * Tests for the pre-ship sanity gate. The gate detects which scripts a
 * project defines and runs them in order; missing scripts are skipped, not
 * failed. Each test creates a throwaway `package.json` with crafted scripts
 * so we can drive PASS/FAIL/SKIP without spawning real linters.
 */

const tempDirs: string[] = [];

function makeProject(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-sanity-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts }),
    "utf-8",
  );
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
});

describe("runPreShipSanity", () => {
  it("returns ok with no failures when no package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-sanity-"));
    tempDirs.push(dir);
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
  });

  it("skips steps not defined in package.json (lint absent → not a failure)", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
  });

  it("passes when all defined scripts succeed", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
  });

  it("reports the failing step name when lint exits non-zero", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(1)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["lint"]);
  });

  it("falls back to `test` when `test:run` is not defined", () => {
    const dir = makeProject({
      test: "node -e \"process.exit(1)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["tests"]);
  });

  it("collects multiple failures across steps", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(1)\"",
      lint: "node -e \"process.exit(1)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["typecheck", "lint"]);
  });
});
