import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBoundedCommand,
  runHeartbeatCommand,
  withCrossProcessLock,
} from "./command-runtime.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runHeartbeatCommand", () => {
  it("keeps a long command alive while output heartbeats continue", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    // The child prints for ~2s against a 1.5s inactivity window, so
    // the promise resolves only if each output line genuinely resets
    // the watcher. The window comfortably exceeds shell+node spawn
    // latency (~400ms, worse under cold vitest transforms) so slow
    // startup cannot masquerade as inactivity.
    await expect(
      runHeartbeatCommand(
        'node -e "let n=0; const t=setInterval(()=>{ console.log(n++); if(n===100) clearInterval(t) }, 20)"',
        { cwd, inactivityTimeoutMs: 1_500, heartbeatIntervalMs: 20 },
      ),
    ).resolves.toBeUndefined();
  });

  it("kills a command after configurable output inactivity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    await expect(
      runHeartbeatCommand('node -e "setTimeout(()=>{}, 500)"', {
        cwd,
        inactivityTimeoutMs: 40,
        heartbeatIntervalMs: 10,
      }),
    ).rejects.toThrow(/no heartbeat for 40ms/);
  });
});

describe("runBoundedCommand", () => {
  it("streams stdout and stderr and returns structured exit evidence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    const output: string[] = [];

    const result = await runBoundedCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)",
      ],
      {
        cwd,
        inactivityTimeoutMs: 1_000,
        heartbeatIntervalMs: 20,
        wallClockTimeoutMs: 2_000,
        onOutput: (text) => output.push(text),
      },
    );

    expect(result).toMatchObject({ outcome: "EXITED", exitCode: 23 });
    expect(output.join("")).toContain("out");
    expect(output.join("")).toContain("err");
  });

  it("kills a silent parent and descendant on inactivity", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    const childPidPath = join(cwd, "child.pid");
    const childScript = join(cwd, "child.cjs");
    const parentScript = join(cwd, "parent.cjs");
    writeFileSync(childScript, "setInterval(() => {}, 1000);", "utf-8");
    writeFileSync(
      parentScript,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runBoundedCommand(process.execPath, [parentScript], {
      cwd,
      inactivityTimeoutMs: 100,
      heartbeatIntervalMs: 20,
      wallClockTimeoutMs: 2_000,
    });

    expect(result.outcome).toBe("INACTIVITY_TIMEOUT");
    const childPid = Number(readFileSync(childPidPath, "utf-8"));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("enforces the wall-clock limit despite continuous output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    const result = await runBoundedCommand(
      process.execPath,
      [
        "-e",
        "setInterval(() => process.stdout.write('beat\\n'), 20)",
      ],
      {
        cwd,
        inactivityTimeoutMs: 1_000,
        heartbeatIntervalMs: 20,
        wallClockTimeoutMs: 150,
      },
    );

    expect(result.outcome).toBe("WALL_CLOCK_TIMEOUT");
  });

  it("propagates cancellation through process-tree termination", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    dirs.push(cwd);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runBoundedCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd,
        inactivityTimeoutMs: 1_000,
        heartbeatIntervalMs: 20,
        wallClockTimeoutMs: 2_000,
        signal: controller.signal,
      },
    );

    expect(result.outcome).toBe("CANCELLED");
  });
});

describe("withCrossProcessLock", () => {
  it("serializes contenders using a filesystem lock", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-lock-"));
    dirs.push(cwd);
    const lock = join(cwd, "preview.lock");
    const order: string[] = [];
    const options = { acquireTimeoutMs: 1_000, heartbeatIntervalMs: 10, staleAfterMs: 500 };

    const first = withCrossProcessLock(lock, options, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withCrossProcessLock(lock, options, async () => {
      order.push("second-start");
      order.push("second-end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
