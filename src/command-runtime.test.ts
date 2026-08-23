import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeartbeatCommand, withCrossProcessLock } from "./command-runtime.js";

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
