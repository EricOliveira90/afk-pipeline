import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunEventPayload } from "./run-events.js";
import { lifecycle } from "./slice-lifecycle.js";
import {
  buildFutureSection,
  renderFutureSection,
  type FutureSection,
} from "./status-future.js";

/**
 * Filesystem-contract tests for the `afk status` future section
 * (spec #30): fixture directories in — a fake repoRoot with
 * `.kiro/specs/<prd-slug>/issues.md`, optional `.afk/state/<runSlug>.json`,
 * and a run directory — derived model / rendered lines out. No mocking
 * of internals: the section goes through the real issues parser and
 * run-state loader.
 */

const PRD_SLUG = "demo";
const RUN_SLUG = "demo-stub";
const PROVIDER = "stub";

const ISSUES_MD = `# Issues

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #100 | Foundation | AFK | — | 1 |
| 02 | #101 | Widget on foundation | AFK | #100 | 2 |
| 03 | #102 | Mobile gestures on widget | AFK | #101 | 3 |
| 04 | #103 | Cron on foundation | AFK | #100 | 4 |
| 05 | #200 | Manual setup | HITL | — | 5 |
`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  issuesMd?: string | null;
  /** Written verbatim as `.afk/state/<runSlug>.json` when provided. */
  stateJson?: unknown;
}

function makeRepo(opts: FixtureOptions = {}): { repoRoot: string; runDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "afk-status-future-"));
  tempDirs.push(repoRoot);

  const issuesMd = opts.issuesMd === undefined ? ISSUES_MD : opts.issuesMd;
  if (issuesMd !== null) {
    const specDir = join(repoRoot, ".kiro", "specs", PRD_SLUG);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "issues.md"), issuesMd, "utf-8");
  }

  if (opts.stateJson !== undefined) {
    const stateDir = join(repoRoot, ".afk", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${RUN_SLUG}.json`),
      JSON.stringify(opts.stateJson, null, 2),
      "utf-8",
    );
  }

  const runDir = join(repoRoot, ".afk", "logs", PRD_SLUG, "run-20250101-000000");
  mkdirSync(runDir, { recursive: true });
  return { repoRoot, runDir };
}

let clockSeq = 0;
function ev(payload: RunEventPayload): RunEvent {
  clockSeq++;
  const ts = `2025-01-01T00:${String(Math.floor(clockSeq / 60)).padStart(2, "0")}:${String(clockSeq % 60).padStart(2, "0")}.000Z`;
  return { ...payload, ts } as RunEvent;
}

function baseEvents(): RunEvent[] {
  return [
    ev({ type: "header", version: 1 }),
    ev({ type: "run-started", provider: PROVIDER, runSlug: RUN_SLUG }),
  ];
}

function phasePair(ghIssue: string, agent: string, round?: number): RunEvent[] {
  return [
    ev({ type: "phase-started", ghIssue, agent, ...(round !== undefined ? { round } : {}) }),
    ev({ type: "phase-ended", ghIssue, agent, ...(round !== undefined ? { round } : {}) }),
  ];
}

function pendingFor(future: FutureSection, ghIssue: string) {
  const entry = future.pending.find((p) => p.ghIssue === ghIssue);
  expect(entry, `expected pending entry for #${ghIssue}`).toBeDefined();
  return entry!;
}

describe("buildFutureSection — partially complete run", () => {
  function build(): FutureSection {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ev({ type: "wave-dispatched", wave: 1, slices: ["100"] }),
      ...phasePair("100", "explorer"),
      ...phasePair("100", "planner", 1),
      ...phasePair("100", "evaluator-contract", 1),
      // generator started but not ended — mid-invocation.
      ev({ type: "phase-started", ghIssue: "100", agent: "generator", round: 1 }),
    ];
    return buildFutureSection({ repoRoot, runDir, events });
  }

  it("lists exactly the remaining phases for a mid-pipeline slice", () => {
    const future = build();
    expect(pendingFor(future, "100").remainingPhases).toEqual([
      "generator",
      "evaluator-qa",
    ]);
  });

  it("a slice with no events has the whole sequence ahead", () => {
    const future = build();
    expect(pendingFor(future, "101").remainingPhases).toEqual([
      "explorer",
      "planner",
      "evaluator-contract",
      "generator",
      "evaluator-qa",
    ]);
  });

  it("unresolved dependencies surface as waitsOn blocker references", () => {
    const future = build();
    expect(pendingFor(future, "101").waitsOn.map((b) => b.ghIssue)).toEqual(["100"]);
    expect(pendingFor(future, "102").waitsOn.map((b) => b.ghIssue)).toEqual(["101"]);
    expect(pendingFor(future, "100").waitsOn).toEqual([]);
  });

  it("projects upcoming waves in DAG order, continuing the wave count", () => {
    const future = build();
    // Wave 1 is in flight (#100); #101/#103 unblock next; #102 after #101.
    expect(future.upcomingWaves).toEqual([
      { wave: 1, slices: ["100"] },
      { wave: 2, slices: ["101", "103"] },
      { wave: 3, slices: ["102"] },
    ]);
  });

  it("shows HITL slices as skipped, not pending work", () => {
    const future = build();
    expect(future.skipped.map((s) => s.ghIssue)).toEqual(["200"]);
    expect(future.pending.map((p) => p.ghIssue)).not.toContain("200");
    for (const wave of future.upcomingWaves) {
      expect(wave.slices).not.toContain("200");
    }
  });

  it("carries slice titles from issues.md", () => {
    const future = build();
    expect(pendingFor(future, "101").title).toBe("Widget on foundation");
  });
});

