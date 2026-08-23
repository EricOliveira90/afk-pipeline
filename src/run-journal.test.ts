import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./run-journal.js";
import { loadRunState } from "./run-state.js";
import { lifecycle, type SliceIdentity } from "./slice-lifecycle.js";

const tempDirs: string[] = [];
const SLICE: SliceIdentity = {
  ghIssue: "40",
  title: "Preserve cause",
  branch: "afk/demo-slice-01",
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-run-journal-"));
  tempDirs.push(repo);
  return repo;
}

function eventsOf(journal: RunJournal): Array<Record<string, unknown>> {
  return readFileSync(join(journal.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("RunJournal.recordTerminal", () => {
  it("rejects terminal phases at the non-terminal tracking interface", () => {
    const journal = new RunJournal(makeRepo(), "guard");

    expect(() =>
      journal.trackSlice(
        lifecycle.error(SLICE, { genRounds: 0, evalRounds: 0 }, "bypassed"),
      ),
    ).toThrow(/must use recordTerminal/);
  });

  it("preserves one real cause across lifecycle, run state, run log, and event", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "demo");
    journal.setFeatureBranch("feat/demo");
    journal.trackSlice(
      lifecycle.running(SLICE, { genRounds: 2, evalRounds: 1 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const cause =
      "Agent evaluator-contract exited with code 1 after provider disconnect";
    const recorded = journal.recordTerminal(SLICE, {
      phase: "ERROR",
      error: cause,
    });

    expect(recorded).toEqual({
      ...SLICE,
      phase: "ERROR",
      progress: { genRounds: 2, evalRounds: 1 },
      error: cause,
    });
    expect(journal.getSlice("40")).toEqual(recorded);
    expect(loadRunState(repo, "demo").slices["40"]).toEqual({
      phase: "ERROR",
      branch: SLICE.branch,
      error: cause,
    });
    expect(readFileSync(join(journal.runDir, "run.log"), "utf-8")).toContain(
      `ERROR — ${cause}`,
    );
    const outcomes = eventsOf(journal).filter(
      (event) => event.type === "slice-outcome",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.slice).toEqual(recorded);
  });

  it("retries after state persistence fails, then deduplicates completed calls", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "retry");
    journal.trackSlice(lifecycle.running(SLICE));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stateBlocker = join(repo, ".afk", "state");
    mkdirSync(join(repo, ".afk"), { recursive: true });
    writeFileSync(stateBlocker, "not a directory", "utf-8");

    const outcome = { phase: "STUCK", error: "QA failed" } as const;
    expect(() => journal.recordTerminal(SLICE, outcome)).toThrow();
    expect(journal.getSlice("40")?.phase).toBe("RUNNING");
    expect(eventsOf(journal).filter((event) => event.type === "slice-outcome"))
      .toHaveLength(0);

    rmSync(stateBlocker, { force: true });
    journal.recordTerminal(SLICE, outcome);
    journal.recordTerminal(SLICE, outcome);

    expect(loadRunState(repo, "retry").slices["40"]?.error).toBe("QA failed");
    expect(eventsOf(journal).filter((event) => event.type === "slice-outcome"))
      .toHaveLength(1);
    expect(
      readFileSync(join(journal.runDir, "run.log"), "utf-8").match(
        /STUCK — QA failed/g,
      ),
    ).toHaveLength(1);
  });

  it("records MERGE-PENDING prefixes through the unchanged lifecycle event", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "merge-pending");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const recorded = journal.recordTerminal(SLICE, {
      phase: "MERGE-PENDING",
      error: "Migration prefix collision: 042",
      collidingPrefixes: ["042"],
    });

    expect(loadRunState(repo, "merge-pending").slices["40"]).toEqual({
      phase: "MERGE-PENDING",
      branch: SLICE.branch,
      error: "Migration prefix collision: 042",
      collidingPrefixes: ["042"],
    });
    expect(
      eventsOf(journal).find((event) => event.type === "slice-outcome")?.slice,
    ).toEqual(recorded);
  });
});
