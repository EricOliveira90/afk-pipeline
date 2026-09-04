import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(() => {
  while (childProcesses.length > 0) {
    childProcesses.pop()!.kill("SIGKILL");
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const INITIALIZER_SCRIPT = `
  import { appendFileSync, existsSync, writeFileSync } from "node:fs";
  import { withFileLock } from "./src/file-lock.ts";
  const [target, ready, release, entered, order] = process.argv.slice(1);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  withFileLock(target, () => {
    writeFileSync(entered, "initializer");
    appendFileSync(order, "initializer\\n");
  }, {
    timeoutMs: 5_000,
    pollMs: 10,
    afterLockPublished: () => {
      writeFileSync(ready, "ready");
      while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 10);
    },
  });
`;

const CONTENDER_SCRIPT = `
  import { appendFileSync, writeFileSync } from "node:fs";
  import { withFileLock } from "./src/file-lock.ts";
  const [target, ready, entered, order] = process.argv.slice(1);
  writeFileSync(ready, "ready");
  withFileLock(target, () => {
    writeFileSync(entered, "contender");
    appendFileSync(order, "contender\\n");
  }, {
    timeoutMs: 5_000,
    pollMs: 10,
  });
`;

function spawnChild(script: string, args: string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, ...args],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childProcesses.push(child);
  return child;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === 0) return;
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  if (code !== 0) {
    throw new Error(
      `Child exited ${code}: ${Buffer.concat(stderr).toString("utf-8")}`,
    );
  }
}

describe("withFileLock", () => {
  // This requires a new spawned scenario: the bug exists only between two
  // independent OS processes while one pauses at the atomic publication seam.
  it("does not let a contender steal a live initializer paused after lock publication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-file-lock-"));
    tempDirs.push(dir);
    const target = join(dir, "state.json");
    const initializerReady = join(dir, "initializer-ready");
    const releaseInitializer = join(dir, "release-initializer");
    const initializerEntered = join(dir, "initializer-entered");
    const contenderReady = join(dir, "contender-ready");
    const contenderEntered = join(dir, "contender-entered");
    const order = join(dir, "entry-order");

    const initializer = spawnChild(INITIALIZER_SCRIPT, [
      target,
      initializerReady,
      releaseInitializer,
      initializerEntered,
      order,
    ]);
    await waitForFile(initializerReady);

    const contender = spawnChild(CONTENDER_SCRIPT, [
      target,
      contenderReady,
      contenderEntered,
      order,
    ]);
    await waitForFile(contenderReady);

    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(existsSync(contenderEntered)).toBe(false);

    writeFileSync(releaseInitializer, "release");
    await Promise.all([waitForChild(initializer), waitForChild(contender)]);
    expect(existsSync(initializerEntered)).toBe(true);
    expect(existsSync(contenderEntered)).toBe(true);
    expect(readFileSync(order, "utf-8")).toBe("initializer\ncontender\n");
  });
});
