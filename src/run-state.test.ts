import { spawn, type ChildProcess } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRunState,
  saveSliceState,
  saveRunState,
  saveAppliedWaivers,
  isSliceComplete,
  adaptLoadedState,
  getResumeAttempts,
  recordRetryDecision,
  chargeResumeAttempt,
  clearSliceStateForDispatch,
  saveSliceStateIfUnchanged,
  approvedBaselineFor,
  recordApprovedBaseline,
  cleanerRoundsSpent,
  recordQualityStageOutcome,
  recordQualityStageRound,
  recoveryLineageFor,
  appendRecoveryLineageEvent,
  updateRunState,
  RECOVERY_FINGERPRINT_ABSENT,
  RUN_STATE_VERSION,
  type PersistedRecoveryLineageEvent,
  type RunState,
} from "./run-state.js";
import { cleanerRoundsRemaining, MAX_CLEANER_ROUNDS } from "./bounds.js";

const tempDirs: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(() => {
  while (childProcesses.length > 0) {
    childProcesses.pop()!.kill("SIGKILL");
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-runstate-"));
  tempDirs.push(dir);
  return dir;
}

const CHILD_SCRIPT = `
  import { existsSync, writeFileSync } from "node:fs";
  import { saveSliceState, updateRunState } from "./src/run-state.ts";
  const [mode, repo, ready, release] = process.argv.slice(1);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  if (mode === "hold") {
    updateRunState(repo, "concurrent", (state) => {
      writeFileSync(ready, "ready");
      while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 20);
      state.slices["100"] = { phase: "ERROR", error: "first writer" };
    });
  } else if (mode === "die") {
    updateRunState(repo, "concurrent", () => {
      writeFileSync(ready, "ready");
      while (true) Atomics.wait(sleeper, 0, 0, 1000);
    });
  } else if (mode === "write") {
    saveSliceState(repo, "concurrent", "200", {
      phase: "STUCK",
      error: "second writer",
    });
  }
`;

function spawnStateChild(
  mode: "hold" | "die" | "write",
  repo: string,
  ready: string,
  release: string,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      CHILD_SCRIPT,
      mode,
      repo,
      ready,
      release,
    ],
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
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`Child exited ${child.exitCode}`);
    return;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  if (result.code !== 0) {
    throw new Error(
      `Child exited ${result.code ?? result.signal}\n` +
        Buffer.concat(stdout).toString("utf-8") +
        Buffer.concat(stderr).toString("utf-8"),
    );
  }
}

describe("adaptLoadedState", () => {
  it("loads a v0 (unversioned) file by renaming status -> phase", () => {
    const v0 = {
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {
        "100": { status: "PASS", branch: "afk/demo-01", mergedToFeature: true },
        "200": { status: "STUCK", branch: "afk/demo-02" },
        "300": { status: "ESCALATE", branch: "afk/demo-03" },
      },
    };
    const adapted = adaptLoadedState(v0, "demo");
    expect(adapted.version).toBe(RUN_STATE_VERSION);
    expect(adapted.slices["100"]!.phase).toBe("PASS");
    expect(adapted.slices["100"]!.mergedToFeature).toBe(true);
    expect(adapted.slices["200"]!.phase).toBe("STUCK");
    expect(adapted.slices["300"]!.phase).toBe("ESCALATE");
  });

  it("upgrades v1 files to the current version", () => {
    const v1 = {
      version: 1,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {
        "100": { phase: "PASS", branch: "afk/demo", mergedToFeature: true },
      },
    };
    const adapted = adaptLoadedState(v1, "demo");
    expect(adapted.version).toBe(RUN_STATE_VERSION);
    expect(adapted.slices["100"]!.phase).toBe("PASS");
  });

  it("throws on unknown phase strings to surface invalid persisted state", () => {
    expect(() =>
      adaptLoadedState(
        { slices: { "1": { status: "WAT" } } },
        "demo",
      ),
    ).toThrow(/Unknown phase/);
  });

  it("accepts MERGE-PENDING and keeps its colliding prefixes (ADR 0029)", () => {
    const adapted = adaptLoadedState(
      {
        version: 1,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: {
          "100": {
            phase: "MERGE-PENDING",
            branch: "afk/demo-slice-01",
            error: "Migration prefix collision: 042 …",
            collidingPrefixes: ["042"],
          },
        },
      },
      "demo",
    );
    expect(adapted.slices["100"]!.phase).toBe("MERGE-PENDING");
    expect(adapted.slices["100"]!.collidingPrefixes).toEqual(["042"]);
  });

  it("drops a malformed collidingPrefixes rather than wedging the load", () => {
    const adapted = adaptLoadedState(
      {
        version: 1,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: {
          "100": {
            phase: "MERGE-PENDING",
            error: "collision",
            collidingPrefixes: "042",
          },
        },
      },
      "demo",
    );
    expect(adapted.slices["100"]!.phase).toBe("MERGE-PENDING");
    expect(adapted.slices["100"]!.collidingPrefixes).toBeUndefined();
  });
});

/**
 * v4 is purely additive: a per-slice locator for the approved-baseline
 * artifact (#91 AC5). The artifact file stays canonical, so the locator's job
 * is only to let a resumed run *find* it without re-deriving the checkpoint —
 * which is why a malformed entry degrades to absent instead of throwing.
 */
describe("[behavior:B-06] approved-baseline locator", () => {
  it("[behavior:B-06] loads a v3 file as v4 with no baseline recorded", () => {
    const adapted = adaptLoadedState(
      {
        version: 3,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: { "70": { phase: "PASS", branch: "afk/demo-01" } },
      },
      "demo",
    );
    expect(adapted.version).toBe(RUN_STATE_VERSION);
    expect(adapted.approvedBaselines).toBeUndefined();
    expect(approvedBaselineFor(adapted, "70")).toBeUndefined();
    // The slice state a v3 file carried is untouched by the addition.
    expect(adapted.slices["70"]!.phase).toBe("PASS");
  });

  it("[behavior:B-06] round-trips a recorded locator through a v4 file", () => {
    const adapted = adaptLoadedState(
      {
        version: 4,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: {},
        approvedBaselines: {
          "70": {
            treeId: "a".repeat(40),
            commit: "b".repeat(40),
            artifactPath: ".afk/artifacts/demo/slice-01/approved-baseline.json",
          },
        },
      },
      "demo",
    );
    expect(approvedBaselineFor(adapted, "70")).toEqual({
      treeId: "a".repeat(40),
      commit: "b".repeat(40),
      artifactPath: ".afk/artifacts/demo/slice-01/approved-baseline.json",
    });
    expect(approvedBaselineFor(adapted, "71")).toBeUndefined();
  });

  it("[behavior:B-06] drops malformed locators rather than wedging the load", () => {
    const adapted = adaptLoadedState(
      {
        version: 4,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: {},
        approvedBaselines: {
          // Missing commit, blank tree, and a non-object entry: each degrades
          // to "no baseline recorded" for that slice alone.
          "70": { treeId: "a".repeat(40), artifactPath: "x.json" },
          "71": { treeId: "  ", commit: "b", artifactPath: "x.json" },
          "72": "not-an-object",
          "73": {
            treeId: "c".repeat(40),
            commit: "d".repeat(40),
            artifactPath: "keep.json",
          },
        },
      },
      "demo",
    );
    expect(Object.keys(adapted.approvedBaselines ?? {})).toEqual(["73"]);
  });

  it("[behavior:B-06] records a locator on disk and reads it back", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "70", {
      phase: "STUCK",
      branch: "afk/demo-01",
    });

    recordApprovedBaseline(repo, "demo", "70", {
      treeId: "e".repeat(40),
      commit: "f".repeat(40),
      artifactPath: ".afk/artifacts/demo/slice-01/approved-baseline.json",
    });

    const loaded = loadRunState(repo, "demo");
    expect(loaded.version).toBe(RUN_STATE_VERSION);
    expect(approvedBaselineFor(loaded, "70")).toEqual({
      treeId: "e".repeat(40),
      commit: "f".repeat(40),
      artifactPath: ".afk/artifacts/demo/slice-01/approved-baseline.json",
    });
    // Additive: the slice record the run already had is still there.
    expect(loaded.slices["70"]!.phase).toBe("STUCK");

    // A second slice's baseline joins the map instead of replacing it.
    recordApprovedBaseline(repo, "demo", "71", {
      treeId: "1".repeat(40),
      commit: "2".repeat(40),
      artifactPath: ".afk/artifacts/demo/slice-02/approved-baseline.json",
    });
    const reloaded = loadRunState(repo, "demo");
    expect(Object.keys(reloaded.approvedBaselines ?? {}).sort()).toEqual([
      "70",
      "71",
    ]);
  });
});

