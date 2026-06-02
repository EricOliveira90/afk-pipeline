import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports; the mock fn must be created in a
// hoisted block so it exists when the factory runs.
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));

import { verifyMigrationSync } from "./orchestrator.js";

/** Args arrays passed to each execFileSync call, for assertions. */
function calls(): string[][] {
  return execFileSync.mock.calls.map((c) => c[1] as string[]);
}

const isStart = (args: string[]) => args.includes("start");
const isStop = (args: string[]) => args.includes("stop");

describe("verifyMigrationSync", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("skip mode is a no-op and never shells out", () => {
    expect(verifyMigrationSync("/wt", "skip")).toEqual({ ok: true });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  describe("local-stack", () => {
    it("returns ok when the stack starts cleanly, and always stops", () => {
      execFileSync.mockImplementation(() => "");
      expect(verifyMigrationSync("/wt", "local-stack")).toEqual({ ok: true });
      expect(calls().some(isStart)).toBe(true);
      expect(calls().some(isStop)).toBe(true);
    });

    it("returns not-ok when migrations fail to apply, and still stops", () => {
      execFileSync.mockImplementation((_cmd, args: string[]) => {
        if (isStop(args)) return "";
        throw new Error("relation already exists");
      });
      const result = verifyMigrationSync("/wt", "local-stack");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/failed to apply/i);
      expect(calls().some(isStop)).toBe(true);
    });

    it("skips (ok) with a warning when Docker is unavailable", () => {
      execFileSync.mockImplementation((_cmd, args: string[]) => {
        if (isStop(args)) return "";
        throw new Error("Cannot connect to the Docker daemon");
      });
      expect(verifyMigrationSync("/wt", "local-stack")).toEqual({ ok: true });
      expect(calls().some(isStop)).toBe(true);
    });

    it("runs the gate in the supplied worktree cwd", () => {
      execFileSync.mockImplementation(() => "");
      verifyMigrationSync("/slice/worktree", "local-stack");
      const startCall = execFileSync.mock.calls.find((c) =>
        isStart(c[1] as string[]),
      );
      expect((startCall?.[2] as { cwd?: string })?.cwd).toBe("/slice/worktree");
    });
  });

  describe("linked (legacy)", () => {
    it("returns not-ok when the CLI throws (e.g. project not linked)", () => {
      execFileSync.mockImplementation(() => {
        throw new Error("Cannot find project ref. Have you run supabase link?");
      });
      expect(verifyMigrationSync("/repo", "linked").ok).toBe(false);
    });

    it("returns ok when every local row has a remote", () => {
      execFileSync.mockReturnValue("│ 042 │ 042 │ 042 │");
      expect(verifyMigrationSync("/repo", "linked")).toEqual({ ok: true });
    });
  });
});