describe("buildFutureSection — completed slices drop out", () => {
  it("a slice with a terminal PASS slice-outcome event is not pending", () => {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ev({ type: "wave-dispatched", wave: 1, slices: ["100"] }),
      ...phasePair("100", "explorer"),
      ev({
        type: "slice-outcome",
        slice: lifecycle.pass(
          { ghIssue: "100", title: "Foundation", branch: "afk/demo/slice-01-stub" },
          { genRounds: 1, evalRounds: 1 },
          true,
        ),
      }),
    ];
    const future = buildFutureSection({ repoRoot, runDir, events });
    expect(future.pending.map((p) => p.ghIssue)).not.toContain("100");
    // #101 and #103 are unblocked by the pass.
    expect(pendingFor(future, "101").waitsOn).toEqual([]);
    expect(future.upcomingWaves).toEqual([
      { wave: 2, slices: ["101", "103"] },
      { wave: 3, slices: ["102"] },
    ]);
  });

  it("persisted PASS + mergedToFeature counts as done even without events", () => {
    const { repoRoot, runDir } = makeRepo({
      stateJson: {
        version: 1,
        prdSlug: RUN_SLUG,
        featureBranch: `feat/${PRD_SLUG}`,
        slices: {
          "100": { phase: "PASS", mergedToFeature: true },
        },
      },
    });
    const events = baseEvents();
    const future = buildFutureSection({ repoRoot, runDir, events });
    expect(future.pending.map((p) => p.ghIssue)).not.toContain("100");
    expect(pendingFor(future, "101").waitsOn).toEqual([]);
    expect(future.upcomingWaves).toEqual([
      { wave: 1, slices: ["101", "103"] },
      { wave: 2, slices: ["102"] },
    ]);
  });
});

describe("buildFutureSection — dependency-held slices", () => {
  it("a slice blocked by a failed slice shows the blocker with its phase", () => {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ev({ type: "wave-dispatched", wave: 1, slices: ["100"] }),
      ev({
        type: "slice-outcome",
        slice: lifecycle.stuck(
          { ghIssue: "100", title: "Foundation", branch: "afk/demo/slice-01-stub" },
          { genRounds: 3, evalRounds: 3 },
          "generator rounds exhausted",
        ),
      }),
    ];
    const future = buildFutureSection({ repoRoot, runDir, events });
    // The failed slice is terminal — not pending work.
    expect(future.pending.map((p) => p.ghIssue)).not.toContain("100");
    // Its dependents wait on it and never enter a projected wave.
    const held = pendingFor(future, "101");
    expect(held.waitsOn).toEqual([{ ghIssue: "100", status: "STUCK" }]);
    for (const wave of future.upcomingWaves) {
      expect(wave.slices).not.toContain("101");
      expect(wave.slices).not.toContain("102");
      expect(wave.slices).not.toContain("103");
    }
  });
});

