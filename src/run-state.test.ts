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
  saveFiledFindings,
  saveReviewPhase,
  sanitizeReviewPhase,
  isSliceComplete,
  adaptLoadedState,
  getResumeAttempts,
  recordRetryDecision,
  chargeResumeAttempt,
  clearSliceStateForDispatch,
  saveSliceStateIfUnchanged,
  approvedBaselineFor,
  recordApprovedBaseline,
  RUN_STATE_VERSION,
  type PersistedGuardianReviewRound,
} from "./run-state.js";

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
    expect(adapted.version).toBe(4);
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
    expect(adapted.version).toBe(4);
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
    expect(loaded.version).toBe(4);
    expect(loaded.slices["100"]!.phase).toBe("PASS");
    expect(isSliceComplete(loaded, "100")).toBe(true);
    expect(isSliceComplete(loaded, "200")).toBe(false);

    saveSliceState(repo, slug, "300", {
      phase: "ERROR",
      branch: "afk/demo-3",
      error: "boom",
    });

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(4);
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


/** ADR 0015: cheap re-entry cache for the post-merge review phase. */
describe("review-phase persistence", () => {
  const finding = {
    stableId: "A-01",
    currentId: "A-01",
    title: "Durable evidence is missing",
    class: "INTEGRITY",
    clearCondition: "Persist the evidence.",
    disposition: "OPEN" as const,
    reachableTrigger: "A retry consumes an incomplete durable record.",
    introducedByReviewedDiff: true,
  };
  const invokedRound = (
    round: number,
    architectOutcome:
      | "SHIP"
      | "ACCEPT-WITH-NOTES"
      | "FIX-BEFORE-SHIP"
      | "UNPARSEABLE"
      | "NEVER_RAN"
      | "DIED_MID_RUN" = "SHIP",
    pmOutcome:
      | "SHIP"
      | "ACCEPT-WITH-NOTES"
      | "FIX-BEFORE-SHIP"
      | "UNPARSEABLE"
      | "NEVER_RAN"
      | "DIED_MID_RUN" = "SHIP",
  ): PersistedGuardianReviewRound => ({
    round,
    reviewedHeadSha: `reviewed-${round}`,
    headSha: `head-${round}`,
    architect: {
      source: "INVOKED",
      outcome: architectOutcome,
      findings:
        architectOutcome === "ACCEPT-WITH-NOTES" ||
        architectOutcome === "FIX-BEFORE-SHIP"
          ? [{ ...finding }]
          : [],
      findingsOriginRound: round,
    },
    pm: {
      source: "INVOKED",
      outcome: pmOutcome,
      findings:
        pmOutcome === "ACCEPT-WITH-NOTES" ||
        pmOutcome === "FIX-BEFORE-SHIP"
          ? [
              {
                ...finding,
                stableId: "P-01",
                currentId: "P-01",
                reachableTrigger: null,
                introducedByReviewedDiff: null,
              },
            ]
          : [],
      findingsOriginRound: round,
    },
  });

  it("B-02 round-trips the canonical review round shape", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "70", {
      phase: "PASS",
      branch: "afk/demo-slice-01",
      mergedToFeature: true,
    });
    saveReviewPhase(repo, "demo", {
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
      rounds: [invokedRound(1, "FIX-BEFORE-SHIP", "DIED_MID_RUN")],
    });

    const loaded = loadRunState(repo, "demo");
    // Slice state written earlier is preserved (atomic re-read pattern).
    expect(isSliceComplete(loaded, "70")).toBe(true);
    expect(loaded.reviewPhase).toEqual({
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
      rounds: [invokedRound(1, "FIX-BEFORE-SHIP", "DIED_MID_RUN")],
    });

    // Clearing removes the key entirely.
    saveReviewPhase(repo, "demo", undefined);
    expect(loadRunState(repo, "demo").reviewPhase).toBeUndefined();
  });

  it("B-01 appends one completed round without replacing unfavorable history", () => {
    const repo = makeRepo();
    saveReviewPhase(repo, "demo", {
      architect: { headSha: "head-1", verdict: "SHIP" },
      rounds: [invokedRound(1)],
    });
    saveReviewPhase(repo, "demo", {
      pm: { headSha: "head-2", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(2, "FIX-BEFORE-SHIP", "NEVER_RAN")],
    });

    expect(loadRunState(repo, "demo").reviewPhase).toEqual({
      pm: { headSha: "head-2", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [
        invokedRound(1),
        invokedRound(2, "FIX-BEFORE-SHIP", "NEVER_RAN"),
      ],
    });
  });

  it("P-04 saveSliceState preserves the cache, ledger, and sibling optional fields", () => {
    const repo = makeRepo();
    saveReviewPhase(repo, "demo", {
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(1)],
    });
    const statePath = join(repo, ".afk", "state", "demo.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.qaConvergence = { retained: true };
    writeFileSync(statePath, JSON.stringify(state), "utf-8");
    saveSliceState(repo, "demo", "71", {
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(loadRunState(repo, "demo").reviewPhase).toEqual({
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
      rounds: [invokedRound(1)],
    });
    expect(loadRunState(repo, "demo").qaConvergence).toEqual({
      retained: true,
    });
  });

  it("appends filed findings, ignores a re-filed identity, and survives the next round write", () => {
    const repo = makeRepo();
    const blocker = {
      guardian: "architect" as const,
      stableId: "A-01",
      fingerprint: "fp-a1",
      kind: "BLOCKER" as const,
      round: 3,
      issue: "https://github.com/acme/repo/issues/1",
    };
    saveReviewPhase(repo, "demo", { rounds: [invokedRound(1)] });
    saveFiledFindings(repo, "demo", [blocker]);
    // Same identity, different issue: the record already exists, so the second
    // write is a no-op rather than a duplicate.
    saveFiledFindings(repo, "demo", [
      { ...blocker, round: 4, issue: "https://github.com/acme/repo/issues/9" },
      {
        guardian: "pm",
        stableId: "P-01",
        fingerprint: "fp-p1",
        kind: "NOTE",
        round: 4,
        issue: "https://github.com/acme/repo/issues/2",
      },
    ]);
    saveFiledFindings(repo, "demo", []);

    expect(loadRunState(repo, "demo").reviewPhase?.filedFindings).toEqual([
      blocker,
      expect.objectContaining({ stableId: "P-01" }),
    ]);

    // The next round's cache write replaces the cache fields wholesale; the
    // filed-issue memory must not go with them, or every note would be filed
    // again next round.
    saveReviewPhase(repo, "demo", {
      pm: { headSha: "head-2", verdict: "SHIP" },
      rounds: [invokedRound(2, "FIX-BEFORE-SHIP", "SHIP")],
    });

    const reloaded = loadRunState(repo, "demo").reviewPhase;
    expect(reloaded?.filedFindings).toHaveLength(2);
    expect(reloaded?.rounds).toHaveLength(2);
  });
});

describe("sanitizeReviewPhase", () => {
  it("keeps well-formed favorable entries", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        architect: { headSha: "def", verdict: "SHIP" },
        pm: { headSha: "def", verdict: "ACCEPT-WITH-NOTES" },
      }),
    ).toEqual({
      sanity: { treeSha: "abc", ok: true },
      architect: { headSha: "def", verdict: "SHIP" },
      pm: { headSha: "def", verdict: "ACCEPT-WITH-NOTES" },
    });
  });

  it("drops failed sanity results, unfavorable verdicts, and malformed entries", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: false },
        architect: { headSha: "def", verdict: "FIX-BEFORE-SHIP" },
        pm: { headSha: 42, verdict: "SHIP" },
      }),
    ).toBeUndefined();
    expect(sanitizeReviewPhase("garbage")).toBeUndefined();
    expect(sanitizeReviewPhase(null)).toBeUndefined();
    expect(sanitizeReviewPhase({})).toBeUndefined();
  });

  it("keeps valid entries while dropping invalid siblings", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        pm: { headSha: "", verdict: "SHIP" },
      }),
    ).toEqual({ sanity: { treeSha: "abc", ok: true } });
  });

  /**
   * The filed-issue record is validated entry by entry, not all-or-nothing like
   * the ledger: every record dropped is one finding the next round may file a
   * second issue for, so keeping the valid majority minimizes duplicates
   * (ADR 0057 decision 4, last sentence).
   */
  it("keeps each well-formed filed finding and drops only the malformed rows", () => {
    expect(
      sanitizeReviewPhase({
        filedFindings: [
          {
            guardian: "architect",
            stableId: " A-01 ",
            fingerprint: "fp-a1",
            kind: "BLOCKER",
            round: 3,
            issue: " https://github.com/acme/repo/issues/1 ",
          },
          // Every one of these is dropped, and none of them takes the row
          // above with it.
          { guardian: "designer", stableId: "X", fingerprint: "f", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "  ", fingerprint: "f", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "", kind: "NOTE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "MAYBE", round: 1, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 0, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 1.5, issue: "u" },
          { guardian: "pm", stableId: "P-01", fingerprint: "f", kind: "NOTE", round: 1, issue: "" },
          "not an object",
          null,
          {
            guardian: "pm",
            stableId: "P-02",
            fingerprint: "fp-p2",
            kind: "NOTE",
            round: 2,
            issue: "https://github.com/acme/repo/issues/2",
          },
          // A duplicate identity collapses to the first record.
          {
            guardian: "pm",
            stableId: "P-02",
            fingerprint: "fp-p2",
            kind: "NOTE",
            round: 3,
            issue: "https://github.com/acme/repo/issues/3",
          },
        ],
      }),
    ).toEqual({
      filedFindings: [
        {
          guardian: "architect",
          stableId: "A-01",
          fingerprint: "fp-a1",
          kind: "BLOCKER",
          round: 3,
          issue: "https://github.com/acme/repo/issues/1",
        },
        {
          guardian: "pm",
          stableId: "P-02",
          fingerprint: "fp-p2",
          kind: "NOTE",
          round: 2,
          issue: "https://github.com/acme/repo/issues/2",
        },
      ],
    });
  });

  it("reads an unusable filed-finding record as nothing filed rather than refusing the phase", () => {
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "abc", ok: true },
        filedFindings: "not an array",
      }),
    ).toEqual({ sanity: { treeSha: "abc", ok: true } });
    expect(sanitizeReviewPhase({ filedFindings: [] })).toBeUndefined();
  });

  it("B-04 drops an impossible architect blocking ledger but keeps favorable cache data", () => {
    expect(
      sanitizeReviewPhase({
        architect: { headSha: "cached-head", verdict: "SHIP" },
        rounds: [
          {
            round: 1,
            reviewedHeadSha: "reviewed-head",
            headSha: "review-commit",
            architect: {
              source: "INVOKED",
              outcome: "FIX-BEFORE-SHIP",
              findings: [
                {
                  stableId: "A-01",
                  currentId: "A-01",
                  title: "Pre-existing behavior",
                  class: "INTEGRITY",
                  clearCondition: "Change main's existing behavior.",
                  disposition: "OPEN",
                  reachableTrigger: "A normal run reaches the behavior.",
                  introducedByReviewedDiff: false,
                },
              ],
              findingsOriginRound: 1,
            },
            pm: {
              source: "INVOKED",
              outcome: "SHIP",
              findings: [],
              findingsOriginRound: 1,
            },
          },
        ],
      }),
    ).toEqual({
      architect: { headSha: "cached-head", verdict: "SHIP" },
    });
  });

  it("P-02 loads legacy PM v1 findings with null authority evidence", () => {
    const sanitized = sanitizeReviewPhase({
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "reviewed-head",
          headSha: "review-commit",
          architect: {
            source: "INVOKED",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED",
            outcome: "ACCEPT-WITH-NOTES",
            findings: [
              {
                stableId: "P-01",
                currentId: "P-01",
                title: "Product note",
                class: "PRODUCT",
                clearCondition: "Clarify the product behavior.",
                disposition: "OPEN",
              },
            ],
            findingsOriginRound: 1,
          },
        },
      ],
    });
    expect(sanitized?.rounds?.[0]?.pm.findings).toEqual([
      {
        stableId: "P-01",
        currentId: "P-01",
        title: "Product note",
        class: "PRODUCT",
        clearCondition: "Clarify the product behavior.",
        disposition: "OPEN",
        reachableTrigger: null,
        introducedByReviewedDiff: null,
      },
    ]);
  });

  it("is applied when loading a v1 state file", () => {
    const state = adaptLoadedState(
      {
        version: 1,
        featureBranch: "feat/demo",
        slices: {},
        reviewPhase: {
          architect: { headSha: "abc", verdict: "SHIP" },
          pm: { headSha: "abc", verdict: "FIX-BEFORE-SHIP" },
        },
      },
      "demo",
    );
    expect(state.reviewPhase).toEqual({
      architect: { headSha: "abc", verdict: "SHIP" },
    });
  });

  it("B-05 validates cache and ledger independently and drops an invalid ledger whole", () => {
    const validFinding = {
      stableId: "A-01",
      currentId: "A-01",
      title: "Finding",
      class: "INTEGRITY",
      clearCondition: "Clear it",
      disposition: "OPEN",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const round1 = {
      round: 1,
      reviewedHeadSha: "base",
      headSha: "review-commit",
      architect: {
        source: "INVOKED",
        outcome: "ACCEPT-WITH-NOTES",
        findings: [validFinding],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
    };
    const valid = sanitizeReviewPhase({
      architect: { headSha: "cache", verdict: "SHIP" },
      rounds: [
        round1,
        {
          round: 2,
          reviewedHeadSha: "review-commit",
          headSha: "review-commit",
          architect: {
            source: "CACHE",
            outcome: "ACCEPT-WITH-NOTES",
            findings: [validFinding],
            findingsOriginRound: 1,
          },
          pm: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: 1,
          },
        },
        {
          round: 3,
          reviewedHeadSha: "unbacked-cache-head",
          headSha: "unbacked-cache-head",
          architect: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: null,
          },
          pm: {
            source: "CACHE",
            outcome: "SHIP",
            findings: [],
            findingsOriginRound: null,
          },
        },
      ],
    });
    expect(valid?.rounds).toHaveLength(3);
    expect(valid?.rounds?.[2]?.architect).toMatchObject({
      findings: [],
      findingsOriginRound: null,
    });

    const malformed = structuredClone(valid!);
    malformed.rounds![1]!.architect.findings[0]!.title = "not an exact copy";
    expect(
      sanitizeReviewPhase({
        sanity: { treeSha: "tree", ok: true },
        architect: { headSha: "cache", verdict: "SHIP" },
        rounds: malformed.rounds,
      }),
    ).toEqual({
      sanity: { treeSha: "tree", ok: true },
      architect: { headSha: "cache", verdict: "SHIP" },
    });

    const invalidOrigin = structuredClone(valid!);
    invalidOrigin.rounds![1]!.architect.findingsOriginRound = 2;
    expect(
      sanitizeReviewPhase({
        architect: { headSha: "cache", verdict: "SHIP" },
        rounds: invalidOrigin.rounds,
      }),
    ).toEqual({
      architect: { headSha: "cache", verdict: "SHIP" },
    });
  });

  it("B-05 QA-01 drops a ledger whose stable IDs repeat within a guardian record", () => {
    const roundsWith = (findings: unknown[]) => [
      {
        round: 1,
        reviewedHeadSha: "base",
        headSha: "review-commit",
        architect: {
          source: "INVOKED",
          outcome: "ACCEPT-WITH-NOTES",
          findings,
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ];
    const currentAliasClaimant = {
      stableId: "A-01",
      currentId: "A-05",
      title: "Current-alias claimant",
      class: "PRODUCT",
      clearCondition: "Clear the current alias.",
      disposition: "REPEATED",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const stableAliasClaimant = {
      currentId: "A-01",
      title: "Stable-alias claimant",
      class: "INTEGRITY",
      clearCondition: "Clear the stable alias.",
      disposition: "OPEN",
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };

    // Identity resolution is one-to-one within a round (ADR 0057 decision 1,
    // amendment 2026-09-06): two findings sharing one stable identity are
    // unrepresentable, so the ledger degrades to a full round-1 review.
    expect(
      sanitizeReviewPhase({
        rounds: roundsWith([
          currentAliasClaimant,
          { ...stableAliasClaimant, stableId: "A-01" },
        ]),
      }),
    ).toBeUndefined();

    // The decided shape — the losing claimant carries a new stable identity
    // and keeps its guardian-provided ID as currentId — stays durable.
    const distinct = roundsWith([
      currentAliasClaimant,
      { ...stableAliasClaimant, stableId: "A-09" },
    ]);
    expect(sanitizeReviewPhase({ rounds: distinct })?.rounds).toEqual(distinct);
  });

  it("B-06 keeps the cache favorable-only while the ledger accepts all six terminal outcomes", () => {
    const outcomes = [
      "SHIP",
      "ACCEPT-WITH-NOTES",
      "FIX-BEFORE-SHIP",
      "UNPARSEABLE",
      "NEVER_RAN",
      "DIED_MID_RUN",
    ] as const;
    const rounds = outcomes.map((outcome, index) => ({
      round: index + 1,
      reviewedHeadSha: `reviewed-${index + 1}`,
      headSha: `head-${index + 1}`,
      architect: {
        source: "INVOKED" as const,
        outcome,
        findings:
          outcome === "ACCEPT-WITH-NOTES" ||
          outcome === "FIX-BEFORE-SHIP"
            ? [
                {
                  stableId: `A-${index + 1}`,
                  currentId: `A-${index + 1}`,
                  title: "Finding",
                  class: "INTEGRITY",
                  clearCondition: "Clear it",
                  disposition: "OPEN" as const,
                  reachableTrigger: "A retry consumes invalid state.",
                  introducedByReviewedDiff: true,
                },
              ]
            : [],
        findingsOriginRound: index + 1,
      },
      pm: {
        source: "INVOKED" as const,
        outcome: "SHIP" as const,
        findings: [],
        findingsOriginRound: index + 1,
      },
    }));
    const sanitized = sanitizeReviewPhase({
      architect: { headSha: "bad", verdict: "FIX-BEFORE-SHIP" },
      pm: { headSha: "good", verdict: "ACCEPT-WITH-NOTES" },
      rounds,
    });
    expect(sanitized?.architect).toBeUndefined();
    expect(sanitized?.pm).toEqual({
      headSha: "good",
      verdict: "ACCEPT-WITH-NOTES",
    });
    expect(sanitized?.rounds?.map((round) => round.architect.outcome)).toEqual(
      outcomes,
    );
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

  it("[behavior:B-13] upgrades every earlier version to 4 with the field absent", () => {
    expect(RUN_STATE_VERSION).toBe(4);
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
      expect(adapted.version).toBe(4);
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
    expect(JSON.parse(readFileSync(file, "utf-8")).version).toBe(4);

    const loaded = loadRunState(repo, "demo");
    expect(loaded.version).toBe(4);
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