describe("loadRunState + saveSliceState end-to-end", () => {
  it("loads a v0 file from disk and upgrades it on next save", () => {
    const repo = makeRepo();
    const slug = "demo";
    const stateDir = join(repo, ".afk", "state");
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, `${slug}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          prdSlug: slug,
          featureBranch: "feat/demo",
          slices: {
            "100": { status: "PASS", branch: "afk/demo", mergedToFeature: true },
            "200": { status: "STUCK", branch: "afk/demo-2" },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const loaded = loadRunState(repo, slug);
    expect(loaded.version).toBe(RUN_STATE_VERSION);
    expect(loaded.slices["100"]!.phase).toBe("PASS");
    expect(isSliceComplete(loaded, "100")).toBe(true);
    expect(isSliceComplete(loaded, "200")).toBe(false);

    saveSliceState(repo, slug, "300", {
      phase: "ERROR",
      branch: "afk/demo-3",
      error: "boom",
    });

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(RUN_STATE_VERSION);
    expect(onDisk.slices["100"].phase).toBe("PASS");
    expect(onDisk.slices["300"].phase).toBe("ERROR");
    expect(onDisk.slices["300"].error).toBe("boom");
  });

  /**
   * Estate audit (ADR 0055 Seam 2, plan step 9). Two lifecycle operations
   * derive their treatment of a slice's worktree from this one predicate:
   * `--only-failed` selects every scope member that is not complete, and
   * launch preflight retains the worktree of every incomplete manifest
   * slice instead of refusing over it as a leftover. A park reading
   * "complete" would strand it in both — never re-dispatched, and its
   * worktree reported as debris to clear with `clean-failed`.
   */
  it("never reads a parked slice as complete — the predicate --only-failed and preflight retention share", () => {
    const repo = makeRepo();
    saveSliceState(repo, "parked", "8181", {
      phase: "AWAITING-ADJUDICATION",
      branch: "afk/parked-slice-01",
      error: "contract negotiation reached IMPASSE on F-01",
    });
    expect(isSliceComplete(loadRunState(repo, "parked"), "8181")).toBe(false);
  });

  it("returns a fresh current-version state when no file exists", () => {
    const repo = makeRepo();
    const loaded = loadRunState(repo, "fresh");
    expect(loaded).toEqual({
      version: RUN_STATE_VERSION,
      prdSlug: "fresh",
      featureBranch: "feat/fresh",
      slices: {},
    });
  });
  it("preserves the resolved scope across later slice-state saves", () => {
    const repo = makeRepo();
    const state = loadRunState(repo, "scoped");
    state.scope = {
      mode: "explicit",
      slices: [{ number: "01", ghIssue: "100" }],
    };
    saveRunState(repo, state);

    saveSliceState(repo, "scoped", "100", {
      phase: "PASS",
      mergedToFeature: true,
    });

    expect(loadRunState(repo, "scoped").scope).toEqual(state.scope);
  });

  it("refuses a stale whole-state replacement without losing a concurrent update", () => {
    const repo = makeRepo();
    const stale = loadRunState(repo, "whole-state");
    saveSliceState(repo, "whole-state", "129", {
      phase: "AWAITING-ADJUDICATION",
      error: "concurrent park",
    });

    expect(() => saveRunState(repo, stale)).toThrow(
      /Refusing to replace existing run state/,
    );
    expect(loadRunState(repo, "whole-state").slices["129"]).toEqual({
      phase: "AWAITING-ADJUDICATION",
      error: "concurrent park",
    });
  });
});


/**
 * Per-slice resume-attempt tracking (spec #33 / #36). The counter lives
 * in the run-state file so it survives launcher restarts; existing
 * state files without it must read as zero attempts.
 */
describe("resume-attempt tracking", () => {
  it("reads zero attempts from a state file that predates the field (backward compat)", () => {
    const repo = makeRepo();
    const p = join(repo, ".afk", "state", "demo.json");
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: { "100": { phase: "ERROR", error: "died" } },
      }),
      "utf-8",
    );
    const state = loadRunState(repo, "demo");
    expect(getResumeAttempts(state, "100")).toBe(0);
    expect(getResumeAttempts(state, "999")).toBe(0);
  });

  it("persists attempts + last decision across a reload, preserving slice records", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "100", { phase: "ERROR", error: "died" });
    recordRetryDecision(repo, "demo", "100", {
      attempts: 1,
      lastDecision: "resumed from 3 commits",
    });

    const state = loadRunState(repo, "demo");
    expect(getResumeAttempts(state, "100")).toBe(1);
    expect(state.resume?.["100"]?.lastDecision).toBe("resumed from 3 commits");
    // The slice's own record was not clobbered.
    expect(state.slices["100"]!.phase).toBe("ERROR");
  });

  it("a later saveSliceState does not clobber the resume record", () => {
    const repo = makeRepo();
    recordRetryDecision(repo, "demo", "100", {
      attempts: 2,
      lastDecision: "resumed from 5 commits",
    });
    saveSliceState(repo, "demo", "100", { phase: "STUCK", error: "gave up" });

    const state = loadRunState(repo, "demo");
    expect(getResumeAttempts(state, "100")).toBe(2);
    expect(state.slices["100"]!.phase).toBe("STUCK");
  });

  it("drops malformed resume entries instead of throwing", () => {
    const repo = makeRepo();
    const p = join(repo, ".afk", "state", "demo.json");
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: {},
        resume: { "100": { attempts: "not-a-number" }, "200": { attempts: 1 } },
      }),
      "utf-8",
    );
    const state = loadRunState(repo, "demo");
    expect(getResumeAttempts(state, "100")).toBe(0);
    expect(getResumeAttempts(state, "200")).toBe(1);
  });

  it("charges one attempt at a time, reading the persisted count (#188 defect 4)", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "100", { phase: "ERROR", error: "died" });
    recordRetryDecision(repo, "demo", "200", {
      attempts: 1,
      lastDecision: "resume planned; no attempt charged",
    });

    // From absent, and from an existing record. The new count is returned so
    // the caller can name it without a second read.
    expect(
      chargeResumeAttempt(repo, "demo", "100", (n) => `charged ${n}`),
    ).toBe(1);
    expect(
      chargeResumeAttempt(repo, "demo", "200", (n) => `charged ${n}`),
    ).toBe(2);

    const state = loadRunState(repo, "demo");
    expect(getResumeAttempts(state, "100")).toBe(1);
    expect(getResumeAttempts(state, "200")).toBe(2);
    expect(state.resume?.["100"]?.lastDecision).toBe("charged 1");
    expect(state.resume?.["200"]?.lastDecision).toBe("charged 2");
    // The slice's own record, and the other slice's resume entry, survive.
    expect(state.slices["100"]!.phase).toBe("ERROR");

    // The increment reads the file, not a value the caller captured earlier:
    // an interleaved slice-outcome write cannot roll it back.
    saveSliceState(repo, "demo", "100", { phase: "STUCK", error: "gave up" });
    expect(
      chargeResumeAttempt(repo, "demo", "100", (n) => `charged ${n}`),
    ).toBe(2);
    expect(getResumeAttempts(loadRunState(repo, "demo"), "100")).toBe(2);
  });
});

describe("clearSliceStateForDispatch", () => {
  /**
   * The #111 state fixture: a slice whose record carries every field a
   * previous attempt can leave behind, so a test that only cleared
   * `error` would still fail here.
   */
  function staleStateFile(repo: string): string {
    const dir = join(repo, ".afk", "state");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "demo.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 2,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        scope: { members: ["01", "02"] },
        slices: {
          "75": {
            phase: "ERROR",
            branch: "afk/demo-01",
            error: "exceeded 100 tool calls",
          },
          "76": {
            phase: "MERGE-PENDING",
            branch: "afk/demo-02",
            error: "migration prefix collision",
            collidingPrefixes: ["0042"],
          },
          "77": { phase: "PASS", branch: "afk/demo-03", mergedToFeature: true },
        },
        resume: { "75": { attempts: 1, lastDecision: "resumed from 3 commits" } },
        stageCheckpoints: {
          "75": {
            version: 1,
            completedStage: "deterministic-qa",
            candidateTreeId: "a".repeat(40),
            nextPendingStage: "post-qa-deterministic",
            round: 2,
          },
        },
        contractConvergence: {
          "75": {
            version: 1,
            extensionUsed: false,
            revision: 1,
            findings: {},
          },
        },
        qaConvergence: {
          "75": {
            version: 1,
            extensionUsed: true,
            revision: 3,
            findings: {},
          },
        },
        nonProgress: {
          "75": {
            version: 1,
            observations: [],
          },
        },
        migrations: { pool: ["0042"], claims: { "76": ["0042"] } },
      }),
      "utf-8",
    );
    return p;
  }

  it("removes the dispatched slice's whole record and returns it", () => {
    const repo = makeRepo();
    staleStateFile(repo);

    const previous = clearSliceStateForDispatch(repo, "demo", "75");

    expect(previous).toEqual({
      phase: "ERROR",
      branch: "afk/demo-01",
      error: "exceeded 100 tool calls",
    });
    const state = loadRunState(repo, "demo");
    expect(state.slices["75"]).toBeUndefined();
    expect(Object.keys(state.slices).sort()).toEqual(["76", "77"]);
  });

  it("clears every field a previous attempt can leave behind, not just error", () => {
    const repo = makeRepo();
    staleStateFile(repo);

    // MERGE-PENDING is the widest record: reason text plus the prefixes
    // that refused the merge, both of which describe the previous
    // attempt's tree and not the one about to be dispatched (ADR 0029).
    expect(clearSliceStateForDispatch(repo, "demo", "76")).toMatchObject({
      collidingPrefixes: ["0042"],
    });

    const raw = JSON.parse(readFileSync(join(repo, ".afk", "state", "demo.json"), "utf-8"));
    expect(raw.slices["76"]).toBeUndefined();
    // Nothing anywhere in the file still names the cleared attempt's
    // failure — the misleading text is gone, not merely unreferenced.
    expect(JSON.stringify(raw)).not.toContain("migration prefix collision");
  });

  it("leaves resume bookkeeping, checkpoints, convergence, scope, and migration claims alone", () => {
    const repo = makeRepo();
    staleStateFile(repo);

    clearSliceStateForDispatch(repo, "demo", "75");

    const state = loadRunState(repo, "demo");
    // The resume cap is the poison-tree guard and the dispatch this
    // clearing accompanies is about to increment it (#36).
    expect(getResumeAttempts(state, "75")).toBe(1);
    expect(state.resume?.["75"]?.lastDecision).toBe("resumed from 3 commits");
    expect(state.stageCheckpoints).toMatchObject({
      "75": { nextPendingStage: "post-qa-deterministic" },
    });
    expect(state.contractConvergence).toMatchObject({
      "75": { version: 1, revision: 1 },
    });
    expect(state.qaConvergence).toMatchObject({
      "75": { version: 1, extensionUsed: true, revision: 3 },
    });
    expect(state.nonProgress).toMatchObject({
      "75": { version: 1, observations: [] },
    });
    expect(state.scope).toEqual({ members: ["01", "02"] });
    expect(state.migrations).toEqual({ pool: ["0042"], claims: { "76": ["0042"] } });
  });

  it("leaves other slices' records untouched", () => {
    const repo = makeRepo();
    staleStateFile(repo);

    clearSliceStateForDispatch(repo, "demo", "75");

    const state = loadRunState(repo, "demo");
    expect(isSliceComplete(state, "77")).toBe(true);
    expect(state.slices["76"]!.phase).toBe("MERGE-PENDING");
  });

  it("returns null and writes nothing when the slice has no record", () => {
    const repo = makeRepo();
    const p = staleStateFile(repo);
    const before = readFileSync(p, "utf-8");

    expect(clearSliceStateForDispatch(repo, "demo", "999")).toBeNull();
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("returns null without creating a state file on a first run", () => {
    const repo = makeRepo();

    expect(clearSliceStateForDispatch(repo, "demo", "75")).toBeNull();

    // A first dispatch must not leave a state file behind just to prove
    // it had nothing to clear.
    expect(existsSync(join(repo, ".afk", "state", "demo.json"))).toBe(false);
  });
});

/**
 * Architect blocker 3, fifth adjudication gate round. `saveSliceState`
 * replaces a slice's record unconditionally, which is right for the pipeline
 * (it owns the slice it is writing) and wrong for `afk adopt` — which reads
 * the record, runs base gates for minutes, and only then writes.
 */
describe("saveSliceStateIfUnchanged", () => {
  const write = (
    repo: string,
    expected: Parameters<typeof saveSliceStateIfUnchanged>[4],
  ) =>
    saveSliceStateIfUnchanged(
      repo,
      "demo",
      "75",
      { phase: "PASS", mergedToFeature: true, branch: "manual/x" },
      expected,
    );

  it("writes when the record is still the one that was observed", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "75", { phase: "ERROR", error: "boom" });
    const observed = loadRunState(repo, "demo").slices["75"];

    expect(write(repo, observed)).toEqual({ ok: true });
    expect(loadRunState(repo, "demo").slices["75"]!.phase).toBe("PASS");
  });

  it("writes when nothing was observed and nothing is there", () => {
    const repo = makeRepo();
    expect(write(repo, undefined)).toEqual({ ok: true });
    expect(loadRunState(repo, "demo").slices["75"]!.phase).toBe("PASS");
  });

  /**
   * The exact race: adoption observed no record (or a failure), a concurrent
   * run parked the slice while the gates ran, and the blind write turned
   * `AWAITING-ADJUDICATION` into `PASS` and stranded a live estate.
   */
  it("refuses when a concurrent park replaced the observed record", () => {
    const repo = makeRepo();
    const observed = loadRunState(repo, "demo").slices["75"];
    expect(observed).toBeUndefined();
    saveSliceState(repo, "demo", "75", {
      phase: "AWAITING-ADJUDICATION",
      branch: "afk/demo-slice-01-x",
      error: "one contested finding awaits a human decision",
    });

    const result = write(repo, observed);
    expect(result.ok).toBe(false);
    expect(
      (result as { found: { phase: string } }).found.phase,
    ).toBe("AWAITING-ADJUDICATION");
    // The park survives byte-for-byte: nothing was overwritten.
    expect(loadRunState(repo, "demo").slices["75"]!.phase).toBe(
      "AWAITING-ADJUDICATION",
    );
  });

  it("refuses when the observed record was cleared for a re-dispatch", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "75", { phase: "ERROR", error: "boom" });
    const observed = loadRunState(repo, "demo").slices["75"];
    clearSliceStateForDispatch(repo, "demo", "75");

    const result = write(repo, observed);
    expect(result.ok).toBe(false);
    expect((result as { found: unknown }).found).toBeUndefined();
    expect(loadRunState(repo, "demo").slices["75"]).toBeUndefined();
  });

  it("refuses on a changed field even when the phase is unchanged", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "75", { phase: "ERROR", error: "boom" });
    const observed = loadRunState(repo, "demo").slices["75"];
    saveSliceState(repo, "demo", "75", { phase: "ERROR", error: "different" });

    expect(write(repo, observed).ok).toBe(false);
  });

  it("does not clobber a sibling slice's parallel update", () => {
    const repo = makeRepo();
    const observed = loadRunState(repo, "demo").slices["75"];
    saveSliceState(repo, "demo", "76", { phase: "ERROR", error: "sibling" });

    expect(write(repo, observed)).toEqual({ ok: true });
    const state = loadRunState(repo, "demo");
    expect(state.slices["75"]!.phase).toBe("PASS");
    expect(state.slices["76"]!.phase).toBe("ERROR");
  });
});

/**
 * Architect blocker 2: the run records where its own slice artifacts live so
 * the estate probe resolves instead of guessing. Optional, because state
 * files that predate the field must stay loadable — the probe then falls back
 * to a complete walk.
 */
describe("RunState.specsDir", () => {
  it("round-trips through save and load", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: 3,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      specsDir: "docs/internal/specs/demo",
      slices: {},
    });
    expect(loadRunState(repo, "demo").specsDir).toBe(
      "docs/internal/specs/demo",
    );
  });

  it("survives a per-slice write", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: 3,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      specsDir: ".kiro/specs/demo",
      slices: {},
    });
    saveSliceState(repo, "demo", "75", { phase: "ERROR", error: "boom" });
    expect(loadRunState(repo, "demo").specsDir).toBe(".kiro/specs/demo");
  });

  it.each([undefined, "", "   ", 7, null, {}])(
    "degrades %p to absent rather than to a guessed path",
    (value) => {
      expect(
        adaptLoadedState(
          { version: 1, featureBranch: "feat/demo", specsDir: value, slices: {} },
          "demo",
        ).specsDir,
      ).toBeUndefined();
    },
  );

  it("is carried through the v0 migration too", () => {
    expect(
      adaptLoadedState(
        { featureBranch: "feat/demo", specsDir: ".kiro/specs/demo", slices: {} },
        "demo",
      ).specsDir,
    ).toBe(".kiro/specs/demo");
  });
});

/**
 * Applied protected-change waivers (#193, D5). The record is an audit note: a
 * reader — the run summary, a resumed run, a human after the fact — has to be
 * able to see which human authorizations a gate actually spent, without
 * re-reading every gate-evidence artifact the run wrote.
 */
describe("RunState.appliedWaivers", () => {
  const WAIVER = {
    riskClass: "deleted-test",
    path: "src/gone.test.ts",
    author: "eric",
    reason: "the module it covered was deleted with it",
  };

  it("[behavior:B-13] upgrades every earlier version to the current one with the field absent", () => {
    // The literal the pin used to carry lives in #87's B-14 block below: the
    // shipped version is that slice's fact, and B-13's is only that every
    // earlier file arrives at it carrying no waivers.
    for (const version of [undefined, 1, 2, 3, 4]) {
      const adapted = adaptLoadedState(
        {
          ...(version === undefined ? {} : { version }),
          prdSlug: "demo",
          featureBranch: "feat/demo",
          specsDir: ".kiro/specs/demo",
          slices: { "100": version === undefined
            ? { status: "PASS", mergedToFeature: true }
            : { phase: "PASS", mergedToFeature: true } },
        },
        "demo",
      );
      expect(adapted.version).toBe(RUN_STATE_VERSION);
      // Absent, not an empty record: "nobody waived anything" and "this file
      // predates waivers" are the same fact to every reader.
      expect(adapted.appliedWaivers).toBeUndefined();
      expect("appliedWaivers" in adapted).toBe(false);
      expect(adapted.slices["100"]!.phase).toBe("PASS");
      expect(adapted.specsDir).toBe(".kiro/specs/demo");
    }
  });

  it("[behavior:B-13] carries a v4 record through load and re-stamps the version on write", () => {
    const repo = makeRepo();
    // A caller-built object still carrying the old literal: the writer stamps
    // its own schema, so the file never claims a version its bytes contradict.
    saveRunState(repo, {
      version: 3,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
      appliedWaivers: { "100": [WAIVER] },
    });
    const file = join(repo, ".afk", "state", "demo.json");
    expect(JSON.parse(readFileSync(file, "utf-8")).version).toBe(
      RUN_STATE_VERSION,
    );

    const loaded = loadRunState(repo, "demo");
    expect(loaded.version).toBe(RUN_STATE_VERSION);
    expect(loaded.appliedWaivers).toEqual({ "100": [WAIVER] });

    // And it survives an unrelated focused write, like `resume` does.
    saveSliceState(repo, "demo", "200", { phase: "ERROR", error: "boom" });
    expect(loadRunState(repo, "demo").appliedWaivers).toEqual({
      "100": [WAIVER],
    });
  });

  it("[behavior:B-13] appends per issue and ignores an already-recorded riskClass + path", () => {
    const repo = makeRepo();
    saveAppliedWaivers(repo, "demo", "100", [WAIVER]);
    // The same pair reported by a second gate is one authorization, so the
    // differing reason text does not create a second record.
    saveAppliedWaivers(repo, "demo", "100", [
      { ...WAIVER, reason: "reported again by the skipped-test gate" },
      { ...WAIVER, riskClass: "gate-policy" },
    ]);
    saveAppliedWaivers(repo, "demo", "200", [WAIVER]);
    // An empty list is not a write at all.
    saveAppliedWaivers(repo, "demo", "300", []);

    expect(loadRunState(repo, "demo").appliedWaivers).toEqual({
      "100": [WAIVER, { ...WAIVER, riskClass: "gate-policy" }],
      "200": [WAIVER],
    });
  });

  it("[behavior:B-13] degrades a malformed record to absent rather than wedging the load", () => {
    expect(
      adaptLoadedState(
        {
          version: 4,
          featureBranch: "feat/demo",
          slices: {},
          appliedWaivers: "not a record",
        },
        "demo",
      ).appliedWaivers,
    ).toBeUndefined();
    expect(
      adaptLoadedState(
        {
          version: 4,
          featureBranch: "feat/demo",
          slices: {},
          appliedWaivers: { "100": [{ riskClass: "deleted-test", path: " " }] },
        },
        "demo",
      ).appliedWaivers,
    ).toBeUndefined();
  });
});

/**
 * v6 is purely additive: a per-issue list of post-approval quality-stage runs
 * (#87 B-14). A list rather than one record per issue, because a
 * `BASELINE_IS_WRONG` escalation returns the slice to the generator and the
 * next approval appends a fresh entry — and tree ids are content-addressed, so
 * keying by tree would charge the escalating round to the re-approved
 * candidate's budget whenever the two trees are identical (B-13).
 */
describe("[behavior:#87:B-14] persisted quality stages", () => {
  const REPO_ISSUE = "87";

  it("[behavior:#87:B-14] keeps 6 assignable after the v7 bump moved the written schema past it", () => {
    // 5 -> 6 added `qualityStages`; 6 -> 7 added `recoveryLineage` (#277 B-10).
    // `RunState.version` still admits 3 through 6 so a caller or fixture holding
    // an older record keeps compiling, and nothing reads one of those back out
    // of a loaded state.
    const older: RunState["version"][] = [3, 4, 5, 6, 7];
    expect(older).toContain(RUN_STATE_VERSION);
    expect(RUN_STATE_VERSION).toBeGreaterThanOrEqual(6);
  });

  it("[behavior:#87:B-14] reads a version-5 file as \"no stage ran\" and writes nothing", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    const statePath = join(repo, ".afk", "state", "demo.json");
    const onDisk = `${JSON.stringify(
      {
        version: 5,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: { "87": { phase: "PASS", branch: "afk/demo-01" } },
      },
      null,
      2,
    )}\n`;
    writeFileSync(statePath, onDisk);

    const loaded = loadRunState(repo, "demo");

    expect(loaded.version).toBe(RUN_STATE_VERSION);
    expect(loaded.qualityStages).toBeUndefined();
    expect(cleanerRoundsSpent(undefined)).toBe(0);
    expect(cleanerRoundsRemaining({ spent: 0 })).toBe(MAX_CLEANER_ROUNDS);
    // A read is a read: adapting in memory must not rewrite the file, or a
    // `status` on a run someone else owns would silently upgrade its schema.
    expect(readFileSync(statePath, "utf8")).toBe(onDisk);
  });

  it("[behavior:#87:B-14] persists each round as it happens, with its trees, gates and outcome", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });

    recordQualityStageRound(repo, "demo", REPO_ISSUE, {
      round: 1,
      attempt: 2,
      inputTreeId: "a".repeat(40),
      outputTreeId: "b".repeat(40),
      gateIds: ["clean:format", "scope"],
      outcome: "REVERTED",
    });
    // A round that produced no gated checkpoint records no `outputTreeId` —
    // a dead dispatch, or a malformed escalation discarded before any gate ran.
    recordQualityStageRound(repo, "demo", REPO_ISSUE, {
      round: 2,
      attempt: 2,
      inputTreeId: "a".repeat(40),
      gateIds: [],
      outcome: "ESCALATION_MALFORMED",
    });
    recordQualityStageOutcome(repo, "demo", REPO_ISSUE, "EXHAUSTED");

    const stages = loadRunState(repo, "demo").qualityStages?.[REPO_ISSUE];
    expect(stages).toHaveLength(1);
    expect(stages![0]!.stage).toBe("cleaner");
    expect(stages![0]!.enabled).toBe(true);
    expect(stages![0]!.outcome).toBe("EXHAUSTED");
    expect(stages![0]!.rounds).toEqual([
      {
        round: 1,
        attempt: 2,
        inputTreeId: "a".repeat(40),
        outputTreeId: "b".repeat(40),
        gateIds: ["clean:format", "scope"],
        outcome: "REVERTED",
      },
      {
        round: 2,
        attempt: 2,
        inputTreeId: "a".repeat(40),
        gateIds: [],
        outcome: "ESCALATION_MALFORMED",
      },
    ]);
  });

  it("[behavior:#87:B-14] leaves a resumed run zero rounds after three recorded ones", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });

    for (const round of [1, 2, 3]) {
      recordQualityStageRound(repo, "demo", REPO_ISSUE, {
        round,
        attempt: 1,
        inputTreeId: "a".repeat(40),
        outputTreeId: "b".repeat(40),
        gateIds: ["clean:format"],
        outcome: "REVERTED",
      });
    }

    // The whole point of persisting per round: a resume reads the rounds the
    // killed run actually spent, so it cannot buy a fourth.
    const stages = loadRunState(repo, "demo").qualityStages?.[REPO_ISSUE];
    const spent = cleanerRoundsSpent(stages![0]);
    expect(spent).toBe(MAX_CLEANER_ROUNDS);
    expect(cleanerRoundsRemaining({ spent })).toBe(0);
  });

  it("[behavior:#87:B-14] appends a fresh entry after an escalation, so the re-approval starts at zero", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });
    const escalatedTree = "a".repeat(40);

    recordQualityStageRound(repo, "demo", REPO_ISSUE, {
      round: 1,
      attempt: 1,
      inputTreeId: escalatedTree,
      gateIds: [],
      outcome: "ESCALATED",
    });
    recordQualityStageOutcome(repo, "demo", REPO_ISSUE, "ESCALATED");
    // The generator answered without changing tracked content, so the
    // re-approved tree id is *identical*. A record keyed by tree would hand the
    // new stage a spent budget; an appended entry does not.
    recordQualityStageRound(
      repo,
      "demo",
      REPO_ISSUE,
      {
        round: 1,
        attempt: 2,
        inputTreeId: escalatedTree,
        outputTreeId: escalatedTree,
        gateIds: ["clean:format"],
        outcome: "PASS",
      },
      { startNewEntry: true },
    );
    recordQualityStageOutcome(repo, "demo", REPO_ISSUE, "PASS");

    const stages = loadRunState(repo, "demo").qualityStages?.[REPO_ISSUE];
    expect(stages).toHaveLength(2);
    expect(stages!.map((entry) => entry.outcome)).toEqual(["ESCALATED", "PASS"]);
    expect(cleanerRoundsSpent(stages![1])).toBe(1);
    expect(cleanerRoundsRemaining({ spent: cleanerRoundsSpent(stages![1]) })).toBe(
      MAX_CLEANER_ROUNDS - 1,
    );
  });

  it("[behavior:#87:B-14] records a DISABLED stage without pretending a round ran", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });

    // This is the recorder's own contract, not the stage's: P-01 requires
    // `runCleanerStage` to write *nothing* for a clean-less policy, so the
    // orchestrator never reaches this branch. It exists because the persisted
    // outcome union admits `DISABLED`, and a union member no writer can produce
    // is the kind of thing a later stage silently starts relying on.
    recordQualityStageOutcome(repo, "demo", REPO_ISSUE, "DISABLED");

    const stages = loadRunState(repo, "demo").qualityStages?.[REPO_ISSUE];
    expect(stages).toEqual([
      { stage: "cleaner", enabled: false, rounds: [], outcome: "DISABLED" },
    ]);
    expect(cleanerRoundsSpent(stages![0])).toBe(0);
  });
});

describe("cross-process run-state locking", () => {
  it("serializes real processes without losing either writer's mutation", async () => {
    const repo = makeRepo();
    const ready = join(repo, "holder-ready");
    const release = join(repo, "holder-release");
    const holder = spawnStateChild("hold", repo, ready, release);
    await waitForFile(ready);

    const writer = spawnStateChild("write", repo, ready, release);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(writer.exitCode).toBeNull();

    writeFileSync(release, "release");
    await Promise.all([waitForChild(holder), waitForChild(writer)]);

    expect(loadRunState(repo, "concurrent").slices).toEqual({
      "100": { phase: "ERROR", error: "first writer" },
      "200": { phase: "STUCK", error: "second writer" },
    });
  });

  it("reclaims a lock left by a killed owner process", async () => {
    const repo = makeRepo();
    const ready = join(repo, "dead-owner-ready");
    const release = join(repo, "unused-release");
    const owner = spawnStateChild("die", repo, ready, release);
    await waitForFile(ready);

    owner.kill("SIGKILL");
    await new Promise<void>((resolve) => owner.once("exit", () => resolve()));

    saveSliceState(repo, "concurrent", "200", {
      phase: "PASS",
      mergedToFeature: true,
    });

    expect(isSliceComplete(loadRunState(repo, "concurrent"), "200")).toBe(true);
    expect(
      existsSync(join(repo, ".afk", "state", "concurrent.json.lock")),
    ).toBe(false);
  });

  it("cleans a quarantined stale lock left by a killed reaper", () => {
    const repo = makeRepo();
    const stateDir = join(repo, ".afk", "state");
    const reaper = join(stateDir, "concurrent.json.lock-reaper");
    mkdirSync(reaper, { recursive: true });
    writeFileSync(join(reaper, "owner.json"), "abandoned stale lock");

    saveSliceState(repo, "concurrent", "200", {
      phase: "PASS",
      mergedToFeature: true,
    });

    expect(isSliceComplete(loadRunState(repo, "concurrent"), "200")).toBe(true);
    expect(existsSync(reaper)).toBe(false);
  });

  it("compares and commits a conditional slice write inside one lock", () => {
    const repo = makeRepo();
    saveSliceState(repo, "conditional", "129", {
      phase: "AWAITING-ADJUDICATION",
      branch: "afk/conditional-slice-01",
    });
    const before = readFileSync(
      join(repo, ".afk", "state", "conditional.json"),
      "utf-8",
    );

    const result = saveSliceStateIfUnchanged(
      repo,
      "conditional",
      "129",
      { phase: "PASS", mergedToFeature: true },
      undefined,
    );

    expect(result).toEqual({
      ok: false,
      found: {
        phase: "AWAITING-ADJUDICATION",
        branch: "afk/conditional-slice-01",
      },
    });
    expect(
      readFileSync(join(repo, ".afk", "state", "conditional.json"), "utf-8"),
    ).toBe(before);
  });
});

/**
 * v7 is purely additive: an append-only, per-issue list of preserved-work
 * recovery lineage events (#277 B-10). Append-only rather than a mutable summary
 * because "is an attempt open" and "what did the attempt claim about the tree"
 * are different questions, and a summary field can only answer the first.
 */
describe("[behavior:#277:B-10] persisted recovery lineage", () => {
  const ISSUE = "277";

  function lineageEvent(
    overrides: Partial<PersistedRecoveryLineageEvent> = {},
  ): PersistedRecoveryLineageEvent {
    return {
      attemptId: "attempt-1",
      state: "PENDING",
      target: { number: "1", ghIssue: ISSUE },
      reason: "stale lock",
      extensions: [],
      provider: "claude-code",
      sliceBranch: "afk-claude-code/demo-slice-01",
      sliceHead: "a".repeat(40),
      featureHead: "b".repeat(40),
      scopeFingerprint: "c".repeat(64),
      snapshotPath: ".kiro/specs/demo/slices/01-x/recovery-snapshots/attempt-1",
      contractFingerprint: "d".repeat(64),
      manifestFingerprint: "e".repeat(64),
      recordedAt: "2026-09-14T00:00:00.000Z",
      ...overrides,
    };
  }

  it("[behavior:#277:B-10] pins the written schema at 7 and names the addition in the version block", () => {
    expect(RUN_STATE_VERSION).toBe(7);
    const assignable: RunState["version"][] = [3, 4, 5, 6, 7];
    expect(assignable).toContain(RUN_STATE_VERSION);
    // ADR 0018 asks for the change to be documented in the same running comment
    // block, not just for the literal to move.
    const source = readFileSync(join(process.cwd(), "src", "run-state.ts"), "utf-8");
    const block = source.slice(
      source.indexOf("* The schema version every writer emits"),
      source.indexOf("export const RUN_STATE_VERSION"),
    );
    expect(block).toContain("v7");
    expect(block).toContain("recoveryLineage");
  });

  it("[behavior:#277:B-10] reads a version-6 file as \"no attempt was admitted\" and writes nothing", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    const statePath = join(repo, ".afk", "state", "demo.json");
    const onDisk = `${JSON.stringify(
      {
        version: 6,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        slices: { "277": { phase: "PASS", branch: "afk/demo-01" } },
      },
      null,
      2,
    )}\n`;
    writeFileSync(statePath, onDisk);

    const loaded = loadRunState(repo, "demo");

    expect(loaded.version).toBe(RUN_STATE_VERSION);
    expect(loaded.recoveryLineage).toBeUndefined();
    expect(recoveryLineageFor(loaded, ISSUE)).toEqual([]);
    expect(readFileSync(statePath, "utf8")).toBe(onDisk);
  });

  it.each([
    ["a non-object map", { recoveryLineage: [] }],
    ["a non-array target list", { recoveryLineage: { "277": {} } }],
    ["a blank attempt id", { recoveryLineage: { "277": [{ attemptId: "" }] } }],
    [
      "an unknown state",
      { recoveryLineage: { "277": [{ attemptId: "x", state: "OPEN" }] } },
    ],
    [
      "a missing target pair",
      { recoveryLineage: { "277": [{ attemptId: "x", state: "PENDING" }] } },
    ],
    [
      "a non-array extension set",
      {
        recoveryLineage: {
          "277": [
            {
              attemptId: "x",
              state: "PENDING",
              target: { number: "1", ghIssue: "277" },
              reason: "r",
              extensions: "none",
            },
          ],
        },
      },
    ],
  ])(
    "[behavior:#277:B-10] degrades %s to absent instead of throwing",
    (_label, fields) => {
      const adapted = adaptLoadedState(
        { version: 6, prdSlug: "demo", featureBranch: "feat/demo", slices: {}, ...fields },
        "demo",
      );

      expect(adapted.recoveryLineage).toBeUndefined();
      expect(recoveryLineageFor(adapted, ISSUE)).toEqual([]);
    },
  );

  it("[behavior:#277:B-10] round-trips a well-formed event through the focused reader", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });
    const event = lineageEvent();

    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ISSUE, event);
    });

    expect(recoveryLineageFor(loadRunState(repo, "demo"), ISSUE)).toEqual([event]);
  });

  it("[behavior:#277:B-11] appends without shortening or rewriting an earlier event", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });
    const first = lineageEvent();
    const second = lineageEvent({
      attemptId: "attempt-1",
      state: "COMPLETED",
      // #335 B-12 made the three completion members required on `COMPLETED`;
      // `COMPLETION_OBSERVATIONS` is declared with the #335 block below.
      ...COMPLETION_OBSERVATIONS,
    });

    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ISSUE, first);
    });
    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ISSUE, second);
    });

    const events = recoveryLineageFor(loadRunState(repo, "demo"), ISSUE);
    expect(events).toEqual([first, second]);
    // The earlier record is byte-for-byte what it was: a terminal event is a new
    // record citing the same attempt id, never an edit of the PENDING one.
    expect(events[0]).toEqual(first);
  });

  it("[behavior:#277:P-04] preserves every unrelated run-state field when it appends", () => {
    const repo = makeRepo();
    const before: RunState = {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      specsDir: ".kiro/specs/demo",
      scope: {
        mode: "explicit",
        slices: [
          { number: "01", ghIssue: "277" },
          { number: "02", ghIssue: "278" },
        ],
      },
      slices: {
        "277": { phase: "PASS", branch: "afk/demo-01", mergedToFeature: false },
        "278": { phase: "ERROR", error: "boom" },
      },
      resume: { "277": { attempts: 2 } },
      migrations: { pool: ["0070"], claims: { "277": ["0070"] } },
      approvedBaselines: {
        "277": { treeId: "t".repeat(40), commit: "c".repeat(40), artifactPath: "a.json" },
      },
      appliedWaivers: {
        "278": [{ riskClass: "migration", path: "m.sql", author: "eric", reason: "ok" }],
      },
      finalEvaluations: {
        "277": {
          decision: "evaluate",
          finalTreeId: "f".repeat(40),
          attempts: [
            { attempt: 1, candidateTreeId: "f".repeat(40), verdict: "PASS", outcome: "GRADED" },
          ],
          invalidatedCandidateTreeIds: [],
        },
      },
      qualityStages: {
        "277": [
          {
            stage: "cleaner",
            enabled: true,
            rounds: [
              {
                round: 1,
                attempt: 1,
                inputTreeId: "i".repeat(40),
                gateIds: ["clean:format"],
                outcome: "PASS",
              },
            ],
            outcome: "PASS",
          },
        ],
      },
    };
    saveRunState(repo, before);
    const event = lineageEvent();

    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ISSUE, event);
    });

    const after = loadRunState(repo, "demo");
    expect(after).toEqual({ ...before, recoveryLineage: { [ISSUE]: [event] } });
  });

  it("[behavior:#277:P-03] round-trips a lineage-free file unchanged apart from the version stamp", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    const statePath = join(repo, ".afk", "state", "demo.json");

    for (const version of [3, 4, 5, 6] as const) {
      const document = {
        version,
        prdSlug: "demo",
        featureBranch: "feat/demo",
        specsDir: ".kiro/specs/demo",
        scope: { mode: "explicit", slices: [{ number: "01", ghIssue: "277" }] },
        slices: { "277": { phase: "PASS", branch: "afk/demo-01", mergedToFeature: true } },
        resume: { "277": { attempts: 1 } },
        migrations: { pool: ["0070"], claims: {} },
      };
      writeFileSync(statePath, `${JSON.stringify(document, null, 2)}\n`);

      const loaded = loadRunState(repo, "demo");
      expect(loaded.recoveryLineage).toBeUndefined();
      // Field-by-field equality apart from the stamp writeRunState applies.
      expect({ ...loaded, version }).toEqual({
        ...document,
        slices: document.slices,
      });

      // And a real write back through the transaction changes only the stamp.
      updateRunState(repo, "demo", () => {});
      const rewritten = JSON.parse(readFileSync(statePath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(rewritten).toEqual({ ...document, version: RUN_STATE_VERSION });
      expect(rewritten.recoveryLineage).toBeUndefined();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rollback-failure observations on a lineage event (#333)
 * ---------------------------------------------------------------------------
 *
 * #333 adds three optional members — `rollbackError`,
 * `observedContractFingerprint`, `observedManifestFingerprint` — that a
 * `ROLLBACK_FAILED` event must carry and no other state may. That changes the
 * validator's accepted input language, so both halves of the regression surface
 * are bound here per ADR 0060: the newly accepted document round-trips, and each
 * newly rejected one degrades the target's whole list to absent. Every rejection
 * case also loads the *corrected* document, so none of them can pass because of
 * an unrelated malformation.
 */
const ROLLBACK_ISSUE = "333";

const ROLLBACK_OBSERVATIONS = {
  rollbackError: "the snapshot contract.md could not be read (ENOENT)",
  observedContractFingerprint: "1".repeat(64),
  observedManifestFingerprint: RECOVERY_FINGERPRINT_ABSENT,
} as const;

/** The three members only a `ROLLBACK_FAILED` event may carry. */
const ROLLBACK_FIELDS = [
  "rollbackError",
  "observedContractFingerprint",
  "observedManifestFingerprint",
] as const;

/**
 * The three members only a `COMPLETED` event may carry (#335 B-12), and a
 * well-formed value for each.
 *
 * Declared up here beside {@link ROLLBACK_OBSERVATIONS} because the #333 cases
 * below build `COMPLETED` events as their *clean* control document, and a clean
 * `COMPLETED` event now has to satisfy the newer rule too or the case stops
 * being about the field it names.
 */
const COMPLETION_OBSERVATIONS = {
  replacementContractFingerprint: "7".repeat(64),
  replacementManifestFingerprint: "8".repeat(64),
  lockProvenance: "renegotiated under run-state lock, run 42",
} as const;

/** The keys of {@link COMPLETION_OBSERVATIONS}, for per-field rejection cases. */
const COMPLETION_FIELDS = [
  "replacementContractFingerprint",
  "replacementManifestFingerprint",
  "lockProvenance",
] as const;

function rollbackLineageEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    attemptId: "attempt-333",
    state: "PENDING",
    target: { number: "4", ghIssue: ROLLBACK_ISSUE },
    reason: "the accepted pair went stale",
    extensions: [],
    provider: "claude-code",
    sliceBranch: "afk-claude-code/demo-slice-04",
    sliceHead: "a".repeat(40),
    featureHead: "b".repeat(40),
    scopeFingerprint: "c".repeat(64),
    snapshotPath: ".kiro/specs/demo/slices/04-x/recovery-snapshots/attempt-333",
    contractFingerprint: "d".repeat(64),
    manifestFingerprint: "e".repeat(64),
    recordedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

/** Load a lineage list the way `loadRunState` would, without touching disk. */
function adaptLineage(events: Record<string, unknown>[]): RunState {
  return adaptLoadedState(
    {
      version: 7,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
      recoveryLineage: { [ROLLBACK_ISSUE]: events },
    },
    "demo",
  );
}

describe("[behavior:#333:B-06] rollback-failure observations on a lineage event", () => {
  it("[behavior:#333:B-06] round-trips a well-formed ROLLBACK_FAILED event through save/load", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });
    const pending = rollbackLineageEvent() as unknown as PersistedRecoveryLineageEvent;
    const failed = rollbackLineageEvent({
      state: "ROLLBACK_FAILED",
      ...ROLLBACK_OBSERVATIONS,
    }) as unknown as PersistedRecoveryLineageEvent;

    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ROLLBACK_ISSUE, pending);
      appendRecoveryLineageEvent(state, ROLLBACK_ISSUE, failed);
    });

    // Purely additive: the field the events ride on is still v7's.
    expect(RUN_STATE_VERSION).toBe(7);
    const loaded = recoveryLineageFor(loadRunState(repo, "demo"), ROLLBACK_ISSUE);
    expect(loaded).toEqual([pending, failed]);
    // The `PENDING` half carries none of the three, and the loader invents none.
    for (const field of ROLLBACK_FIELDS) {
      expect(field in loaded[0]!).toBe(false);
      expect(loaded[1]![field]).toBe(ROLLBACK_OBSERVATIONS[field]);
    }
  });

  it.each(
    ROLLBACK_FIELDS.flatMap((field) => [
      [`${field} missing`, field, undefined] as const,
      [`${field} present but blank`, field, "   "] as const,
    ]),
  )(
    "[behavior:#333:B-06] rejects a ROLLBACK_FAILED event with %s",
    (_label, field, value) => {
      const complete = rollbackLineageEvent({
        state: "ROLLBACK_FAILED",
        ...ROLLBACK_OBSERVATIONS,
      });
      const broken = { ...complete };
      if (value === undefined) delete broken[field];
      else broken[field] = value;

      expect(adaptLineage([broken]).recoveryLineage).toBeUndefined();
      expect(
        recoveryLineageFor(adaptLineage([broken]), ROLLBACK_ISSUE),
      ).toEqual([]);
      // The same document, corrected, loads: the rejection is about this field.
      expect(
        recoveryLineageFor(adaptLineage([complete]), ROLLBACK_ISSUE),
      ).toEqual([complete]);
    },
  );

  it.each([
    ["PENDING", "rollbackError"],
    ["ROLLED_BACK", "observedContractFingerprint"],
    ["COMPLETED", "observedManifestFingerprint"],
  ] as const)(
    "[behavior:#333:B-06] rejects a %s event carrying %s",
    (state, field) => {
      const clean = rollbackLineageEvent({
        state,
        // #335 B-12 made the three completion members required on `COMPLETED`,
        // so the control document for that state has to carry them.
        ...(state === "COMPLETED" ? COMPLETION_OBSERVATIONS : {}),
      });
      const carrying = { ...clean, [field]: ROLLBACK_OBSERVATIONS[field] };

      expect(adaptLineage([carrying]).recoveryLineage).toBeUndefined();
      // Removing the offending field is the whole difference.
      expect(recoveryLineageFor(adaptLineage([clean]), ROLLBACK_ISSUE)).toEqual([
        clean,
      ]);
    },
  );

  it("[behavior:#333:B-06] drops the whole list when one event of several is malformed", () => {
    const pending = rollbackLineageEvent();
    const failed = rollbackLineageEvent({
      state: "ROLLBACK_FAILED",
      ...ROLLBACK_OBSERVATIONS,
      rollbackError: "",
    });

    expect(adaptLineage([pending, failed]).recoveryLineage).toBeUndefined();
    // Not "keep the good ones": a surviving PENDING would read as an open attempt.
    expect(
      recoveryLineageFor(adaptLineage([pending, failed]), ROLLBACK_ISSUE),
    ).toEqual([]);
  });
});

describe("[behavior:#333:P-04] the #277 lineage shape still loads unchanged", () => {
  it("[behavior:#333:P-04] loads a PENDING-only #277 lineage field for field with the three new members absent", () => {
    const pending = rollbackLineageEvent();

    const loaded = recoveryLineageFor(adaptLineage([pending]), ROLLBACK_ISSUE);

    expect(loaded).toEqual([pending]);
    for (const [key, value] of Object.entries(pending)) {
      expect(loaded[0]![key as keyof PersistedRecoveryLineageEvent]).toEqual(value);
    }
    expect(Object.keys(loaded[0]!).sort()).toEqual(Object.keys(pending).sort());
  });

  it("[behavior:#333:P-04] still degrades the whole list to absent on a pre-existing malformation", () => {
    const missingProvider = rollbackLineageEvent();
    delete missingProvider.provider;

    expect(adaptLineage([missingProvider]).recoveryLineage).toBeUndefined();
    expect(
      adaptLineage([rollbackLineageEvent({ extensions: "none" })])
        .recoveryLineage,
    ).toBeUndefined();
  });

  it("[behavior:#333:P-04] rejects the newly-forbidden direction too, so the rule cannot ship half-enforced", () => {
    const pendingCarrying = rollbackLineageEvent({
      rollbackError: ROLLBACK_OBSERVATIONS.rollbackError,
    });
    const rolledBackCarrying = rollbackLineageEvent({
      state: "ROLLED_BACK",
      observedContractFingerprint:
        ROLLBACK_OBSERVATIONS.observedContractFingerprint,
    });

    expect(adaptLineage([pendingCarrying]).recoveryLineage).toBeUndefined();
    expect(adaptLineage([rolledBackCarrying]).recoveryLineage).toBeUndefined();
    // And both load once the offending field is removed.
    for (const clean of [
      rollbackLineageEvent(),
      rollbackLineageEvent({ state: "ROLLED_BACK" }),
    ]) {
      expect(recoveryLineageFor(adaptLineage([clean]), ROLLBACK_ISSUE)).toEqual([
        clean,
      ]);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Replacement fingerprints and lock provenance on a COMPLETED event (#335 B-12)
 * ---------------------------------------------------------------------------
 *
 * #335 adds three more optional members — `replacementContractFingerprint`,
 * `replacementManifestFingerprint`, `lockProvenance` — on exactly the
 * {@link ROLLBACK_FAILURE_FIELDS} precedent: required non-blank on `COMPLETED`,
 * required absent on every other state. That is another change to the validator's
 * accepted input language, so ADR 0060 asks for both halves again: the newly
 * accepted document round-trips through save/load field for field, and each
 * newly rejected one degrades the target's whole list to absent. Purely additive,
 * so {@link RUN_STATE_VERSION} stays 7 and no migration ships with it.
 */
describe("[behavior:#335:B-12] replacement fingerprints and lock provenance on a COMPLETED event", () => {
  it("[behavior:#335:B-12] round-trips a well-formed COMPLETED event through save/load", () => {
    const repo = makeRepo();
    saveRunState(repo, {
      version: RUN_STATE_VERSION,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {},
    });
    const pending = rollbackLineageEvent() as unknown as PersistedRecoveryLineageEvent;
    const completed = rollbackLineageEvent({
      state: "COMPLETED",
      ...COMPLETION_OBSERVATIONS,
    }) as unknown as PersistedRecoveryLineageEvent;

    updateRunState(repo, "demo", (state) => {
      appendRecoveryLineageEvent(state, ROLLBACK_ISSUE, pending);
      appendRecoveryLineageEvent(state, ROLLBACK_ISSUE, completed);
    });

    // Additive on the v7 field the lineage already rides on: no version bump.
    expect(RUN_STATE_VERSION).toBe(7);
    const loaded = recoveryLineageFor(loadRunState(repo, "demo"), ROLLBACK_ISSUE);
    expect(loaded).toEqual([pending, completed]);
    for (const field of COMPLETION_FIELDS) {
      // The `PENDING` half carries none of the three and the loader invents none.
      expect(field in loaded[0]!).toBe(false);
      expect(loaded[1]![field]).toBe(COMPLETION_OBSERVATIONS[field]);
    }
    // Every other member is copied forward untouched, key for key.
    expect(Object.keys(loaded[1]!).sort()).toEqual(Object.keys(completed).sort());
  });

  it.each(
    COMPLETION_FIELDS.flatMap((field) => [
      [`${field} missing`, field, undefined] as const,
      [`${field} present but blank`, field, "   "] as const,
    ]),
  )(
    "[behavior:#335:B-12] rejects a COMPLETED event with %s",
    (_label, field, value) => {
      const complete = rollbackLineageEvent({
        state: "COMPLETED",
        ...COMPLETION_OBSERVATIONS,
      });
      const broken = { ...complete };
      if (value === undefined) delete broken[field];
      else broken[field] = value;

      expect(adaptLineage([broken]).recoveryLineage).toBeUndefined();
      expect(
        recoveryLineageFor(adaptLineage([broken]), ROLLBACK_ISSUE),
      ).toEqual([]);
      // The same document, corrected, loads: the rejection is about this field.
      expect(
        recoveryLineageFor(adaptLineage([complete]), ROLLBACK_ISSUE),
      ).toEqual([complete]);
    },
  );

  it.each(
    (["PENDING", "ROLLED_BACK"] as const).flatMap((state) =>
      COMPLETION_FIELDS.map((field) => [state, field] as const),
    ),
  )(
    "[behavior:#335:B-12] rejects a %s event carrying %s",
    (state, field) => {
      const clean = rollbackLineageEvent({ state });
      const carrying = { ...clean, [field]: COMPLETION_OBSERVATIONS[field] };

      expect(adaptLineage([carrying]).recoveryLineage).toBeUndefined();
      // Removing the offending field is the whole difference.
      expect(recoveryLineageFor(adaptLineage([clean]), ROLLBACK_ISSUE)).toEqual([
        clean,
      ]);
    },
  );

  it("[behavior:#335:B-12] rejects a ROLLBACK_FAILED event carrying a completion member", () => {
    const clean = rollbackLineageEvent({
      state: "ROLLBACK_FAILED",
      ...ROLLBACK_OBSERVATIONS,
    });
    const carrying = {
      ...clean,
      lockProvenance: COMPLETION_OBSERVATIONS.lockProvenance,
    };

    expect(adaptLineage([carrying]).recoveryLineage).toBeUndefined();
    expect(recoveryLineageFor(adaptLineage([clean]), ROLLBACK_ISSUE)).toEqual([
      clean,
    ]);
  });

  it("[behavior:#335:B-12] rejects a COMPLETED event carrying a rollback-failure member", () => {
    const clean = rollbackLineageEvent({
      state: "COMPLETED",
      ...COMPLETION_OBSERVATIONS,
    });
    const carrying = {
      ...clean,
      rollbackError: ROLLBACK_OBSERVATIONS.rollbackError,
    };

    // The two per-state rules are independent gates, not one shared branch.
    expect(adaptLineage([carrying]).recoveryLineage).toBeUndefined();
    expect(recoveryLineageFor(adaptLineage([clean]), ROLLBACK_ISSUE)).toEqual([
      clean,
    ]);
  });

  it("[behavior:#335:B-12] drops the whole list when the trailing COMPLETED event is malformed", () => {
    const pending = rollbackLineageEvent();
    const completed = rollbackLineageEvent({
      state: "COMPLETED",
      ...COMPLETION_OBSERVATIONS,
      replacementManifestFingerprint: "",
    });

    expect(adaptLineage([pending, completed]).recoveryLineage).toBeUndefined();
    // Not "keep the good ones": a surviving PENDING would read as an open attempt.
    expect(
      recoveryLineageFor(adaptLineage([pending, completed]), ROLLBACK_ISSUE),
    ).toEqual([]);
  });

  it("[behavior:#335:B-12] ships no schema step: v7 stays v7 and no migration is added", () => {
    expect(RUN_STATE_VERSION).toBe(7);
    // A v7 document written before #335 has none of the three and still loads.
    const legacy = rollbackLineageEvent();
    expect(
      recoveryLineageFor(adaptLineage([legacy]), ROLLBACK_ISSUE),
    ).toEqual([legacy]);
    // migrationCount 0: additive fields on an existing v7 field need no
    // migration, and this repo has no migrations directory to add one to.
    expect(existsSync(join("supabase", "migrations"))).toBe(false);
  });
});
