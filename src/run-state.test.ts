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
  saveReviewPhase,
  sanitizeReviewPhase,
  isSliceComplete,
  adaptLoadedState,
  getResumeAttempts,
  recordRetryDecision,
  clearSliceStateForDispatch,
} from "./run-state.js";

const tempDirs: string[] = [];

afterEach(() => {
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
    expect(adapted.version).toBe(1);
    expect(adapted.slices["100"]!.phase).toBe("PASS");
    expect(adapted.slices["100"]!.mergedToFeature).toBe(true);
    expect(adapted.slices["200"]!.phase).toBe("STUCK");
    expect(adapted.slices["300"]!.phase).toBe("ESCALATE");
  });

  it("passes v1 files through unchanged", () => {
    const v1 = {
      version: 1,
      prdSlug: "demo",
      featureBranch: "feat/demo",
      slices: {
        "100": { phase: "PASS", branch: "afk/demo", mergedToFeature: true },
      },
    };
    const adapted = adaptLoadedState(v1, "demo");
    expect(adapted.version).toBe(1);
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
    expect(loaded.version).toBe(1);
    expect(loaded.slices["100"]!.phase).toBe("PASS");
    expect(isSliceComplete(loaded, "100")).toBe(true);
    expect(isSliceComplete(loaded, "200")).toBe(false);

    saveSliceState(repo, slug, "300", {
      phase: "ERROR",
      branch: "afk/demo-3",
      error: "boom",
    });

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(1);
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

  it("returns a fresh v1 state when no file exists", () => {
    const repo = makeRepo();
    const loaded = loadRunState(repo, "fresh");
    expect(loaded).toEqual({
      version: 1,
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
});


/** ADR 0015: cheap re-entry cache for the post-merge review phase. */
describe("review-phase persistence", () => {
  it("round-trips reviewPhase through saveReviewPhase and loadRunState", () => {
    const repo = makeRepo();
    saveSliceState(repo, "demo", "70", {
      phase: "PASS",
      branch: "afk/demo-slice-01",
      mergedToFeature: true,
    });
    saveReviewPhase(repo, "demo", {
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
    });

    const loaded = loadRunState(repo, "demo");
    // Slice state written earlier is preserved (atomic re-read pattern).
    expect(isSliceComplete(loaded, "70")).toBe(true);
    expect(loaded.reviewPhase).toEqual({
      sanity: { treeSha: "t".repeat(40), ok: true },
      architect: { headSha: "h".repeat(40), verdict: "SHIP" },
    });

    // Clearing removes the key entirely.
    saveReviewPhase(repo, "demo", undefined);
    expect(loadRunState(repo, "demo").reviewPhase).toBeUndefined();
  });

  it("saveSliceState preserves an existing reviewPhase", () => {
    const repo = makeRepo();
    saveReviewPhase(repo, "demo", {
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
    });
    saveSliceState(repo, "demo", "71", {
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(loadRunState(repo, "demo").reviewPhase).toEqual({
      pm: { headSha: "abc123", verdict: "ACCEPT-WITH-NOTES" },
    });
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
        version: 1,
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

  it("leaves resume bookkeeping, scope, and migration claims alone", () => {
    const repo = makeRepo();
    staleStateFile(repo);

    clearSliceStateForDispatch(repo, "demo", "75");

    const state = loadRunState(repo, "demo");
    // The resume cap is the poison-tree guard and the dispatch this
    // clearing accompanies is about to increment it (#36).
    expect(getResumeAttempts(state, "75")).toBe(1);
    expect(state.resume?.["75"]?.lastDecision).toBe("resumed from 3 commits");
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
