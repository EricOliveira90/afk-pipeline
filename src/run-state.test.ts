import { describe, it, expect, afterEach } from "vitest";
import {
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
