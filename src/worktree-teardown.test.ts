import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Issue #102 review follow-ups for `removeWorktree`'s on-disk retry loop.
 *
 * These exercise the shapes a real filesystem will not reproduce on
 * demand — chiefly a `rmSync` that RETURNS while the directory survives
 * (a pending Windows delete, a junction, or a live process recreating
 * entries under us). The first fix for #102 checked its deadline only
 * inside `catch`, so that shape spun forever — inside a `finally` block,
 * and under the merge mutex, wedging the whole wave.
 *
 * `node:fs` is mocked so the loop's exits can be driven directly; the
 * git-admin steps are left to fail against a nonexistent repo, which is
 * exactly the swallow-and-continue path they already have.
 */

const fs = {
  exists: true,
  rm: vi.fn<(path: unknown) => void>(),
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: () => fs.exists,
    rmSync: (path: unknown) => fs.rm(path),
  };
});

const {
  DEFAULT_REMOVAL_TIMEOUT_MS,
  formatWorktreeSurvivorWarning,
  removeWorktree,
  removeWorktreeOrWarn,
} = await import("./git.js");

const REPO = "C:/afk-102-no-such-repo";
const WT = "C:/afk-102-no-such-repo/wt";

/** Quiescing is covered in worktree-processes.test.ts — stub it out here. */
const quietTree = async () => ({
  observed: [],
  terminated: [],
  survivors: [],
  verified: true,
});

describe("removeWorktree — bounded retries (issue #102)", () => {
  beforeEach(() => {
    fs.exists = true;
    fs.rm.mockReset();
  });

  it("stops at the deadline when rmSync succeeds but the directory survives", async () => {
    const result = await removeWorktree(REPO, WT, {
      timeoutMs: 200,
      quiesce: quietTree,
    });

    expect(result.removed).toBe(false);
    // Retried rather than giving up after one pass...
    expect(result.attempts).toBeGreaterThan(1);
    // ...and stopped rather than spinning: a 200ms budget with a 50ms
    // first backoff cannot fit an unbounded number of passes.
    expect(result.attempts).toBeLessThan(20);
    // No throw happened, so the result must still explain itself.
    expect(result.lastError).toMatch(/still present/i);
  });

  it("reports the thrown error when the lock is a transient EBUSY", async () => {
    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    fs.rm.mockImplementation(() => {
      throw busy;
    });

    const result = await removeWorktree(REPO, WT, {
      timeoutMs: 200,
      quiesce: quietTree,
    });

    expect(result.removed).toBe(false);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.lastError).toContain("EBUSY");
  });

  it("gives up immediately on an error that waiting cannot clear", async () => {
    fs.rm.mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left"), {
        code: "ENOSPC",
      });
    });

    const result = await removeWorktree(REPO, WT, {
      timeoutMs: 5_000,
      quiesce: quietTree,
    });

    expect(result.attempts).toBe(1);
    expect(result.lastError).toContain("ENOSPC");
  });

  it("stops on a fired abort signal instead of spending the full budget", async () => {
    const controller = new AbortController();
    fs.rm.mockImplementation(() => {
      // Abort during the first pass, as SIGINT would mid-teardown.
      controller.abort();
    });

    const result = await removeWorktree(REPO, WT, {
      timeoutMs: DEFAULT_REMOVAL_TIMEOUT_MS,
      signal: controller.signal,
      quiesce: quietTree,
    });

    expect(result.removed).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("returns as soon as the directory is gone", async () => {
    fs.rm.mockImplementation(() => {
      fs.exists = false;
    });

    const result = await removeWorktree(REPO, WT, { quiesce: quietTree });

    expect(result).toMatchObject({ removed: true, attempts: 1 });
    expect(result.lastError).toBeUndefined();
  });

  it("holds the git-admin mutex only across the git steps, never the waiting", async () => {
    const events: string[] = [];
    let held = false;
    const gitAdminMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
      held = true;
      events.push("mutex:acquire");
      try {
        return await fn();
      } finally {
        held = false;
        events.push("mutex:release");
      }
    };
    fs.rm.mockImplementation(() => {
      events.push(held ? "rm:UNDER-MUTEX" : "rm");
    });

    await removeWorktree(REPO, WT, {
      timeoutMs: 200,
      gitAdminMutex,
      quiesce: async () => {
        events.push(held ? "quiesce:UNDER-MUTEX" : "quiesce");
        return quietTree();
      },
    });

    // Two admin sections (remove, prune), and nothing slow inside them.
    expect(events.filter((e) => e === "mutex:acquire")).toHaveLength(2);
    expect(events).not.toContain("rm:UNDER-MUTEX");
    expect(events).not.toContain("quiesce:UNDER-MUTEX");
  });
});

describe("removeWorktreeOrWarn", () => {
  beforeEach(() => {
    fs.exists = true;
    fs.rm.mockReset();
  });

  it("warns once, naming the attempts and the ADR 0010 consequence", async () => {
    const warnings: string[] = [];

    await removeWorktreeOrWarn(
      REPO,
      WT,
      { label: "slice #7 worktree", warn: (m) => warnings.push(m) },
      { timeoutMs: 100, quiesce: quietTree },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("slice #7 worktree");
    expect(warnings[0]).toMatch(/removal attempt\(s\)/);
    expect(warnings[0]).toContain("ADR 0010");
  });

  it("stays silent when the directory is gone", async () => {
    fs.rm.mockImplementation(() => {
      fs.exists = false;
    });
    const warnings: string[] = [];

    await removeWorktreeOrWarn(
      REPO,
      WT,
      { label: "review worktree", warn: (m) => warnings.push(m) },
      { quiesce: quietTree },
    );

    expect(warnings).toEqual([]);
  });

  it("carries the surviving PIDs into the warning", () => {
    const warning = formatWorktreeSurvivorWarning("slice #3 worktree", WT, {
      removed: false,
      attempts: 4,
      lastError: "EBUSY: resource busy or locked",
      processes: {
        observed: [111, 222],
        terminated: [111],
        survivors: [222],
        verified: true,
      },
    });

    expect(warning).toContain("4 removal attempt(s)");
    expect(warning).toContain("PIDs 222");
    expect(warning).toContain("EBUSY");
  });
});
