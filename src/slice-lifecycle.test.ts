import { describe, it, expect } from "vitest";
import {
  ALL_PHASES,
  bucketFor,
  lifecycle,
  traitsFor,
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
    expect(
      lifecycle.awaitingAdjudication(ID, P, "contract impasse").phase,
    ).toBe("AWAITING-ADJUDICATION");
    expect(lifecycle.error(ID, P, "err").phase).toBe("ERROR");
    expect(lifecycle.conflict(ID, P, "merge").phase).toBe("CONFLICT");
    expect(lifecycle.cancelled(ID, P, "abort").phase).toBe("CANCELLED");
    expect(lifecycle.laneCancelled(ID, P, "lane").phase).toBe("LANE-CANCELLED");

    const deferred = lifecycle.mergePending(ID, P, "collision", ["042"]);
    if (deferred.phase !== "MERGE-PENDING") {
      throw new Error("expected MERGE-PENDING");
    }
    expect(deferred.error).toBe("collision");
    expect(deferred.collidingPrefixes).toEqual(["042"]);
    expect(lifecycle.skipped(ID).phase).toBe("SKIPPED");
  });
});

describe("bucketFor", () => {
  it("groups every phase into a bucket exhaustively", () => {
    const buckets = ALL_PHASES.map((p) => bucketFor(p));
    // No "default" bucket should appear; each phase is explicitly mapped.
    for (const b of buckets) {
      expect([
        "succeeded",
        "failed",
        "deferred",
        "cancelled",
        "skipped",
        "inFlight",
      ]).toContain(b);
    }
    expect(bucketFor("PASS")).toBe("succeeded");
    expect(bucketFor("STUCK")).toBe("failed");
    expect(bucketFor("ESCALATE")).toBe("failed");
    expect(bucketFor("AWAITING-ADJUDICATION")).toBe("failed");
    expect(bucketFor("ERROR")).toBe("failed");
    expect(bucketFor("CONFLICT")).toBe("failed");
    // A deferred merge is neither a success nor a failure: the work is
    // intact and the next run finishes it.
    expect(bucketFor("MERGE-PENDING")).toBe("deferred");
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
    expect(summaryStatusLabel("AWAITING-ADJUDICATION")).toBe(
      "AWAITING-ADJUDICATION",
    );
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

describe("phase traits", () => {
  it("defines every phase and keeps MERGE-PENDING recoverable and preserved", () => {
    expect(ALL_PHASES.every((phase) => traitsFor(phase) !== undefined)).toBe(true);
    expect(traitsFor("MERGE-PENDING")).toMatchObject({
      bucket: "deferred",
      persisted: true,
      terminalThisRun: true,
      branchDisposition: "preserved",
      summaryLabel: "MERGE-PENDING",
    });
  });

  /**
   * ADR 0055 Seam 2 §6: cleanup eligibility is a trait, not a bucket. The
   * park renders as a failure (that is what an operator needs to see in
   * the status table) but its estate is a human's pending input, so the
   * two axes must be able to disagree — and here they do.
   */
  it("declares the adjudication park's whole estate off limits to cleanup", () => {
    expect(traitsFor("AWAITING-ADJUDICATION").debris).toBe("preserve-all");
    expect(traitsFor("AWAITING-ADJUDICATION").bucket).toBe("failed");
  });

  it("leaves a refused adjudicated lock presentation-only — its estate is owned on disk", () => {
    // The mechanical lock gate refused a completed adjudication on the
    // current base. It presents like ESCALATE (failed bucket, STUCK label),
    // and — as of the fourth adjudication gate round — its debris trait says
    // so too. The estate it leaves behind is still protected, but by the
    // disk fact `findAdjudicationEstate`, not by this phase: every other
    // post-decision apply exit (planner failure, refresh conflict,
    // cancellation mid-apply, a flattened bookkeeping throw) leaves the same
    // estate under ERROR or CONFLICT, so the phase was a lossy proxy for
    // ownership (ADR 0055 Seam 2 §6).
    expect(traitsFor("ADJUDICATION-LOCK-REFUSED").debris).toBe("disposable");
    expect(traitsFor("ADJUDICATION-LOCK-REFUSED").bucket).toBe("failed");
    expect(traitsFor("ADJUDICATION-LOCK-REFUSED").summaryLabel).toBe("STUCK");
    // Presentation-identical to the phase it reads as, cleanup axis included.
    expect(traitsFor("ADJUDICATION-LOCK-REFUSED").debris).toBe(
      traitsFor("ESCALATE").debris,
    );
  });

  it("keeps the cleanup axis independent of the presentation bucket", () => {
    // The disposition every other failure/cancellation phase carries —
    // clean-failed's whole reason to exist.
    expect(traitsFor("STUCK").debris).toBe("disposable");
    expect(traitsFor("ERROR").debris).toBe("disposable");
    expect(traitsFor("CONFLICT").debris).toBe("disposable");
    expect(traitsFor("CANCELLED").debris).toBe("disposable");
    expect(traitsFor("LANE-CANCELLED").debris).toBe("disposable");
    // The worktree is debris, the branch is the next run's input.
    expect(traitsFor("MERGE-PENDING").debris).toBe("preserve-branch");
    // Nothing failed, so cleanup never considers these at all.
    expect(traitsFor("PASS").debris).toBe("out-of-scope");
    expect(traitsFor("PENDING").debris).toBe("out-of-scope");
    expect(traitsFor("RUNNING").debris).toBe("out-of-scope");
    expect(traitsFor("SKIPPED").debris).toBe("out-of-scope");
  });

  it("keeps the cleanup axis separate from the journal's replaceability axis", () => {
    // `replaceableThisRun` (the journal's axis) and `preserve-all` (cleanup's)
    // are independent: the park is replaceable within the run by a human
    // decision plus a re-dispatch, and it is also the one phase whose own
    // semantics assert a human owes input.
    expect(traitsFor("AWAITING-ADJUDICATION").replaceableThisRun).toBe(true);
    expect(
      traitsFor("ADJUDICATION-LOCK-REFUSED").replaceableThisRun,
    ).toBeUndefined();
    expect(
      ALL_PHASES.filter((phase) => traitsFor(phase).replaceableThisRun),
    ).toEqual(["AWAITING-ADJUDICATION"]);
    // Exactly one phase claims `preserve-all`, and it is a *secondary*
    // signal — the one that still preserves a park whose worktree an
    // operator has already removed, where there is no disk left to read.
    // Estate ownership itself is proved from disk, so no future exit has to
    // remember to add itself to this list (ADR 0055 Seam 2 §6).
    expect(
      ALL_PHASES.filter((phase) => traitsFor(phase).debris === "preserve-all"),
    ).toEqual(["AWAITING-ADJUDICATION"]);
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

  it("round-trips AWAITING-ADJUDICATION with its branch and reason", () => {
    const parked = lifecycle.awaitingAdjudication(
      ID,
      P,
      "contract impasse on F-01",
    );
    const persisted = projectForPersistence(parked)!;
    const round = adaptLoadedState(
      {
        version: 1,
        prdSlug: "x",
        featureBranch: "feat/x",
        slices: { "1": persisted },
      },
      "x",
    );

    expect(round.slices["1"]).toEqual({
      phase: "AWAITING-ADJUDICATION",
      branch: "afk/test",
      error: "contract impasse on F-01",
    });
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

  it("round-trips MERGE-PENDING with its colliding prefixes", () => {
    const deferred = lifecycle.mergePending(
      ID,
      P,
      "Migration prefix collision: 042 …",
      ["042", "043"],
    );
    const persisted = projectForPersistence(deferred)!;
    const json = JSON.stringify({
      version: 1,
      prdSlug: "x",
      featureBranch: "feat/x",
      slices: { "1": persisted },
    });
    const round = adaptLoadedState(JSON.parse(json), "x");
    expect(round.slices["1"]!.phase).toBe("MERGE-PENDING");
    expect(round.slices["1"]!.branch).toBe("afk/test");
    expect(round.slices["1"]!.error).toContain("042");
    expect(round.slices["1"]!.collidingPrefixes).toEqual(["042", "043"]);
  });

  it("SKIPPED projects without progress", () => {
    const skipped = lifecycle.skipped({ ghIssue: "9", title: "h", branch: "—" });
    expect(projectForPersistence(skipped)).toEqual({
      phase: "SKIPPED",
      branch: "—",
    });
  });
});
