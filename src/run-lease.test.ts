/**
 * Host-wide run lease (#275, ADR 0069).
 *
 * Almost everything here is rung 1 of AGENTS.md's assertion ladder: owner
 * parsing, the staleness verdict, acquisition/refusal/override and
 * compare-before-delete release are exercised in-process with injected
 * probes and a temp base directory — no child processes, no PowerShell.
 *
 * One child-process scenario exists at the bottom, and it is deliberate:
 * the lease's whole job is exclusion between independent OS processes, and
 * PID-death recovery and takeover races cannot be observed from a single
 * process. It spawns plain Node children (the src/file-lock.test.ts
 * pattern), never a pipeline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostRunLease,
  classifyLeaseOwner,
  parseRunLeaseOwner,
  probeProcessBirth,
  type LeaseProbes,
  type RunLeaseOwner,
} from "./run-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-run-lease-"));
  tempDirs.push(dir);
  return dir;
}

function validOwner(overrides: Partial<RunLeaseOwner> = {}): RunLeaseOwner {
  return {
    version: 1,
    leaseId: "lease-1",
    pid: 4242,
    birth: "birth-a",
    hostname: "host-a",
    provider: "kiro",
    prdSlug: "demo",
    prdDir: "C:/repo/.kiro/specs/demo",
    cwd: "C:/repo",
    argv: ["node", "afk", "--prd-dir", "x"],
    acquiredAt: "2026-09-13T10:00:00.000Z",
    ...overrides,
  };
}

/** Probes that see one live owner process and this test's own process. */
function fakeProbes(overrides: Partial<LeaseProbes> = {}): LeaseProbes {
  return {
    pidIsAlive: () => true,
    processBirth: (pid) => (pid === process.pid ? "self-birth" : "birth-a"),
    hostname: () => "host-a",
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

function writeLease(baseDir: string, owner: RunLeaseOwner | string): void {
  const leaseDir = join(baseDir, "run-lease");
  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(
    join(leaseDir, "owner.json"),
    typeof owner === "string" ? owner : JSON.stringify(owner),
  );
}

function readLeaseOwner(baseDir: string): RunLeaseOwner | null {
  return parseRunLeaseOwner(
    readFileSync(join(baseDir, "run-lease", "owner.json"), "utf-8"),
  );
}

describe("parseRunLeaseOwner", () => {
  it("round-trips a complete v1 record", () => {
    const owner = validOwner();
    expect(parseRunLeaseOwner(JSON.stringify(owner))).toEqual(owner);
  });

  it.each([
    ["not JSON", "{nope"],
    ["wrong version", JSON.stringify({ ...validOwner(), version: 2 })],
    ["empty leaseId", JSON.stringify(validOwner({ leaseId: "" }))],
    ["non-integer pid", JSON.stringify({ ...validOwner(), pid: "77" })],
    ["zero pid", JSON.stringify(validOwner({ pid: 0 }))],
    ["missing birth", JSON.stringify({ ...validOwner(), birth: undefined })],
    [
      "non-string argv entry",
      JSON.stringify({ ...validOwner(), argv: ["ok", 5] }),
    ],
    ["array body", JSON.stringify([validOwner()])],
  ])("rejects %s as corrupt (null, never guessed stale)", (_name, text) => {
    expect(parseRunLeaseOwner(text)).toBeNull();
  });
});

describe("classifyLeaseOwner", () => {
  it("classifies a corrupt owner as unverifiable", () => {
    const verdict = classifyLeaseOwner(null, fakeProbes());
    expect(verdict.kind).toBe("unverifiable");
  });

  it("classifies a foreign hostname as unverifiable — its PID cannot be probed", () => {
    const verdict = classifyLeaseOwner(
      validOwner({ hostname: "other-host" }),
      fakeProbes(),
    );
    expect(verdict.kind).toBe("unverifiable");
  });

  it("classifies a missing PID as conclusively stale", () => {
    const verdict = classifyLeaseOwner(
      validOwner(),
      fakeProbes({ pidIsAlive: () => false }),
    );
    expect(verdict).toEqual({
      kind: "stale",
      reason: expect.stringContaining("no longer exists"),
    });
  });

  it("classifies a live PID with a different birth identity as stale (PID reuse)", () => {
    const verdict = classifyLeaseOwner(
      validOwner({ birth: "birth-old" }),
      fakeProbes({ processBirth: () => "birth-new" }),
    );
    expect(verdict).toEqual({
      kind: "stale",
      reason: expect.stringContaining("reused"),
    });
  });

  it("fails closed when the owner recorded no birth identity", () => {
    const verdict = classifyLeaseOwner(
      validOwner({ birth: "" }),
      fakeProbes(),
    );
    expect(verdict.kind).toBe("unverifiable");
  });

  it("fails closed when a live PID's birth identity cannot be read", () => {
    const verdict = classifyLeaseOwner(
      validOwner(),
      fakeProbes({ processBirth: () => undefined }),
    );
    expect(verdict.kind).toBe("unverifiable");
  });

  it("never classifies a live owner with a matching birth identity as stale", () => {
    const verdict = classifyLeaseOwner(validOwner(), fakeProbes());
    expect(verdict.kind).toBe("live");
  });
});

describe("probeProcessBirth", () => {
  it("reads a stable identity for this very process", () => {
    const first = probeProcessBirth(process.pid);
    expect(first).toBeTruthy();
    expect(probeProcessBirth(process.pid)).toBe(first);
  });

  it("returns undefined for an invalid pid without probing", () => {
    expect(probeProcessBirth(0)).toBeUndefined();
    expect(probeProcessBirth(-5)).toBeUndefined();
    expect(probeProcessBirth(1.5 as number)).toBeUndefined();
  });
});

describe("acquireHostRunLease", () => {
  const request = { provider: "kiro", prdSlug: "demo", prdDir: "C:/repo/.kiro/specs/demo" };

  it("acquires a free lease and publishes a complete owner record", () => {
    const baseDir = tempBase();
    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes(),
    });

    expect(result.outcome).toBe("acquired");
    const owner = readLeaseOwner(baseDir);
    expect(owner).toMatchObject({
      version: 1,
      pid: process.pid,
      birth: "self-birth",
      hostname: "host-a",
      provider: "kiro",
      prdSlug: "demo",
      cwd: process.cwd(),
    });
    expect(owner!.argv).toEqual(process.argv);
    // No staging or quarantine debris left beside the canonical lease.
    expect(readdirSync(baseDir)).toEqual(["run-lease"]);
  });

  it("refuses a live owner before any side effect and names it plus the override", () => {
    const baseDir = tempBase();
    writeLease(baseDir, validOwner());

    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes(),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("live-owner");
    expect(result.message).toContain(join(baseDir, "run-lease"));
    expect(result.message).toContain("Owner PID: 4242");
    expect(result.message).toContain("2026-09-13T10:00:00.000Z (120 min ago)");
    expect(result.message).toContain("Provider: kiro");
    expect(result.message).toContain("PRD: demo");
    expect(result.message).toContain("Cwd: C:/repo");
    expect(result.message).toContain("node afk --prd-dir x");
    expect(result.message).toContain("--allow-concurrent-run");
    // The refusal touched nothing: the owner's lease is byte-identical.
    expect(readLeaseOwner(baseDir)).toEqual(validOwner());
  });

  it("fails closed on a corrupt owner record and says age proves nothing", () => {
    const baseDir = tempBase();
    writeLease(baseDir, "{corrupt");

    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes(),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("unverifiable-owner");
    expect(result.message).toContain("failing closed");
    expect(result.message).toContain("Age alone never proves staleness");
    expect(result.message).toContain("--allow-concurrent-run");
    expect(existsSync(join(baseDir, "run-lease"))).toBe(true);
  });

  it("fails closed on a live PID whose identity cannot be read", () => {
    const baseDir = tempBase();
    writeLease(baseDir, validOwner());

    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes({
        processBirth: (pid) =>
          pid === process.pid ? "self-birth" : undefined,
      }),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("unverifiable-owner");
  });

  it("recovers a dead owner's lease, reports it, and removes the quarantined directory", () => {
    const baseDir = tempBase();
    writeLease(baseDir, validOwner());

    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes({ pidIsAlive: (pid) => pid === process.pid }),
    });

    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") throw new Error("unreachable");
    expect(result.recovered).toBeDefined();
    expect(result.recovered!.reason).toContain("no longer exists");
    expect(result.recovered!.owner).toEqual(validOwner());
    expect(readLeaseOwner(baseDir)?.pid).toBe(process.pid);
    expect(readdirSync(baseDir)).toEqual(["run-lease"]);
  });

  it("recovers a PID-reused owner's lease", () => {
    const baseDir = tempBase();
    writeLease(baseDir, validOwner({ birth: "birth-old" }));

    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes({
        processBirth: (pid) =>
          pid === process.pid ? "self-birth" : "birth-new",
      }),
    });

    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") throw new Error("unreachable");
    expect(result.recovered!.reason).toContain("reused");
  });

  it("proceeds without a lease under --allow-concurrent-run, warning and leaving the owner untouched", () => {
    const baseDir = tempBase();
    writeLease(baseDir, validOwner());

    const result = acquireHostRunLease(
      { ...request, allowConcurrentRun: true },
      { baseDir, probes: fakeProbes() },
    );

    expect(result.outcome).toBe("proceeding-without-lease");
    if (result.outcome !== "proceeding-without-lease") {
      throw new Error("unreachable");
    }
    expect(result.warning).toContain("WARNING");
    expect(result.warning).toContain("--allow-concurrent-run");
    expect(result.warning).toContain("Owner PID: 4242");
    expect(result.warning).toContain("left untouched");
    expect(readLeaseOwner(baseDir)).toEqual(validOwner());
  });

  it("acquires normally under --allow-concurrent-run when the lease is free", () => {
    const baseDir = tempBase();
    const result = acquireHostRunLease(
      { ...request, allowConcurrentRun: true },
      { baseDir, probes: fakeProbes() },
    );
    expect(result.outcome).toBe("acquired");
  });

  it("releases only its own lease id, never a successor's (compare-before-delete)", () => {
    const baseDir = tempBase();
    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes(),
    });
    if (result.outcome !== "acquired") throw new Error("setup failed");

    // A successor took over (as after a stale recovery of this process).
    const successor = validOwner({ leaseId: "successor-lease" });
    rmSync(join(baseDir, "run-lease"), { recursive: true, force: true });
    writeLease(baseDir, successor);

    result.handle.release();
    expect(readLeaseOwner(baseDir)).toEqual(successor);
  });

  it("release removes its own lease and is idempotent", () => {
    const baseDir = tempBase();
    const result = acquireHostRunLease(request, {
      baseDir,
      probes: fakeProbes(),
    });
    if (result.outcome !== "acquired") throw new Error("setup failed");

    result.handle.release();
    expect(existsSync(join(baseDir, "run-lease"))).toBe(false);
    result.handle.release();
    expect(existsSync(join(baseDir, "run-lease"))).toBe(false);
  });
});