describe("buildFutureSection — missing issues.md degradation", () => {
  it("degrades to events-only derivation with a note instead of throwing", () => {
    const { repoRoot, runDir } = makeRepo({ issuesMd: null });
    const events = [
      ...baseEvents(),
      ev({ type: "wave-dispatched", wave: 1, slices: ["100"] }),
      ...phasePair("100", "explorer"),
    ];
    const future = buildFutureSection({ repoRoot, runDir, events });
    expect(future.notes.some((n) => n.includes("issues.md"))).toBe(true);
    // Remaining phases still derivable from events alone.
    expect(pendingFor(future, "100").remainingPhases).toEqual([
      "planner",
      "evaluator-contract",
      "generator",
      "evaluator-qa",
    ]);
    // No DAG — no wave projection.
    expect(future.upcomingWaves).toEqual([]);
  });
});

describe("renderFutureSection", () => {
  function buildPartial(): FutureSection {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ev({ type: "wave-dispatched", wave: 1, slices: ["100"] }),
      ...phasePair("100", "explorer"),
      ...phasePair("100", "planner", 1),
      ...phasePair("100", "evaluator-contract", 1),
    ];
    return buildFutureSection({ repoRoot, runDir, events });
  }

  it("emits two-space-indented lines with no trailing newline", () => {
    const lines = renderFutureSection(buildPartial());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^  /);
      expect(line.endsWith("\n")).toBe(false);
    }
  });

  it("renders remaining phases per pending slice", () => {
    const lines = renderFutureSection(buildPartial());
    const sliceLine = lines.find((l) => l.includes("#100"));
    expect(sliceLine).toBeDefined();
    expect(sliceLine).toContain("Foundation");
    expect(sliceLine).toContain("generator");
    expect(sliceLine).toContain("evaluator-qa");
    expect(sliceLine).not.toContain("explorer");
  });

  it("renders wave composition so the operator can read what unblocks what", () => {
    const lines = renderFutureSection(buildPartial()).join("\n");
    expect(lines).toContain("wave 1");
    expect(lines).toContain("wave 2");
    expect(lines).toContain("wave 3");
    expect(lines).toContain("waits on #100");
  });

  it("renders the blocking reference for dependency-held slices", () => {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ev({
        type: "slice-outcome",
        slice: lifecycle.stuck(
          { ghIssue: "100", title: "Foundation", branch: "b" },
          { genRounds: 3, evalRounds: 3 },
          "generator rounds exhausted",
        ),
      }),
    ];
    const future = buildFutureSection({ repoRoot, runDir, events });
    const rendered = renderFutureSection(future).join("\n");
    expect(rendered).toContain("waits on #100 (STUCK)");
  });

  it("renders HITL slices as skipped", () => {
    const rendered = renderFutureSection(buildPartial()).join("\n");
    expect(rendered).toContain("#200");
    expect(rendered).toMatch(/HITL/);
  });

  it("renders degradation notes when issues.md is missing", () => {
    const { repoRoot, runDir } = makeRepo({ issuesMd: null });
    const future = buildFutureSection({
      repoRoot,
      runDir,
      events: baseEvents(),
    });
    const rendered = renderFutureSection(future).join("\n");
    expect(rendered).toContain("issues.md");
  });

  it("says so when nothing is ahead", () => {
    const { repoRoot, runDir } = makeRepo();
    const events = [
      ...baseEvents(),
      ...["100", "101", "102", "103"].map((ghIssue) =>
        ev({
          type: "slice-outcome",
          slice: lifecycle.pass(
            { ghIssue, title: `Slice ${ghIssue}`, branch: "b" },
            { genRounds: 1, evalRounds: 1 },
            true,
          ),
        }),
      ),
    ];
    const future = buildFutureSection({ repoRoot, runDir, events });
    expect(future.pending).toEqual([]);
    const lines = renderFutureSection(future);
    expect(lines.some((l) => l.includes("nothing"))).toBe(true);
  });

  it("model is JSON-serializable round-trip", () => {
    const future = buildPartial();
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
  });
});
