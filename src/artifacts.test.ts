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
  classifyReviewFailure,
  hasStuckFile,
  isFavorableReviewOutcome,
  isReviewInfrastructureFailure,
  lockContract,
  reopenContract,
  readContractFiles,
  readContractStatus,
  preserveNegotiationFailure,
  readReviewVerdict,
} from "./artifacts.js";

/**
 * Regression tests for the review-verdict parser.
 *
 * All three wire formats below were observed in real AFK runs under
 * `.afk/logs/<prd>/slice-all-{architect,pm}-review.log` where the summary
 * ended up as "UNKNOWN" because the original regex only accepted a single
 * markdown emphasis style.
 */

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "afk-artifacts-"));
  const path = join(dir, "review.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("preserveNegotiationFailure", () => {
  function makeFailureFixture() {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-preserve-"));
    const sliceDir = join(repoRoot, ".afk", "worktrees", "slice", "spec", "slices", "01-demo");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "contract.md"), "# Contract\n\n**Status:** NEGOTIATING\n", "utf-8");
    writeFileSync(join(sliceDir, "context.md"), "# Context\n", "utf-8");
    writeFileSync(join(sliceDir, "feedback-r1.md"), "VERDICT: REVISE\n", "utf-8");
    writeFileSync(
      join(sliceDir, "feedback-r2.md"),
      "VERDICT: REVISE\n\n### If REVISE, specific gaps:\n- Add an issue-body acceptance clause.\n",
      "utf-8",
    );
    return { repoRoot, sliceDir };
  }

  it("writes actionable ESCALATE details and archives every negotiation artifact", () => {
    const { repoRoot, sliceDir } = makeFailureFixture();
    try {
      const result = preserveNegotiationFailure({
        repoRoot,
        runSlug: "demo-stub",
        sliceDir,
        sliceNumber: "01",
        ghIssue: "7001",
        title: "Notification foundation",
        round: 2,
        outcome: "ESCALATE",
        verdict: "REVISE",
        feedbackPath: join(sliceDir, "feedback-r2.md"),
        contractPath: join(sliceDir, "contract.md"),
        contextPath: join(sliceDir, "context.md"),
        capDecision: "Round cap reached; extension refused because gaps were flat.",
      });

      expect(result.archived).toBe(true);
      expect(hasStuckFile(sliceDir)).toBe(true);
      const stuck = readFileSync(join(sliceDir, "stuck.md"), "utf-8");
      expect(stuck).toContain("#7001 Notification foundation");
      expect(stuck).toContain("Final verdict: VERDICT: REVISE");
      expect(stuck).toContain("Add an issue-body acceptance clause.");
      expect(stuck).toContain(".afk/artifacts/demo-stub/slice-01/contract.md");

      rmSync(sliceDir, { recursive: true, force: true });
      for (const name of [
        "contract.md",
        "context.md",
        "feedback-r1.md",
        "feedback-r2.md",
        "stuck.md",
      ]) {
        expect(existsSync(join(result.archiveDir, name))).toBe(true);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes STUCK details and warns without throwing when archiving fails", () => {
    const { repoRoot, sliceDir } = makeFailureFixture();
    const warnings: string[] = [];
    try {
      const blockedRunDir = join(repoRoot, ".afk", "artifacts", "blocked-run");
      mkdirSync(join(repoRoot, ".afk", "artifacts"), { recursive: true });
      writeFileSync(blockedRunDir, "not a directory", "utf-8");

      const result = preserveNegotiationFailure(
        {
          repoRoot,
          runSlug: "blocked-run",
          sliceDir,
          sliceNumber: "01",
          ghIssue: "7001",
          title: "Notification foundation",
          round: 2,
          outcome: "STUCK",
          verdict: "NONE",
          feedbackPath: join(sliceDir, "feedback-r2.md"),
          contractPath: join(sliceDir, "contract.md"),
          contextPath: join(sliceDir, "context.md"),
        },
        (message) => warnings.push(message),
      );

      expect(result.archived).toBe(false);
      expect(hasStuckFile(sliceDir)).toBe(true);
      expect(readFileSync(join(sliceDir, "stuck.md"), "utf-8")).toContain(
        "Outcome: STUCK",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("failed to archive negotiation artifacts");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("readReviewVerdict", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  describe("real-world formats observed in AFK runs", () => {
    it("parses bold format: **Verdict:** SHIP (bug-fixes-round-2 architect)", () => {
      withTempFile(
        `# Architect Review\n\n**Date:** 2026-05-05\n**Verdict:** SHIP\n\nAll good.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses markdown header: ## Verdict: SHIP (architecture-deepening both, bug-fixes-round-2 PM)", () => {
      withTempFile(
        `# PM Review\n\nSome prose.\n\n## Verdict: SHIP\n\nBoth slices are minimal bug fixes.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("returns UNPARSEABLE when no Verdict line is present (bug-fixes-tiers-1-3 both)", () => {
      withTempFile(
        `# Architect Review\n\nCritical finding: slice 01 has 5 of 8 requirements completely unimplemented.\n\nThe two blockers must be fixed before the client demo.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });
  });

  describe("accepted format variations", () => {
    it("parses ACCEPT-WITH-NOTES under bold format", () => {
      withTempFile(`**Verdict:** ACCEPT-WITH-NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses ACCEPT WITH NOTES (spaces) under header format", () => {
      withTempFile(`## Verdict: ACCEPT WITH NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses FIX-BEFORE-SHIP under header format", () => {
      withTempFile(`### Verdict: FIX-BEFORE-SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses FIX BEFORE SHIP (spaces) under bold format", () => {
      withTempFile(`**Verdict:** FIX BEFORE SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses plain format: Verdict: SHIP", () => {
      withTempFile(`Verdict: SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses single-asterisk italic: *Verdict:* SHIP", () => {
      withTempFile(`*Verdict:* SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("is case-insensitive on the 'Verdict' key", () => {
      withTempFile(`**verdict:** ship\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("tolerates trailing whitespace after the value", () => {
      withTempFile(`**Verdict:** SHIP   \n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("strips trailing bold markers on the value itself", () => {
      withTempFile(`**Verdict: SHIP**\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });
  });

  describe("negative cases", () => {
    it("returns UNPARSEABLE when the file does not exist", () => {
      expect(readReviewVerdict("/nonexistent/path/review.md")).toBe("UNPARSEABLE");
    });

    it("returns UNPARSEABLE when the verdict value is unrecognized", () => {
      withTempFile(`**Verdict:** MAYBE\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });

    it("returns UNPARSEABLE for a file with only prose", () => {
      withTempFile(`# Review\n\nLooks fine to me.\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNPARSEABLE"),
      );
    });
  });
});

/**
 * Tests for `readContractFiles`, the planner's declared "Files expected
 * to change" extractor used by the lane partitioner.
 *
 * Section semantics: undefined when the file or section is missing;
 * empty array when the section exists but yielded no usable paths.
 */
function withContractFile(
  content: string,
  fn: (path: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "afk-contract-"));
  const path = join(dir, "contract.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readContractFiles", () => {
  it("returns undefined when the contract file is missing", () => {
    expect(readContractFiles("/nonexistent/path/contract.md")).toBeUndefined();
  });

  it("returns undefined when the section heading is absent", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nDo a thing.\n`,
      (p) => expect(readContractFiles(p)).toBeUndefined(),
    );
  });

  it("returns [] when the section exists but is empty", () => {
    withContractFile(
      `# Slice Contract\n\n## Files expected to change\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <rough list> placeholder", () => {
    withContractFile(
      `## Files expected to change\n- <rough list>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <unknown> opt-out", () => {
    withContractFile(
      `## Files expected to change\n- <unknown>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("strips trailing prose annotation: '- src/cli.py (rename) ' → 'src/cli.py'", () => {
    withContractFile(
      `## Files expected to change\n- src/cli.py (rename to support recipe group)\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py"]),
    );
  });

  it("unwraps a backticked path: '- `src/lanes.ts`' → 'src/lanes.ts'", () => {
    withContractFile(
      "## Files expected to change\n- `src/lanes.ts` (new)\n",
      (p) => expect(readContractFiles(p)).toEqual(["src/lanes.ts"]),
    );
  });

  it("collects multiple bullets and stops at the next heading", () => {
    withContractFile(
      `## Files expected to change
- src/cli.py
- src/lanes.ts
- \`src/orchestrator.ts\` (touch wave loop)

## New patterns
- src/should-not-appear.ts
`,
      (p) =>
        expect(readContractFiles(p)).toEqual([
          "src/cli.py",
          "src/lanes.ts",
          "src/orchestrator.ts",
        ]),
    );
  });

  it("supports asterisk bullets as well as dashes", () => {
    withContractFile(
      `## Files expected to change\n* src/cli.py\n* src/lanes.ts\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py", "src/lanes.ts"]),
    );
  });
});

describe("readContractStatus", () => {
  it("returns LOCKED when the Status field is literally LOCKED", () => {
    withContractFile(
      `# Slice Contract\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("LOCKED"),
    );
  });

  it("returns NEGOTIATING when Status is NEGOTIATING — even if evaluator wrote ACCEPT", () => {
    withContractFile(
      [
        `# Slice Contract`,
        ``,
        `**Status:** NEGOTIATING`,
        ``,
        `## Scope lock`,
        `Foo.`,
        ``,
        `## Evaluator feedback — round 1`,
        ``,
        `VERDICT: ACCEPT`,
      ].join("\n"),
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns NEGOTIATING when Status is missing entirely", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nFoo.\n`,
      (p) => expect(readContractStatus(p)).toBe("NEGOTIATING"),
    );
  });

  it("returns UNKNOWN when the file is missing", () => {
    expect(readContractStatus("/nonexistent/path/contract.md")).toBe("UNKNOWN");
  });
});

describe("lockContract", () => {
  it("flips **Status:** NEGOTIATING to LOCKED in place", () => {
    withContractFile(
      `# Slice\n\n**Status:** NEGOTIATING\n**Negotiation round:** 1\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        expect(readContractStatus(p)).toBe("LOCKED");
        const content = readFileSync(p, "utf-8");
        expect(content).toContain("**Status:** LOCKED");
        expect(content).not.toContain("**Status:** NEGOTIATING");
        // Other fields preserved.
        expect(content).toContain("**Negotiation round:** 1");
        expect(content).toContain("## Scope lock");
      },
    );
  });

  it("is idempotent when Status is already LOCKED", () => {
    withContractFile(
      `# Slice\n\n**Status:** LOCKED\n\n## Scope lock\nFoo.\n`,
      (p) => {
        lockContract(p);
        const content = readFileSync(p, "utf-8");
        expect(content.match(/\*\*Status:\*\*/g)?.length).toBe(1);
      },
    );
  });

  it("inserts the Status field if absent (defensive — should never happen in prod)", () => {
    withContractFile(`# Slice Contract\n\n## Scope lock\nFoo.\n`, (p) => {
      lockContract(p);
      expect(readContractStatus(p)).toBe("LOCKED");
    });
  });
});

/**
 * Taking a lock back (ADR 0028). When the contract-lock gate refuses a
 * contract the orchestrator has already locked, the file must stop
 * claiming LOCKED — the generator's own invariant reads that field, so a
 * stale LOCKED would let a contract the pipeline rejected reach
 * generation.
 */
describe("reopenContract", () => {
  it("flips **Status:** LOCKED back to NEGOTIATING in place", () => {
    withContractFile(
      `# Slice\n\n**Status:** LOCKED\n\n## Files expected to change\n- supabase/migrations/003_a.sql\n`,
      (p) => {
        reopenContract(p);
        expect(readContractStatus(p)).toBe("NEGOTIATING");
        const content = readFileSync(p, "utf-8");
        expect(content).not.toContain("**Status:** LOCKED");
        // The rest of the contract survives for the planner to revise.
        expect(content).toContain("supabase/migrations/003_a.sql");
      },
    );
  });

  it("round-trips with lockContract", () => {
    withContractFile(`# Slice\n\n**Status:** NEGOTIATING\n`, (p) => {
      lockContract(p);
      reopenContract(p);
      lockContract(p);
      expect(readContractStatus(p)).toBe("LOCKED");
      expect(
        readFileSync(p, "utf-8").match(/\*\*Status:\*\*/g)?.length,
      ).toBe(1);
    });
  });

  it("is idempotent when Status is already NEGOTIATING", () => {
    withContractFile(`# Slice\n\n**Status:** NEGOTIATING\n`, (p) => {
      reopenContract(p);
      expect(readContractStatus(p)).toBe("NEGOTIATING");
      expect(
        readFileSync(p, "utf-8").match(/\*\*Status:\*\*/g)?.length,
      ).toBe(1);
    });
  });
});


/**
 * ADR 0015 review failure classes. The classifier turns a rejected
 * guardian invocation into NEVER_RAN (died at spawn, before any parsed
 * output) or DIED_MID_RUN (killed after real activity) — both
 * infrastructure-class and retried, unlike terminal UNPARSEABLE.
 */
describe("classifyReviewFailure", () => {
  it("classifies a spawn-style wrapper failure with no output as NEVER_RAN", () => {
    // Verbatim failure shape from the PRD 070 run (attempt 8).
    const error = new Error(
      "Agent pm-review exited with code 1: codex-wrapper: error: failed to persist AWS config file: failed to persist temporary file: Access is denied. (os error 5)",
    );
    expect(classifyReviewFailure(error, false)).toBe("NEVER_RAN");
  });

  it("classifies a nonzero exit after real stream activity as DIED_MID_RUN", () => {
    const error = new Error("Agent pm-review exited with code 1: boom");
    expect(classifyReviewFailure(error, true)).toBe("DIED_MID_RUN");
  });

  it("classifies an idle-watcher kill as DIED_MID_RUN even without observed output", () => {
    // codex uses "- killed", claude/kiro use "— killed"; both must match.
    expect(
      classifyReviewFailure(new Error("Agent pm-review idle for 600s - killed"), false),
    ).toBe("DIED_MID_RUN");
    expect(
      classifyReviewFailure(new Error("Agent pm-review idle for 600s — killed"), false),
    ).toBe("DIED_MID_RUN");
  });

  it("classifies a tool-cap kill as DIED_MID_RUN", () => {
    expect(
      classifyReviewFailure(
        new Error("Agent architect-review exceeded 100 tool calls - killed"),
        false,
      ),
    ).toBe("DIED_MID_RUN");
  });

  it("classifies non-Error rejections without output as NEVER_RAN", () => {
    expect(classifyReviewFailure("ENOENT", false)).toBe("NEVER_RAN");
  });
});

describe("review outcome predicates", () => {
  it("treats only SHIP and ACCEPT-WITH-NOTES as favorable", () => {
    expect(isFavorableReviewOutcome("SHIP")).toBe(true);
    expect(isFavorableReviewOutcome("ACCEPT-WITH-NOTES")).toBe(true);
    expect(isFavorableReviewOutcome("FIX-BEFORE-SHIP")).toBe(false);
    expect(isFavorableReviewOutcome("UNPARSEABLE")).toBe(false);
    expect(isFavorableReviewOutcome("NEVER_RAN")).toBe(false);
    expect(isFavorableReviewOutcome("DIED_MID_RUN")).toBe(false);
  });

  it("treats only NEVER_RAN and DIED_MID_RUN as infrastructure failures", () => {
    expect(isReviewInfrastructureFailure("NEVER_RAN")).toBe(true);
    expect(isReviewInfrastructureFailure("DIED_MID_RUN")).toBe(true);
    expect(isReviewInfrastructureFailure("UNPARSEABLE")).toBe(false);
    expect(isReviewInfrastructureFailure("FIX-BEFORE-SHIP")).toBe(false);
    expect(isReviewInfrastructureFailure("SHIP")).toBe(false);
  });
});