/**
 * The one spawned scenario, per the issue's acceptance criteria: exclusion,
 * crash recovery and takeover races exist only between independent OS
 * processes, so no in-process assertion can carry them. Children run the
 * real module with real probes (real PIDs, real birth identities) against a
 * temp base directory; nothing here starts a pipeline.
 */
describe("host run lease across real processes", () => {
  const childProcesses: ChildProcess[] = [];
  const childStderr = new Map<number, string[]>();

  afterEach(() => {
    while (childProcesses.length > 0) {
      childProcesses.pop()!.kill("SIGKILL");
    }
  });

  const CHILD_SCRIPT = `
    import { existsSync, writeFileSync } from "node:fs";
    import { acquireHostRunLease } from "./src/run-lease.ts";
    const [baseDir, resultPath, holdUntil] = process.argv.slice(1);
    const result = acquireHostRunLease(
      { provider: "test", prdSlug: "demo", prdDir: "demo" },
      { baseDir },
    );
    writeFileSync(resultPath, JSON.stringify({
      pid: process.pid,
      outcome: result.outcome,
      reason: result.outcome === "refused" ? result.reason : null,
      recovered: result.outcome === "acquired" ? (result.recovered ?? null) : null,
    }));
    if (result.outcome === "acquired" && holdUntil) {
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(holdUntil)) Atomics.wait(sleeper, 0, 0, 25);
      result.handle.release();
    }
  `;

  function spawnChild(args: string[]): ChildProcess {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT, ...args],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: string[] = [];
    childStderr.set(child.pid ?? -1, chunks);
    child.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
    childProcesses.push(child);
    return child;
  }

  function diagnostics(child: ChildProcess): string {
    return (childStderr.get(child.pid ?? -1) ?? []).join("").trim();
  }

  /** Every wait is bounded so a hang reports what it was waiting for. */
  async function waitForExit(child: ChildProcess, label: string): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for ${label} (pid ${child.pid}) to exit; stderr:\n${diagnostics(child)}`,
          ),
        );
      }, 30_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function waitForFile(path: string, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label} at ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  interface ChildReport {
    pid: number;
    outcome: string;
    reason: string | null;
    recovered: { reason: string } | null;
  }

  async function readReport(path: string, label: string): Promise<ChildReport> {
    await waitForFile(path, label);
    // The write is not atomic; retry until the JSON parses whole.
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as ChildReport;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  it("excludes a second process, recovers a killed owner, and lets exactly one contender take over", async () => {
    const baseDir = tempBase();
    const scratch = mkdtempSync(join(tmpdir(), "afk-run-lease-io-"));
    tempDirs.push(scratch);

    // Contention: A acquires and holds; B is refused with A named live.
    const holderRelease = join(scratch, "release-holder");
    const holder = spawnChild([baseDir, join(scratch, "a.json"), holderRelease]);
    const holderReport = await readReport(join(scratch, "a.json"), "holder report");
    expect(holderReport.outcome, diagnostics(holder)).toBe("acquired");

    const contender = spawnChild([baseDir, join(scratch, "b.json")]);
    const contenderReport = await readReport(join(scratch, "b.json"), "contender report");
    expect(contenderReport.outcome, diagnostics(contender)).toBe("refused");
    expect(contenderReport.reason).toBe("live-owner");
    await waitForExit(contender, "refused contender");

    // Crash recovery: kill A hard so its lease leaks, then acquire from
    // this process with real probes — the dead PID is conclusively stale.
    const leakedOwner = readLeaseOwner(baseDir);
    expect(leakedOwner?.pid).toBe(holderReport.pid);
    holder.kill("SIGKILL");
    await waitForExit(holder, "killed holder");

    const recovery = acquireHostRunLease(
      { provider: "test", prdSlug: "demo", prdDir: "demo" },
      { baseDir },
    );
    expect(recovery.outcome).toBe("acquired");
    if (recovery.outcome !== "acquired") throw new Error("unreachable");
    expect(recovery.recovered?.reason).toContain(String(holderReport.pid));
    recovery.handle.release();

    // Simultaneous stale takeover: leak the dead owner's record again and
    // race two contenders at it. Exactly one may win.
    writeLease(baseDir, leakedOwner!);
    const winnerRelease = join(scratch, "release-winner");
    const raceA = spawnChild([baseDir, join(scratch, "c.json"), winnerRelease]);
    const raceB = spawnChild([baseDir, join(scratch, "d.json"), winnerRelease]);
    const [reportA, reportB] = await Promise.all([
      readReport(join(scratch, "c.json"), "first racer report"),
      readReport(join(scratch, "d.json"), "second racer report"),
    ]);
    const outcomes = [reportA.outcome, reportB.outcome].sort();
    expect(
      outcomes,
      `racers:\n${diagnostics(raceA)}\n${diagnostics(raceB)}`,
    ).toEqual(["acquired", "refused"]);
    const winner = reportA.outcome === "acquired" ? reportA : reportB;
    expect(readLeaseOwner(baseDir)?.pid).toBe(winner.pid);

    // The winner's release frees the canonical path for the next launch.
    writeFileSync(winnerRelease, "release");
    await waitForExit(raceA, "first racer");
    await waitForExit(raceB, "second racer");
    expect(existsSync(join(baseDir, "run-lease"))).toBe(false);
  }, 120_000);
});
