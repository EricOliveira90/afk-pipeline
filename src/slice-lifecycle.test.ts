import { describe, it, expect } from "vitest";
import {
  ALL_PHASES,
  bucketFor,
  lifecycle,
  statusIconFor,
  summaryStatusLabel,
  type SliceIdentity,
  type SliceProgress,
} from "./slice-lifecycle.js";
import { projectForPersistence, adaptLoadedState } from "./run-state.js";

const ID: SliceIdentity = { ghIssue: "1", title: "test", branch: "afk/test" };
const P: SliceProgress = { genRounds: 2, evalRounds: 1 };

describe("SliceLifecycle constructors", () => {
  it("builds each variant with required fields", () => {
    expect(lifecycle.pending(ID).phase).toBe("PENDING");

    const running = lifecycle.running(ID, P);
    if (running.phase !== "RUNNING") throw new Error("expected RUNNING");
    expect(running.progress).toEqual(P);

    const passed = lifecycle.pass(ID, P, true);
    if (passed.phase !== "PASS") throw new Error("expected PASS");
    expect(passed.mergedToFeature).toBe(true);

    const stuck = lifecycle.stuck(ID, P, "boom");
    if (stuck.phase !== "STUCK") throw new Error("expected STUCK");
    expect(stuck.error).toBe("boom");

    expect(lifecycle.escalate(ID, P, "esc").phase).toBe("ESCALATE");
    expect(lifecycle.error(ID, P, "err").phase).toBe("ERROR");
    expect(lifecycle.conflict(ID, P, "merge").phase).toBe("CONFLICT");
    expect(lifecycle.cancelled(ID, P, "abort").phase).toBe("CANCELLED");
    expect(lifecycle.laneCancelled(ID, P, "lane").phase).toBe("LANE-CANCELLED");
    expect(lifecycle.skipped(ID).phase).toBe("SKIPPED");
  });
});

describe("bucketFor", () => {
  it("groups every phase into a bucket exhaustively", () => {
    const buckets = ALL_PHASES.map((p) => bucketFor(p));
    // No "default" bucket should appear; each phase is explicitly mapped.
    for (const b of buckets) {
      expect(["succeeded", "failed", "cancelled", "skipped", "inFlight"]).toContain(
        b,
      );
    }
    expect(bucketFor("PASS")).toBe("succeeded");
    expect(bucketFor("STUCK")).toBe("failed");
    expect(bucketFor("ESCALATE")).toBe("failed");
    expect(bucketFor("ERROR")).toBe("failed");
    expect(bucketFor("CONFLICT")).toBe("failed");
    expect(bucketFor("CANCELLED")).toBe("cancelled");
    expect(bucketFor("LANE-CANCELLED")).toBe("cancelled");
    expect(bucketFor("SKIPPED")).toBe("skipped");
    expect(bucketFor("RUNNING")).toBe("inFlight");
    expect(bucketFor("PENDING")).toBe("inFlight");
  });
});

describe("summaryStatusLabel", () => {
  it("maps ESCALATE and ERROR to STUCK to keep run-summary.md byte-stable", () => {
    expect(summaryStatusLabel("ESCALATE")).toBe("STUCK");
    expect(summaryStatusLabel("ERROR")).toBe("STUCK");
    expect(summaryStatusLabel("STUCK")).toBe("STUCK");
    expect(summaryStatusLabel("PASS")).toBe("PASS");
    expect(summaryStatusLabel("LANE-CANCELLED")).toBe("LANE-CANCELLED");
  });
});

describe("statusIconFor", () => {
  it("returns a non-empty icon for every phase", () => {
    for (const p of ALL_PHASES) {
      expect(statusIconFor(p).length).toBeGreaterThan(0);
    }
  });
});

describe("projectForPersistence + adaptLoadedState round-trip", () => {
  it("returns null for non-terminal phases (not persisted)", () => {
    expect(projectForPersistence(lifecycle.pending(ID))).toBeNull();
    expect(projectForPersistence(lifecycle.running(ID, P))).toBeNull();
  });

  it("preserves PASS with mergedToFeature flag", () => {
    const passed = lifecycle.pass(ID, P, true);
    const persisted = projectForPersistence(passed);
    expect(persisted).toEqual({
      phase: "PASS",
      branch: "afk/test",
      mergedToFeature: true,
    });
  });

  it("preserves ESCALATE distinctly through JSON", () => {
    const esc = lifecycle.escalate(ID, P, "max rounds");
    const persisted = projectForPersistence(esc)!;
    const json = JSON.stringify({
      version: 1,
      prdSlug: "x",
      featureBranch: "feat/x",
      slices: { "1": persisted },
    });
    const round = adaptLoadedState(JSON.parse(json), "x");
    expect(round.slices["1"]!.phase).toBe("ESCALATE");
    expect(round.slices["1"]!.error).toBe("max rounds");
  });

  it("preserves ERROR distinctly through JSON", () => {
    const err = lifecycle.error(ID, P, "boom");
    const persisted = projectForPersistence(err)!;
    const json = JSON.stringify({
      version: 1,
      prdSlug: "x",
      featureBranch: "feat/x",
      slices: { "1": persisted },
    });
    const round = adaptLoadedState(JSON.parse(json), "x");
    expect(round.slices["1"]!.phase).toBe("ERROR");
  });

  it("SKIPPED projects without progress", () => {
    const skipped = lifecycle.skipped({ ghIssue: "9", title: "h", branch: "—" });
    expect(projectForPersistence(skipped)).toEqual({
      phase: "SKIPPED",
      branch: "—",
    });
  });
});
