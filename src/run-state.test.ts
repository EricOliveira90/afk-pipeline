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
});
